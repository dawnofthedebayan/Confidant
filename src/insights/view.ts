import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ConfidantPlugin from "../main";
import { Counted, InsightMetrics, computeMetrics } from "./metrics";
import { DAY_NAMES } from "./portrait";
import { MoodAggregate, Slice, aggregateMood } from "../mood/aggregate";

export const INSIGHTS_VIEW_TYPE = "confidant-insights";

/** Below this sample size a group average is shown but marked as thin. */
const THIN_SAMPLE = 3;

export class InsightsView extends ItemView {
	private metrics: InsightMetrics | null = null;
	private mood: MoodAggregate | null = null;
	private loading = false;

	constructor(leaf: WorkspaceLeaf, private plugin: ConfidantPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return INSIGHTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Journal insights";
	}

	getIcon(): string {
		return "bar-chart-3";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.renderLoading();
		try {
			this.metrics = await computeMetrics(this.app, this.plugin.settings);
			this.mood = aggregateMood(this.plugin.mood.all());
			this.render();
		} catch (err) {
			this.renderError(err instanceof Error ? err.message : String(err));
		} finally {
			this.loading = false;
		}
	}

	// ------------------------------------------------------------------ chrome --

	private renderLoading(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("jt-insights");
		root.createDiv({ cls: "jt-empty", text: "Reading journal…" });
	}

	private renderError(message: string): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("jt-insights");
		root.createDiv({ cls: "jt-empty", text: `Could not compute insights: ${message}` });
	}

	private render(): void {
		const m = this.metrics;
		const root = this.contentEl;
		root.empty();
		root.addClass("jt-insights");

		this.renderHeader(root, m);
		if (!m || m.entryCount === 0) {
			root.createDiv({
				cls: "jt-empty",
				text:
					"No journal entries found. Check the source folder and tag filter in the plugin settings — entries need a date in frontmatter or in the filename.",
			});
			return;
		}

		this.renderTiles(root, m);

		if (this.mood && this.mood.count > 0) this.renderMoodArc(root, this.mood);

		const grid = root.createDiv({ cls: "jt-grid" });
		if (this.mood && this.mood.count > 0) {
			this.renderMoodCrosscuts(grid, this.mood);
			this.renderMoodBreakdown(grid, this.mood);
		} else {
			this.renderMoodEmpty(grid);
		}
		this.renderRhythm(grid, m);
		this.renderVoice(grid, m);
		this.renderThemes(grid, m);
		this.renderVocabulary(grid, m);
		this.renderExtremes(grid, m);
		void this.renderMemory(grid);
		void this.renderPortrait(root);
	}

	private renderHeader(root: HTMLElement, m: InsightMetrics | null): void {
		const header = root.createDiv({ cls: "jt-header" });
		const titles = header.createDiv();
		titles.createEl("h2", { text: "Journal insights", cls: "jt-title" });
		if (m && m.firstDate && m.lastDate) {
			titles.createDiv({
				cls: "jt-subtitle",
				text: `${iso(m.firstDate)} → ${iso(m.lastDate)} · computed locally, no model involved`,
			});
		}

		const button = header.createEl("button", { cls: "jt-icon-button" });
		setIcon(button, "refresh-cw");
		button.setAttribute("aria-label", "Recompute");
		button.addEventListener("click", () => void this.refresh());
	}

	private renderTiles(root: HTMLElement, m: InsightMetrics): void {
		const tiles = root.createDiv({ cls: "jt-tiles" });
		const tile = (value: string, label: string, hint?: string) => {
			const el = tiles.createDiv({ cls: "jt-tile" });
			el.createDiv({ cls: "jt-tile-value", text: value });
			el.createDiv({ cls: "jt-tile-label", text: label });
			if (hint) el.createDiv({ cls: "jt-tile-hint", text: hint });
		};

		tile(String(m.entryCount), "entries", `${m.entriesPerActiveWeek}/active week`);
		tile(compact(m.totalWords), "words written", `${m.meanWords} avg per entry`);
		tile(String(m.medianWords), "median words", `${m.minWords}–${m.maxWords} range`);
		tile(String(m.activeWeeks), "active weeks", `${m.silentWeeks} silent`);
		tile(String(m.longestStreak), "longest streak", `${m.currentStreak} current`);

		const mood = this.mood;
		if (mood && mood.count > 0) {
			tile(
				`${mood.avgValence > 0 ? "+" : ""}${mood.avgValence}`,
				"average valence",
				`on a -5 to +5 scale`
			);
			tile(mood.emotions[0]?.label ?? "—", "most common mood", `${mood.emotions[0]?.count ?? 0} entries`);
			tile(`${mood.notableEventRate}%`, "notable days", "flagged as significant");
		} else {
			tile(`${m.selfReferenceRate}%`, "self-reference", "of all words are I/me/my");
		}
	}

	// ----------------------------------------------------------------- sections --

	// -------------------------------------------------------------------- mood --

	private renderMoodEmpty(grid: HTMLElement): void {
		const card = section(grid, "Mood", "Per-entry emotional classification");
		card.createDiv({
			cls: "jt-note",
			text: this.plugin.settings.enableMoodClassification
				? "No entries classified yet. Run \"Classify moods for new entries\", or generate weekly summaries — classification runs alongside them. Needs the chat server."
				: "Mood classification is turned off in settings.",
		});
		const actions = card.createDiv({ cls: "jt-actions" });
		const run = actions.createEl("button", { text: "Classify now", cls: "jt-button mod-cta" });
		run.addEventListener("click", () => void this.plugin.classifyMoods());
	}

	/** Valence over time as a diverging column chart around a zero line. */
	private renderMoodArc(root: HTMLElement, mood: MoodAggregate): void {
		const card = section(
			root,
			"Mood arc",
			`Valence per entry across ${mood.count} classified ${mood.count === 1 ? "entry" : "entries"}`
		);
		card.addClass("jt-card-wide");

		const chart = card.createDiv({ cls: "jt-diverging" });
		for (const point of mood.series) {
			const col = chart.createDiv({ cls: "jt-diverging-col" });
			col.setAttribute(
				"aria-label",
				`${point.date}: ${point.emotion}, valence ${point.valence}${point.summary ? ` — ${point.summary}` : ""}`
			);

			const up = col.createDiv({ cls: "jt-diverging-half is-up" });
			const down = col.createDiv({ cls: "jt-diverging-half is-down" });
			const magnitude = `${(Math.abs(point.valence) / 5) * 100}%`;
			if (point.valence >= 0) {
				const bar = up.createDiv({ cls: "jt-diverging-bar is-positive" });
				bar.style.height = magnitude;
			} else {
				const bar = down.createDiv({ cls: "jt-diverging-bar is-negative" });
				bar.style.height = magnitude;
			}
		}

		const legend = card.createDiv({ cls: "jt-legend" });
		legend.createSpan({ text: `${mood.series[0]?.date ?? ""}` });
		legend.createSpan({ cls: "jt-legend-mid", text: "chronological · zero line = neutral" });
		legend.createSpan({ text: `${mood.series[mood.series.length - 1]?.date ?? ""}` });

		const facts = card.createDiv({ cls: "jt-facts" });
		if (mood.best) {
			fact(facts, `Highest (${mood.best.date})`, `+${mood.best.valence} · ${mood.best.primaryEmotion}`);
		}
		if (mood.worst) {
			fact(facts, `Lowest (${mood.worst.date})`, `${mood.worst.valence} · ${mood.worst.primaryEmotion}`);
		}
		fact(facts, "Classifier confidence", `${mood.avgConfidence} average`);
		if (mood.lowConfidence) {
			card.createDiv({
				cls: "jt-note",
				text: `${mood.lowConfidence} entry/entries were classified with low confidence — usually very short notes. They are included in these numbers.`,
			});
		}
	}

	/** The comparisons that actually say something: valence against context. */
	private renderMoodCrosscuts(grid: HTMLElement, mood: MoodAggregate): void {
		const card = section(grid, "What moves the needle", "Average valence, grouped");

		const group = (label: string, slices: Slice[]) => {
			if (slices.length === 0) return;
			card.createDiv({ cls: "jt-label", text: label });
			divergingRows(card, slices);
		};

		group("By company", mood.valenceBySocial);
		group("By sleep quality", mood.valenceBySleep);
		group("By weekday", mood.valenceByWeekday);
		group("By energy level", mood.valenceByArousal);

		const thin = [
			...mood.valenceBySocial,
			...mood.valenceBySleep,
			...mood.valenceByWeekday,
			...mood.valenceByArousal,
		].some((s) => s.count < THIN_SAMPLE);
		if (thin) {
			card.createDiv({
				cls: "jt-note",
				text: `Groups marked with a small count have fewer than ${THIN_SAMPLE} entries behind them — read those as anecdote, not pattern.`,
			});
		}
	}

	private renderMoodBreakdown(grid: HTMLElement, mood: MoodAggregate): void {
		const card = section(grid, "Mood composition", "How the classifier labelled things");

		card.createDiv({ cls: "jt-label", text: "Primary emotion" });
		bars(card, mood.emotions, 10);

		card.createDiv({ cls: "jt-label", text: "Energy" });
		bars(card, mood.arousal, 3);

		card.createDiv({ cls: "jt-label", text: "Company" });
		bars(card, mood.social, 4);

		if (mood.sleep.length) {
			card.createDiv({ cls: "jt-label", text: "Sleep (when mentioned)" });
			bars(card, mood.sleep, 3);
		}

		if (mood.topics.length) {
			card.createDiv({ cls: "jt-label", text: "Topics the classifier saw" });
			bars(card, mood.topics, 12);
		}
	}

	private renderRhythm(grid: HTMLElement, m: InsightMetrics): void {
		const card = section(grid, "Rhythm", "When the writing actually happens");

		card.createDiv({ cls: "jt-label", text: "By weekday" });
		const days = card.createDiv({ cls: "jt-columns" });
		const dayMax = Math.max(...m.byDayOfWeek, 1);
		m.byDayOfWeek.forEach((count, i) => {
			const col = days.createDiv({ cls: "jt-column" });
			const track = col.createDiv({ cls: "jt-column-track" });
			const fill = track.createDiv({ cls: "jt-column-fill" });
			fill.style.height = `${(count / dayMax) * 100}%`;
			if (count === dayMax) fill.addClass("is-peak");
			fill.setAttribute("aria-label", `${DAY_NAMES[i]}: ${count}`);
			col.createDiv({ cls: "jt-column-label", text: DAY_NAMES[i].slice(0, 2) });
			col.createDiv({ cls: "jt-column-value", text: String(count) });
		});

		card.createDiv({ cls: "jt-label", text: "Words per week" });
		const weeks = card.createDiv({ cls: "jt-columns jt-columns-dense" });
		const weekMax = Math.max(...m.byWeek.map((w) => w.words), 1);
		for (const week of m.byWeek) {
			const col = weeks.createDiv({ cls: "jt-column" });
			const track = col.createDiv({ cls: "jt-column-track" });
			const fill = track.createDiv({ cls: "jt-column-fill" });
			fill.style.height = `${(week.words / weekMax) * 100}%`;
			fill.setAttribute(
				"aria-label",
				`${week.key}: ${week.words} words across ${week.entries} entries`
			);
			col.createDiv({ cls: "jt-column-label", text: week.key.replace(/^\d{4}-W/, "") });
		}
	}

	private renderVoice(grid: HTMLElement, m: InsightMetrics): void {
		const card = section(grid, "Voice", "Descriptive language patterns, not a diagnosis");

		const rows = card.createDiv({ cls: "jt-facts" });
		fact(rows, "Average sentence", `${m.avgSentenceLength} words`);
		fact(rows, "Questions per entry", String(m.questionsPerEntry));
		fact(rows, "Longest entry", `${m.maxWords} words`);
		fact(rows, "Shortest entry", `${m.minWords} words`);

		card.createDiv({ cls: "jt-label", text: "Who the writing is about" });
		bars(card, m.pronouns, 6);
		card.createDiv({
			cls: "jt-note",
			text:
				"Pronoun mix is a rough signal of attention — inward versus shared versus other-directed. Read it as description only.",
		});
	}

	private renderThemes(grid: HTMLElement, m: InsightMetrics): void {
		const card = section(grid, "Themes", "From the tags on your entries");

		if (!m.domains.length && !m.topics.length && !m.people.length) {
			card.createDiv({
				cls: "jt-note",
				text: "No domain/, topic/ or people/ tags found — the tag breakdown needs those prefixes.",
			});
			if (m.tags.length) bars(card, m.tags, 10);
			return;
		}

		if (m.domains.length) {
			card.createDiv({ cls: "jt-label", text: "Domains" });
			bars(card, m.domains, 8);
		}
		if (m.topics.length) {
			card.createDiv({ cls: "jt-label", text: "Topics" });
			bars(card, m.topics, 8);
		}
		if (m.people.length) {
			card.createDiv({ cls: "jt-label", text: `People (${m.people.length} named)` });
			bars(card, m.people, 10);
		}
	}

	private renderVocabulary(grid: HTMLElement, m: InsightMetrics): void {
		const card = section(grid, "Vocabulary", "Most frequent words, common ones removed");
		const cloud = card.createDiv({ cls: "jt-cloud" });
		const max = m.topWords[0]?.count ?? 1;
		const min = m.topWords[m.topWords.length - 1]?.count ?? 1;
		for (const word of m.topWords) {
			const chip = cloud.createSpan({ cls: "jt-chip", text: word.label });
			// Scale 0.85–1.6rem across the observed frequency range.
			const t = max === min ? 1 : (word.count - min) / (max - min);
			chip.style.fontSize = `${(0.85 + t * 0.75).toFixed(2)}rem`;
			chip.style.opacity = `${(0.6 + t * 0.4).toFixed(2)}`;
			chip.setAttribute("aria-label", `${word.label}: ${word.count}`);
		}
	}

	private renderExtremes(grid: HTMLElement, m: InsightMetrics): void {
		if (!m.longest && !m.shortest) return;
		const card = section(grid, "Outliers", "The entries at the edges");
		const rows = card.createDiv({ cls: "jt-facts" });

		const link = (label: string, stat: typeof m.longest) => {
			if (!stat) return;
			const row = rows.createDiv({ cls: "jt-fact" });
			row.createSpan({ cls: "jt-fact-label", text: label });
			const value = row.createSpan({ cls: "jt-fact-value" });
			const anchor = value.createEl("a", {
				text: stat.basename,
				cls: "jt-link",
				href: "#",
			});
			anchor.addEventListener("click", (evt) => {
				evt.preventDefault();
				void this.app.workspace.openLinkText(stat.path, "", false);
			});
			value.createSpan({ cls: "jt-fact-hint", text: ` · ${stat.words} words · ${iso(stat.date)}` });
		};

		link("Longest", m.longest);
		link("Shortest", m.shortest);
	}

	private async renderMemory(grid: HTMLElement): Promise<void> {
		const stats = this.plugin.memory.stats();
		const card = section(grid, "Memory", "What the plugin has learned so far");

		const rows = card.createDiv({ cls: "jt-facts" });
		fact(rows, "Semantic facts", String(stats.semantic));
		fact(rows, "Past summaries", String(stats.episodic));
		if (stats.stale) fact(rows, "Need re-embedding", String(stats.stale));

		const core = await this.plugin.memory.readCore();
		if (core.trim()) {
			card.createDiv({ cls: "jt-label", text: "Core memory" });
			const body = card.createDiv({ cls: "jt-markdown" });
			await MarkdownRenderer.render(this.app, core, body, "", this);
		}

		const actions = card.createDiv({ cls: "jt-actions" });
		const dump = actions.createEl("button", { text: "Open full memory note", cls: "jt-button" });
		dump.addEventListener("click", () => void this.plugin.dumpMemory());
	}

	private async renderPortrait(root: HTMLElement): Promise<void> {
		const card = section(root, "Portrait", "A reflection written by the model, from the numbers above");
		card.addClass("jt-card-wide");

		const existing = this.plugin.portrait;
		const body = card.createDiv({ cls: "jt-markdown" });

		if (existing) {
			await MarkdownRenderer.render(this.app, existing.text, body, "", this);
			card.createDiv({
				cls: "jt-note",
				text: `Generated ${existing.generatedAt.slice(0, 16).replace("T", " ")} by ${existing.model}.`,
			});
		} else {
			body.createDiv({
				cls: "jt-note",
				text: "Not generated yet. This makes one LLM call using the metrics above plus stored memory — the chat server needs to be running.",
			});
		}

		const actions = card.createDiv({ cls: "jt-actions" });
		const generate = actions.createEl("button", {
			text: existing ? "Regenerate portrait" : "Generate portrait",
			cls: "jt-button mod-cta",
		});
		generate.addEventListener("click", async () => {
			if (!this.metrics) return;
			generate.setAttribute("disabled", "true");
			generate.setText("Writing…");
			try {
				await this.plugin.generatePortrait(this.metrics);
				this.render();
			} catch (err) {
				new Notice(
					`Confidant: portrait failed — ${err instanceof Error ? err.message : String(err)}`,
					10_000
				);
				generate.removeAttribute("disabled");
				generate.setText("Generate portrait");
			}
		});
	}
}

// -------------------------------------------------------------------- helpers --

function section(parent: HTMLElement, title: string, subtitle?: string): HTMLElement {
	const card = parent.createDiv({ cls: "jt-card" });
	card.createDiv({ cls: "jt-card-title", text: title });
	if (subtitle) card.createDiv({ cls: "jt-card-subtitle", text: subtitle });
	return card;
}

function bars(parent: HTMLElement, items: Counted[], limit: number): void {
	const wrap = parent.createDiv({ cls: "jt-bars" });
	const shown = items.slice(0, limit);
	const max = Math.max(...shown.map((i) => i.count), 1);
	for (const item of shown) {
		const row = wrap.createDiv({ cls: "jt-bar-row" });
		row.createDiv({ cls: "jt-bar-label", text: item.label });
		const track = row.createDiv({ cls: "jt-bar-track" });
		const fill = track.createDiv({ cls: "jt-bar-fill" });
		fill.style.width = `${(item.count / max) * 100}%`;
		row.createDiv({ cls: "jt-bar-value", text: String(item.count) });
	}
}

/**
 * Rows whose bars grow left (negative) or right (positive) from a shared
 * centre, so sign is readable at a glance rather than inferred from a number.
 */
function divergingRows(parent: HTMLElement, slices: Slice[]): void {
	const wrap = parent.createDiv({ cls: "jt-bars" });
	for (const slice of slices) {
		const row = wrap.createDiv({ cls: "jt-bar-row" });
		const label = row.createDiv({ cls: "jt-bar-label", text: slice.label });
		label.setAttribute("aria-label", `${slice.label}, ${slice.count} entries`);

		const track = row.createDiv({ cls: "jt-diverging-track" });
		track.createDiv({ cls: "jt-diverging-axis" });
		const bar = track.createDiv({
			cls: `jt-diverging-inline ${slice.average >= 0 ? "is-positive" : "is-negative"}`,
		});
		// Half the track is each polarity, so a |5| average fills its side.
		bar.style.width = `${(Math.abs(slice.average) / 5) * 50}%`;

		const value = row.createDiv({ cls: "jt-bar-value" });
		value.setText(`${slice.average > 0 ? "+" : ""}${slice.average}`);
		const count = value.createSpan({
			cls: slice.count < THIN_SAMPLE ? "jt-count is-thin" : "jt-count",
			text: ` n=${slice.count}`,
		});
		count.setAttribute("aria-label", `${slice.count} entries`);
	}
}

function fact(parent: HTMLElement, label: string, value: string): void {
	const row = parent.createDiv({ cls: "jt-fact" });
	row.createSpan({ cls: "jt-fact-label", text: label });
	row.createSpan({ cls: "jt-fact-value", text: value });
}

function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
