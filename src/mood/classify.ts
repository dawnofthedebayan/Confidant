import { App } from "obsidian";
import { DailyEntry } from "../journal/discovery";
import { LLMProvider, TruncatedGenerationError } from "../llm/provider";
import { buildMoodMessages, extractMoodJson, validateMoodFields } from "./prompt";
import { MoodStore } from "./store";
import { MoodRecord, contentHash } from "./types";
import { RunProgress, SILENT_PROGRESS } from "../ui/progress";

export interface ClassifyReport {
	classified: number;
	unchanged: number;
	skipped: Array<{ file: string; reason: string }>;
	cancelled: boolean;
}

/** How many entries would actually be sent to the model, for progress sizing. */
export async function countPendingClassification(
	app: App,
	mood: MoodStore,
	entries: DailyEntry[]
): Promise<number> {
	let pending = 0;
	for (const entry of entries) {
		const text = await app.vault.cachedRead(entry.file);
		if (text.trim() && mood.needsClassification(entry.file.path, text)) pending++;
	}
	return pending;
}

/**
 * Classify each entry that is new or edited since last time. One LLM call per
 * entry, so this is the expensive part of a run — it is skipped entirely for
 * entries whose content hash still matches.
 */
export async function classifyEntries(
	app: App,
	provider: LLMProvider,
	mood: MoodStore,
	entries: DailyEntry[],
	progress: RunProgress = SILENT_PROGRESS
): Promise<ClassifyReport> {
	const report: ClassifyReport = {
		classified: 0,
		unchanged: 0,
		skipped: [],
		cancelled: false,
	};

	// Decide the work list up front so progress counts are meaningful.
	const pending: Array<{ entry: DailyEntry; text: string }> = [];
	for (const entry of entries) {
		const text = await app.vault.cachedRead(entry.file);
		if (!text.trim()) {
			report.skipped.push({ file: entry.file.name, reason: "empty entry" });
			continue;
		}
		if (mood.needsClassification(entry.file.path, text)) pending.push({ entry, text });
		else report.unchanged++;
	}

	for (const { entry, text } of pending) {
		if (progress.cancelled) {
			report.cancelled = true;
			break;
		}
		progress.detail(`mood · ${entry.file.basename}`);
		try {
			// Low temperature: this is structured extraction, not writing.
			const raw = await provider.chat(buildMoodMessages(text), {
				temperature: 0.1,
				maxTokens: 3072,
			});

			const parsed = extractMoodJson(raw);
			if (!parsed) {
				// Not stored, so it retries on the next run rather than
				// persisting a guess.
				report.skipped.push({ file: entry.file.name, reason: "unparseable JSON" });
			} else {
				const fields = validateMoodFields(parsed);
				const record: MoodRecord = {
					path: entry.file.path,
					filename: entry.file.name,
					date: entry.date.toISOString().slice(0, 10),
					...fields,
					contentHash: contentHash(text),
					classifiedAt: new Date().toISOString(),
					model: provider.modelLabel,
				};
				await mood.upsert(record);
				report.classified++;
			}
		} catch (err) {
			const reason =
				err instanceof TruncatedGenerationError
					? "generation truncated"
					: err instanceof Error
						? err.message
						: String(err);
			report.skipped.push({ file: entry.file.name, reason });
		} finally {
			// Every attempted entry advances the bar, successful or not.
			progress.advance();
		}
	}

	return report;
}

/**
 * Compact per-day mood line-up handed to the weekly synthesis call, so the
 * therapeutic summary can reason over the measured arc instead of re-deriving
 * it from the prose.
 */
export function formatMoodContext(records: MoodRecord[]): string {
	if (records.length === 0) return "";
	const lines = records.map((r) => {
		const bits = [
			r.date,
			r.primaryEmotion,
			`valence ${r.valence > 0 ? "+" : ""}${r.valence}`,
			`arousal ${r.arousal}`,
			r.socialContact !== "unclear" ? r.socialContact.replace("_", " ") : null,
			r.sleepQuality ? `sleep ${r.sleepQuality}` : null,
			r.notableEvent ? "notable event" : null,
		].filter(Boolean);
		return `- ${bits.join(" · ")}${r.summary ? ` — ${r.summary}` : ""}`;
	});
	return `Structured mood classification for these days (generated per entry, independent of your reading):\n${lines.join("\n")}`;
}
