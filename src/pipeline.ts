import { App, Notice } from "obsidian";
import {
	biweeklyKey,
	biweeklyPairOf,
	isoWeekSunday,
	monthEnd,
	monthOfIsoWeek,
	monthlyKey,
	todayUtc,
	weeklyKey,
	weeksInBiweeklyPair,
	weeksInMonth,
	yearlyKey,
} from "./journal/dates";
import { DailyEntry, discoverDailyEntries, loadEntryText } from "./journal/discovery";
import {
	readSummary,
	summaryExists,
	summaryFilename,
	summaryPath,
	writeSummary,
} from "./journal/output";
import { ProcessedDb, markProcessed, needsRun } from "./journal/tracking";
import { LLMProvider, TruncatedGenerationError, createProvider } from "./llm/provider";
import { MemoryStore } from "./memory/store";
import {
	classifyEntries,
	countPendingClassification,
	formatMoodContext,
} from "./mood/classify";
import { MoodStore } from "./mood/store";
import { RunProgress, SILENT_PROGRESS } from "./ui/progress";
import {
	buildMemoryManagerMessages,
	buildSynthesisMessages,
	parseMemoryManagerResponse,
} from "./prompts";
import { Cadence, JournalPluginSettings } from "./settings";

export interface PlannedRun {
	cadence: Cadence;
	key: string;
	year: number;
	/** Tracking inputs: daily basenames (weekly) or weekly summary filenames (rollups). */
	inputs: string[];
	/** Resolved at execution time. */
	dailies?: DailyEntry[];
	sourceKeys?: string[];
}

export interface RunReport {
	written: PlannedRun[];
	skipped: Array<{ run: PlannedRun; reason: string }>;
	failed: Array<{ run: PlannedRun; error: string }>;
	cancelled: boolean;
}

/** Synthesis call + memory-manager call, per run. */
const UNITS_PER_RUN = 2;

/**
 * Total units of work, so the progress bar is proportional rather than
 * jumping. Counts every LLM call the run will make: one per entry needing
 * mood classification, plus synthesis and memory-manager calls per summary.
 */
export async function estimateWork(
	app: App,
	settings: JournalPluginSettings,
	mood: MoodStore,
	runs: PlannedRun[]
): Promise<number> {
	let units = runs.length * UNITS_PER_RUN;
	if (settings.enableMoodClassification) {
		for (const run of runs) {
			if (run.cadence === "weekly" && run.dailies) {
				units += await countPendingClassification(app, mood, run.dailies);
			}
		}
	}
	return units;
}

/**
 * Work out everything that needs generating.
 *
 * Weekly analyses raw daily notes. Biweekly and monthly are *rollups of weekly
 * summaries* — they never re-read the raw dailies. That keeps each higher tier
 * reasoning over already-distilled material and avoids paying for the same
 * daily text twice. A rollup only becomes eligible once every weekly summary it
 * depends on exists on disk; partial rollups are never generated.
 */
export async function planRuns(
	app: App,
	settings: JournalPluginSettings,
	db: ProcessedDb
): Promise<PlannedRun[]> {
	const runs: PlannedRun[] = [];
	const grouped = discoverDailyEntries(app, settings);

	// --- weekly ---
	if (settings.enableWeekly) {
		for (const [key, entries] of grouped) {
			const inputs = entries.map((e) => e.file.name).sort();
			if (!needsRun(db, "weekly", key, inputs)) continue;
			runs.push({ cadence: "weekly", key, year: entries[0].year, inputs, dailies: entries });
		}
	}

	// Candidate periods for the rollup tiers. Weeks come from both the dailies
	// we can see and the weekly summaries already on disk — the latter matters
	// once old dailies have been archived out of the source folder.
	const knownWeeks =
		settings.enableBiweekly || settings.enableMonthly || settings.enableYearly
			? mergeWeeks(
					[...grouped.values()].map((entries) => ({
						year: entries[0].year,
						week: entries[0].week,
					})),
					await existingWeeklySummaryWeeks(app, settings)
			  )
			: [];
	const knownWeekIds = new Set(knownWeeks.map((w) => `${w.year}:${w.week}`));

	// --- biweekly ---
	if (settings.enableBiweekly) {
		const pairs = new Set(knownWeeks.map((w) => `${w.year}:${biweeklyPairOf(w.week)}`));
		for (const id of pairs) {
			const [yearStr, pairStr] = id.split(":");
			const year = Number(yearStr);
			const pair = Number(pairStr);
			const key = biweeklyKey(year, pair);
			const weeks = weeksInBiweeklyPair(year, pair);
			const resolved = await resolveWeeklyInputs(
				app,
				settings,
				weeks.map((w) => ({ year, week: w })),
				knownWeekIds
			);
			if (!resolved) continue; // a required weekly summary is missing — retry next run
			if (!needsRun(db, "biweekly", key, resolved.inputs)) continue;
			runs.push({ cadence: "biweekly", key, year, ...resolved });
		}
	}

	// Months implied by the known weeks — feeds both the monthly tier's
	// candidates and, merged with monthly summaries already on disk, the
	// yearly tier's.
	const monthsFromWeeks =
		settings.enableMonthly || settings.enableYearly
			? mergeMonths(
					knownWeeks.map((w) => monthOfIsoWeek(w.year, w.week))
			  )
			: [];

	// --- monthly ---
	if (settings.enableMonthly) {
		for (const { year, month } of monthsFromWeeks) {
			const key = monthlyKey(year, month);
			const resolved = await resolveWeeklyInputs(
				app,
				settings,
				weeksInMonth(year, month),
				knownWeekIds
			);
			if (!resolved) continue;
			if (!needsRun(db, "monthly", key, resolved.inputs)) continue;
			runs.push({ cadence: "monthly", key, year, ...resolved });
		}
	}

	// --- yearly ---
	if (settings.enableYearly) {
		const knownMonths = mergeMonths(monthsFromWeeks, await existingMonthlySummaryMonths(app, settings));
		const knownMonthIds = new Set(knownMonths.map((m) => `${m.year}:${m.month}`));
		const years = new Set(knownMonths.map((m) => m.year));
		for (const year of years) {
			const key = yearlyKey(year);
			const allMonths = Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 }));
			const resolved = await resolveMonthlyInputs(app, settings, allMonths, knownMonthIds);
			if (!resolved) continue; // a required monthly summary is missing, or the year isn't over yet
			if (!needsRun(db, "yearly", key, resolved.inputs)) continue;
			runs.push({ cadence: "yearly", key, year, ...resolved });
		}
	}

	const order: Record<Cadence, number> = { weekly: 0, biweekly: 1, monthly: 2, yearly: 3 };
	runs.sort((a, b) => order[a.cadence] - order[b.cadence] || a.key.localeCompare(b.key));
	return runs;
}

function mergeWeeks(
	...lists: Array<Array<{ year: number; week: number }>>
): Array<{ year: number; week: number }> {
	const seen = new Map<string, { year: number; week: number }>();
	for (const list of lists) {
		for (const w of list) seen.set(`${w.year}:${w.week}`, w);
	}
	return [...seen.values()];
}

const WEEKLY_FILE = /^(\d{4})-W(\d{2})\.md$/;

/** Weeks that already have a weekly summary written under `<output>/Weekly/`. */
async function existingWeeklySummaryWeeks(
	app: App,
	settings: JournalPluginSettings
): Promise<Array<{ year: number; week: number }>> {
	const base = settings.outputFolder.replace(/^\/+|\/+$/g, "");
	const weeklyRoot = `${base}/Weekly`;
	const out: Array<{ year: number; week: number }> = [];
	if (!(await app.vault.adapter.exists(weeklyRoot))) return out;

	const { folders } = await app.vault.adapter.list(weeklyRoot);
	for (const yearFolder of folders) {
		const { files } = await app.vault.adapter.list(yearFolder);
		for (const path of files) {
			const match = WEEKLY_FILE.exec(path.split("/").pop() ?? "");
			if (match) out.push({ year: Number(match[1]), week: Number(match[2]) });
		}
	}
	return out;
}

/**
 * Resolve a rollup's inputs, or null if it isn't ready yet.
 *
 * Readiness has two conditions:
 *
 * 1. Every week of the period *that has material* has a weekly summary on disk.
 *    Weeks with no journal entries at all are treated as nothing-to-say and
 *    skipped — under a strict all-weeks-must-exist rule, a single week without
 *    journaling would block that period's rollup permanently.
 * 2. The period has actually ended, so an in-progress month never gets
 *    summarized from its first week alone.
 */
async function resolveWeeklyInputs(
	app: App,
	settings: JournalPluginSettings,
	weeks: Array<{ year: number; week: number }>,
	known: Set<string>
): Promise<{ inputs: string[]; sourceKeys: string[] } | null> {
	if (weeks.length === 0) return null;

	const last = weeks[weeks.length - 1];
	if (todayUtc() <= isoWeekSunday(last.year, last.week)) return null;

	const relevant = weeks.filter((w) => known.has(`${w.year}:${w.week}`));
	if (relevant.length === 0) return null;

	const sourceKeys: string[] = [];
	for (const { year, week } of relevant) {
		const key = weeklyKey(year, week);
		const path = summaryPath(settings, "weekly", key, year);
		if (!(await summaryExists(app, path))) return null; // retry once it exists
		sourceKeys.push(key);
	}
	return { inputs: sourceKeys.map(summaryFilename).sort(), sourceKeys };
}

function mergeMonths(
	...lists: Array<Array<{ year: number; month: number }>>
): Array<{ year: number; month: number }> {
	const seen = new Map<string, { year: number; month: number }>();
	for (const list of lists) {
		for (const m of list) seen.set(`${m.year}:${m.month}`, m);
	}
	return [...seen.values()];
}

const MONTHLY_FILE = /^(\d{4})-(\d{2})\.md$/;

/** Months that already have a monthly summary written under `<output>/Monthly/`. */
async function existingMonthlySummaryMonths(
	app: App,
	settings: JournalPluginSettings
): Promise<Array<{ year: number; month: number }>> {
	const base = settings.outputFolder.replace(/^\/+|\/+$/g, "");
	const monthlyRoot = `${base}/Monthly`;
	const out: Array<{ year: number; month: number }> = [];
	if (!(await app.vault.adapter.exists(monthlyRoot))) return out;

	const { folders } = await app.vault.adapter.list(monthlyRoot);
	for (const yearFolder of folders) {
		const { files } = await app.vault.adapter.list(yearFolder);
		for (const path of files) {
			const match = MONTHLY_FILE.exec(path.split("/").pop() ?? "");
			if (match) out.push({ year: Number(match[1]), month: Number(match[2]) });
		}
	}
	return out;
}

/**
 * Resolve the yearly rollup's inputs, or null if it isn't ready yet. Mirrors
 * {@link resolveWeeklyInputs} one tier up: months with no monthly summary are
 * treated as nothing-to-say, and the year must have actually ended.
 */
async function resolveMonthlyInputs(
	app: App,
	settings: JournalPluginSettings,
	months: Array<{ year: number; month: number }>,
	known: Set<string>
): Promise<{ inputs: string[]; sourceKeys: string[] } | null> {
	if (months.length === 0) return null;

	const last = months[months.length - 1];
	if (todayUtc() <= monthEnd(last.year, last.month)) return null;

	const relevant = months.filter((m) => known.has(`${m.year}:${m.month}`));
	if (relevant.length === 0) return null;

	const sourceKeys: string[] = [];
	for (const { year, month } of relevant) {
		const key = monthlyKey(year, month);
		const path = summaryPath(settings, "monthly", key, year);
		if (!(await summaryExists(app, path))) return null; // retry once it exists
		sourceKeys.push(key);
	}
	return { inputs: sourceKeys.map(summaryFilename).sort(), sourceKeys };
}

/** Assemble the text sent to the model for one run. */
async function buildBody(
	app: App,
	settings: JournalPluginSettings,
	run: PlannedRun
): Promise<string> {
	if (run.cadence === "weekly") {
		return loadEntryText(app, run.dailies ?? []);
	}

	// Yearly rolls up monthly summaries; biweekly/monthly roll up weekly ones.
	const sourceCadence: Cadence = run.cadence === "yearly" ? "monthly" : "weekly";
	const sourceLabel = sourceCadence === "monthly" ? "Monthly" : "Weekly";

	const parts: string[] = [];
	for (const key of run.sourceKeys ?? []) {
		const year = Number(key.slice(0, 4));
		const path = summaryPath(settings, sourceCadence, key, year);
		const text = await readSummary(app, path);
		if (text) parts.push(`--- ${sourceLabel} summary: ${key} ---\n${text}\n`);
	}
	return parts.join("\n");
}

export async function executeRuns(
	app: App,
	settings: JournalPluginSettings,
	memory: MemoryStore,
	mood: MoodStore,
	db: ProcessedDb,
	runs: PlannedRun[],
	persistDb: () => Promise<void>,
	progress: RunProgress = SILENT_PROGRESS
): Promise<RunReport> {
	const provider = createProvider(settings);
	const report: RunReport = { written: [], skipped: [], failed: [], cancelled: false };

	for (const run of runs) {
		// Stop between periods so a cancelled run never leaves a half-written
		// summary or a period marked processed without its file.
		if (progress.cancelled) {
			report.cancelled = true;
			break;
		}
		progress.detail(`${run.cadence} ${run.key}`);
		// Counted per run so the `finally` can top up whichever units this
		// path didn't reach — otherwise a skipped run leaves the bar short.
		let runUnits = 0;
		const advance = (detail?: string) => {
			runUnits++;
			progress.advance(detail);
		};
		try {
			const body = await buildBody(app, settings, run);
			if (!body.trim()) {
				report.skipped.push({ run, reason: "no source content" });
				continue;
			}

			// Mood classification runs before the weekly synthesis so the
			// summary can reason over the measured arc. Rollups inherit it
			// through the weekly summaries they read, so they skip this.
			let moodContext = "";
			if (settings.enableMoodClassification && run.cadence === "weekly" && run.dailies) {
				const classified = await classifyEntries(app, provider, mood, run.dailies, progress);
				if (classified.skipped.length) {
					console.warn(
						`[confidant] mood classification skipped ${classified.skipped.length} entry/entries for ${run.key}:`,
						classified.skipped
					);
				}
				if (classified.cancelled) {
					report.cancelled = true;
					break;
				}
				moodContext = formatMoodContext(
					mood.forPaths(run.dailies.map((d) => d.file.path))
				);
			}

			// Retrieval: don't feed a period its own past summary, or the
			// weeklies already quoted in full in the prompt.
			const exclude = [run.key, ...(run.sourceKeys ?? [])];
			const retrieved = await memory.retrieve(body, exclude);

			progress.detail(`writing ${run.cadence} summary · ${run.key}`);
			const summary = await provider.chat(
				buildSynthesisMessages(
					settings,
					run.cadence,
					run.key,
					body,
					retrieved,
					moodContext
				)
			);
			advance();

			if (!summary.trim()) {
				report.skipped.push({ run, reason: "model returned an empty summary" });
				continue;
			}

			await writeSummary(
				app,
				settings,
				run.cadence,
				run.key,
				run.year,
				provider.modelLabel,
				summary
			);
			await memory.addEpisode(run.cadence, run.key, summary);

			progress.detail(`updating memory · ${run.key}`);
			await runMemoryManager(provider, memory, settings, run, summary);
			advance();

			markProcessed(db, run.cadence, run.key, run.inputs);
			await persistDb();
			report.written.push(run);
		} catch (err) {
			if (err instanceof TruncatedGenerationError) {
				// Don't write, don't mark processed — it retries on the next run.
				report.skipped.push({ run, reason: err.message });
			} else {
				report.failed.push({ run, error: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			while (runUnits < UNITS_PER_RUN) advance();
		}
	}

	return report;
}

/** Second call of the two-call pattern. Failures here never lose the summary. */
async function runMemoryManager(
	provider: LLMProvider,
	memory: MemoryStore,
	settings: JournalPluginSettings,
	run: PlannedRun,
	summary: string
): Promise<void> {
	try {
		const currentCore = await memory.readCore();
		const raw = await provider.chat(
			buildMemoryManagerMessages(
				run.cadence,
				run.key,
				summary,
				currentCore,
				settings.coreMemoryMaxChars
			),
			{ temperature: 0.2 }
		);
		const parsed = parseMemoryManagerResponse(raw);
		if (!parsed) {
			console.warn(`[confidant] memory manager returned unparseable output for ${run.key}`);
			return;
		}
		if (parsed.coreMemory.trim()) await memory.writeCore(parsed.coreMemory);
		if (parsed.semanticFacts.length) {
			await memory.addSemanticFacts(parsed.semanticFacts, run.key);
		}
	} catch (err) {
		console.error(`[confidant] memory update failed for ${run.key}:`, err);
		new Notice(`Confidant: memory update failed for ${run.key} (summary was still saved).`);
	}
}
