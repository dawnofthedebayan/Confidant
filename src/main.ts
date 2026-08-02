import { Notice, Plugin, normalizePath } from "obsidian";
import { PlannedRun, RunReport, estimateWork, executeRuns, planRuns } from "./pipeline";
import { ProgressReporter } from "./ui/progress";
import { ProcessedDb, emptyDb, normalizeDb } from "./journal/tracking";
import { MemoryStore } from "./memory/store";
import { renderMemoryDump, writeMemoryDump } from "./memory/dump";
import { createProvider, listModels } from "./llm/provider";
import { createEmbeddingProvider } from "./memory/embeddings";
import { INSIGHTS_VIEW_TYPE, InsightsView } from "./insights/view";
import { InsightMetrics } from "./insights/metrics";
import { Portrait, buildPortraitMessages } from "./insights/portrait";
import { MoodStore } from "./mood/store";
import { classifyEntries, countPendingClassification } from "./mood/classify";
import { discoverDailyEntries } from "./journal/discovery";
import { ensureFrontmatter } from "./journal/frontmatter";
import { CadencePickerModal } from "./ui/cadencePickerModal";
import { CONFIDANT_ICON_ID, registerConfidantIcon } from "./ui/icon";
import { detectPresetId } from "./promptPresets";
import { diagnoseDiscovery } from "./journal/diagnose";
import { DiagnosticModal } from "./ui/diagnosticModal";
import {
	Cadence,
	DEFAULT_SETTINGS,
	JournalPluginSettings,
} from "./settings";
import { ConfidantSettingTab } from "./ui/settingsTab";

interface PersistedData {
	settings: JournalPluginSettings;
	processed: ProcessedDb;
	portrait?: Portrait;
}

export default class ConfidantPlugin extends Plugin {
	settings!: JournalPluginSettings;
	processed!: ProcessedDb;
	memory!: MemoryStore;
	mood!: MoodStore;
	portrait: Portrait | null = null;

	private running = false;
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		await this.loadPersisted();

		this.memory = new MemoryStore(
			this.app,
			this.pluginDir,
			() => this.settings,
			() => createEmbeddingProvider(this.settings)
		);
		await this.memory.load();

		this.mood = new MoodStore(this.app, this.pluginDir);
		await this.mood.load();

		this.addSettingTab(new ConfidantSettingTab(this.app, this));

		this.registerView(
			INSIGHTS_VIEW_TYPE,
			(leaf) => new InsightsView(leaf, this)
		);

		registerConfidantIcon();

		this.addRibbonIcon("bar-chart-3", "Journal insights", () => {
			void this.activateInsights();
		});

		this.addRibbonIcon(CONFIDANT_ICON_ID, "Generate journal summary…", () => {
			new CadencePickerModal(this.app, this).open();
		});

		this.addCommand({
			id: "open-insights",
			name: "Open insights dashboard",
			callback: () => void this.activateInsights(),
		});

		this.addCommand({
			id: "open-cadence-picker",
			name: "Generate journal summary (choose cadence)…",
			callback: () => new CadencePickerModal(this.app, this).open(),
		});

		this.addCommand({
			id: "run-pending",
			name: "Generate all pending summaries",
			callback: () => void this.run(),
		});

		this.addCommand({
			id: "check-pending",
			name: "Check what needs generating (and why)",
			callback: () => void this.reportPending(),
		});

		this.addCommand({
			id: "rebuild-embeddings",
			name: "Rebuild memory embeddings",
			callback: () => void this.rebuildEmbeddings(),
		});

		this.addCommand({
			id: "dump-memory",
			name: "Dump memory to note",
			callback: () => void this.dumpMemory(),
		});

		this.addCommand({
			id: "classify-moods",
			name: "Classify moods for new entries",
			callback: () => void this.classifyMoods(),
		});

		for (const cadence of ["weekly", "biweekly", "monthly", "yearly"] as Cadence[]) {
			this.addCommand({
				id: `run-${cadence}`,
				name: `Generate pending ${cadence} summaries`,
				callback: () => void this.run(cadence),
			});
		}

		this.app.workspace.onLayoutReady(() => this.restartAutoCheck());
	}

	onunload(): void {
		this.stopAutoCheck();
	}

	private get pluginDir(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`
		);
	}

	// ------------------------------------------------------------------
	// Persistence
	// ------------------------------------------------------------------

	private async loadPersisted(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PersistedData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});

		// Installs predating the preset picker stored only the prompt text.
		// Match it back to a preset so the picker doesn't claim a lens the
		// stored text isn't; anything unrecognised is correctly "Custom".
		if (!raw?.settings?.promptPresetId) {
			this.settings.promptPresetId = detectPresetId(this.settings.therapistSystemPrompt);
		}
		this.processed = raw?.processed ? normalizeDb(raw.processed) : emptyDb();
		this.portrait = raw?.portrait ?? null;
	}

	private async persist(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			processed: this.processed,
			...(this.portrait ? { portrait: this.portrait } : {}),
		});
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	// ------------------------------------------------------------------
	// Triggers
	// ------------------------------------------------------------------

	restartAutoCheck(): void {
		this.stopAutoCheck();
		const minutes = this.settings.autoCheckIntervalMinutes;
		if (minutes <= 0) return;
		this.intervalId = window.setInterval(
			() => void this.autoCheck(),
			minutes * 60_000
		);
		this.registerInterval(this.intervalId);
	}

	private stopAutoCheck(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** Interval check: surfaces a notice rather than running unattended. */
	private async autoCheck(): Promise<void> {
		if (this.running) return;
		let pending: PlannedRun[];
		try {
			pending = await planRuns(this.app, this.settings, this.processed);
		} catch (err) {
			console.error("[confidant] auto-check failed:", err);
			return;
		}
		if (pending.length === 0) return;

		if (this.settings.autoRunWithoutConfirmation) {
			await this.run();
			return;
		}

		const notice = new Notice("", 30_000);
		notice.messageEl.createDiv({
			text: `Confidant: ${pending.length} summary/summaries pending (${summarizeKeys(pending)}).`,
		});
		const button = notice.messageEl.createEl("button", {
			text: "Generate now",
			cls: "confidant-notice-button",
		});
		button.addEventListener("click", () => {
			notice.hide();
			void this.run();
		});
	}

	// ------------------------------------------------------------------
	// Runs
	// ------------------------------------------------------------------

	/**
	 * Shows the full discovery funnel rather than just a count — "nothing to
	 * generate" has several possible causes that are indistinguishable from a
	 * Notice alone.
	 */
	async reportPending(): Promise<void> {
		const pending = await planRuns(this.app, this.settings, this.processed);
		const diagnosis = diagnoseDiscovery(this.app, this.settings, this.processed);
		new DiagnosticModal(this.app, diagnosis, pending).open();
	}

	async run(only?: Cadence): Promise<void> {
		if (this.running) {
			new Notice("Confidant: a run is already in progress.");
			return;
		}
		this.running = true;
		let progress: ProgressReporter | null = null;

		try {
			const frontmatterBackfill = await ensureFrontmatter(this.app, this.settings);
			if (frontmatterBackfill.fallbackDated.length) {
				const names = frontmatterBackfill.fallbackDated.map((p) => p.split("/").pop());
				new Notice(
					`Confidant: ${names.length} note(s) had no date in frontmatter or filename — dated today. Check: ${names
						.slice(0, 5)
						.join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}`,
					15_000
				);
			}
			if (frontmatterBackfill.failed.length) {
				console.warn(
					"[confidant] frontmatter backfill failed for:",
					frontmatterBackfill.failed
				);
			}

			let runs = await planRuns(this.app, this.settings, this.processed);
			if (only) runs = runs.filter((r) => r.cadence === only);

			if (runs.length === 0) {
				new Notice("Confidant: nothing to generate.");
				return;
			}

			progress = new ProgressReporter(
				`Generating ${runs.length} ${runs.length === 1 ? "summary" : "summaries"}`
			);
			progress.detail("estimating work…");
			progress.setTotal(await estimateWork(this.app, this.settings, this.mood, runs));

			const report = await executeRuns(
				this.app,
				this.settings,
				this.memory,
				this.mood,
				this.processed,
				runs,
				() => this.persist(),
				progress
			);

			progress.finish(this.announce(report, progress.elapsed), report.failed.length > 0);
			progress = null;
			await this.refreshInsights();
		} catch (err) {
			console.error("[confidant] run failed:", err);
			const message = `Confidant: ${err instanceof Error ? err.message : String(err)}`;
			if (progress) progress.finish(message, true);
			else new Notice(message, 10_000);
			progress = null;
		} finally {
			progress?.hide();
			this.running = false;
		}
	}

	private announce(report: RunReport, elapsedMs: number): string {
		const seconds = Math.round(elapsedMs / 1000);
		const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

		const lines: string[] = [
			report.cancelled
				? `Confidant: cancelled after writing ${report.written.length}.`
				: `Confidant: wrote ${report.written.length} in ${took}.`,
		];
		if (report.skipped.length) {
			lines.push(
				`Skipped ${report.skipped.length} (will retry): ${report.skipped
					.map((s) => `${s.run.key} — ${s.reason}`)
					.join("; ")}`
			);
		}
		if (report.failed.length) {
			lines.push(
				`Failed ${report.failed.length}: ${report.failed
					.map((f) => `${f.run.key} — ${f.error}`)
					.join("; ")}`
			);
		}
		return lines.join("\n");
	}

	async testConnection(): Promise<void> {
		const provider = createProvider(this.settings);
		try {
			await provider.chat(
				[{ role: "user", content: "Reply with the single word: ok" }],
				{ maxTokens: 512, temperature: 0 }
			);
		} catch (err) {
			if (this.settings.backend === "local") {
				throw await this.withLoadedModels(err, this.settings.localServerUrl);
			}
			throw err;
		}
	}

	/** Returns the embedding dimension, which is the useful thing to confirm. */
	async testEmbeddings(): Promise<number> {
		try {
			const vector = await createEmbeddingProvider(this.settings).embed(
				"A short probe sentence."
			);
			return vector.length;
		} catch (err) {
			throw await this.withLoadedModels(err, this.settings.embeddingServerUrl);
		}
	}

	/**
	 * A wrong model identifier is the most common local-server failure, so
	 * append what the server actually has loaded to the error.
	 */
	private async withLoadedModels(err: unknown, endpointUrl: string): Promise<Error> {
		const base = err instanceof Error ? err.message : String(err);
		try {
			const models = await listModels(endpointUrl);
			if (models.length) {
				return new Error(`${base}\n\nServer has loaded: ${models.join(", ")}`);
			}
			return new Error(`${base}\n\nNo models are loaded on that server.`);
		} catch {
			return new Error(base);
		}
	}

	async rebuildEmbeddings(): Promise<void> {
		const before = this.memory.stats();
		if (before.stale === 0) {
			new Notice(
				before.semantic + before.episodic === 0
					? "Confidant: no memories stored yet — generate a summary first."
					: "Confidant: all embeddings are already current."
			);
			return;
		}

		const progress = new ProgressReporter(
			`Re-embedding ${before.stale} record(s)`,
			before.stale
		);
		try {
			let last = 0;
			const count = await this.memory.rebuildEmbeddings((done) => {
				// The store reports cumulative totals; the bar wants deltas.
				for (; last < done; last++) progress.advance();
				progress.detail(`embedded ${done} of ${before.stale}`);
			});
			progress.finish(`Confidant: re-embedded ${count} record(s).`);
		} catch (err) {
			progress.finish(
				`Confidant: re-embedding failed — ${err instanceof Error ? err.message : String(err)}`,
				true
			);
		}
	}

	/** Standalone mood pass — the same work the weekly run does inline. */
	async classifyMoods(): Promise<void> {
		if (this.running) {
			new Notice("Confidant: a run is already in progress.");
			return;
		}
		this.running = true;
		let progress: ProgressReporter | null = null;

		try {
			const grouped = discoverDailyEntries(this.app, this.settings);
			const entries = [...grouped.values()].flat();
			if (entries.length === 0) {
				new Notice("Confidant: no journal entries found.");
				return;
			}

			// Drop records for notes that have since been deleted or renamed.
			await this.mood.prune(new Set(entries.map((e) => e.file.path)));

			const pending = await countPendingClassification(this.app, this.mood, entries);
			if (pending === 0) {
				new Notice("Confidant: every entry is already classified.");
				return;
			}

			progress = new ProgressReporter(
				`Classifying ${pending} ${pending === 1 ? "entry" : "entries"}`,
				pending
			);

			const report = await classifyEntries(
				this.app,
				createProvider(this.settings),
				this.mood,
				entries,
				progress
			);

			const parts = [`classified ${report.classified}`];
			if (report.unchanged) parts.push(`${report.unchanged} unchanged`);
			if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
			progress.finish(
				`Confidant: ${report.cancelled ? "cancelled — " : ""}${parts.join(", ")}.`
			);
			progress = null;

			if (report.skipped.length) {
				console.warn("[confidant] mood classification skipped:", report.skipped);
			}
			await this.refreshInsights();
		} catch (err) {
			const message = `Confidant: mood classification failed — ${err instanceof Error ? err.message : String(err)}`;
			if (progress) progress.finish(message, true);
			else new Notice(message, 10_000);
			progress = null;
		} finally {
			progress?.hide();
			this.running = false;
		}
	}

	// ------------------------------------------------------------------
	// Insights
	// ------------------------------------------------------------------

	/** Recompute any open dashboard so it reflects freshly written data. */
	private async refreshInsights(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(INSIGHTS_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof InsightsView) await view.refresh();
		}
	}

	/** Reveal the dashboard if it's already open, else open it as a new tab. */
	async activateInsights(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(INSIGHTS_VIEW_TYPE);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf(true);
		await leaf.setViewState({ type: INSIGHTS_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** One LLM call, cached in plugin data so it isn't regenerated on every open. */
	async generatePortrait(metrics: InsightMetrics): Promise<void> {
		const provider = createProvider(this.settings);
		const core = await this.memory.readCore();
		const facts = this.memory.snapshot().semantic.map((f) => f.text);

		let text: string;
		try {
			text = await provider.chat(buildPortraitMessages(this.settings, metrics, core, facts));
		} catch (err) {
			if (this.settings.backend === "local") {
				throw await this.withLoadedModels(err, this.settings.localServerUrl);
			}
			throw err;
		}

		if (!text.trim()) throw new Error("the model returned an empty portrait.");

		this.portrait = {
			text: text.trim(),
			generatedAt: new Date().toISOString(),
			model: provider.modelLabel,
		};
		await this.persist();
	}

	async dumpMemory(): Promise<void> {
		try {
			const core = await this.memory.readCore();
			const { semantic, episodic } = this.memory.snapshot();
			const content = renderMemoryDump(core, semantic, episodic);
			const file = await writeMemoryDump(this.app, this.settings, content);
			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice(
				`Confidant: dumped ${semantic.length} fact(s) and ${episodic.length} memories to ${file.path}.`
			);
		} catch (err) {
			new Notice(
				`Confidant: memory dump failed — ${err instanceof Error ? err.message : String(err)}`,
				10_000
			);
		}
	}
}

function summarizeKeys(runs: PlannedRun[]): string {
	const keys = runs.slice(0, 5).map((r) => r.key);
	return runs.length > 5 ? `${keys.join(", ")}, +${runs.length - 5} more` : keys.join(", ");
}
