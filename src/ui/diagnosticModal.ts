import { App, Modal } from "obsidian";
import { DiscoveryDiagnosis } from "../journal/diagnose";
import { PlannedRun } from "../pipeline";

export class DiagnosticModal extends Modal {
	constructor(
		app: App,
		private diagnosis: DiscoveryDiagnosis,
		private pending: PlannedRun[]
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("jt-diagnostic");

		contentEl.createEl("h2", { text: "What the plugin can see" });

		// --- pending work ---
		if (this.pending.length > 0) {
			const list = this.pending.map((r) => `${r.cadence} ${r.key}`).join(", ");
			this.line(contentEl, `${this.pending.length} pending`, list, "is-good");
		} else {
			this.line(contentEl, "Pending", "nothing to generate", "is-muted");
		}

		// --- filters in effect ---
		contentEl.createEl("h3", { text: "Filters in effect" });
		this.line(contentEl, "Source folder", this.diagnosis.sourceFolder);
		this.line(
			contentEl,
			"Include tags",
			this.diagnosis.includeTags.length
				? `${this.diagnosis.includeTags.join(", ")} (match: ${this.diagnosis.tagMatchMode})`
				: "(none — every dated note in the folder qualifies)"
		);

		// --- funnel ---
		contentEl.createEl("h3", { text: "Discovery funnel" });
		this.line(contentEl, "Markdown files in vault", String(this.diagnosis.markdownInVault));
		this.line(contentEl, "…inside source folder", String(this.diagnosis.markdownInFolder));
		this.line(
			contentEl,
			"…that qualify as entries",
			String(this.diagnosis.includedCount),
			this.diagnosis.includedCount > 0 ? "is-good" : "is-bad"
		);

		// --- exclusions, the actual answer most of the time ---
		this.exclusion(
			contentEl,
			"Excluded — no date found",
			this.diagnosis.noDate,
			"These have no `date:` in frontmatter and no YYYY-MM-DD in the filename, so they can't be placed in a week."
		);
		this.exclusion(
			contentEl,
			"Excluded — tag filter",
			this.diagnosis.tagFiltered,
			`These are dated but carry none of: ${this.diagnosis.includeTags.join(", ")}.`
		);
		this.exclusion(
			contentEl,
			"Not indexed yet",
			this.diagnosis.notIndexed,
			"Obsidian hasn't finished reading these, so their frontmatter and tags are invisible. Wait a moment and re-check."
		);

		// --- per-week tracking ---
		contentEl.createEl("h3", { text: "Weeks" });
		if (this.diagnosis.weeks.length === 0) {
			contentEl.createDiv({ cls: "jt-diag-note", text: "No weeks found." });
		} else {
			const table = contentEl.createEl("table", { cls: "jt-diag-table" });
			const head = table.createEl("tr");
			for (const h of ["Week", "Entries", "Recorded", "New since last run"]) {
				head.createEl("th", { text: h });
			}
			for (const week of this.diagnosis.weeks) {
				const row = table.createEl("tr");
				row.createEl("td", { text: week.key });
				row.createEl("td", { text: String(week.found) });
				row.createEl("td", { text: String(week.recorded) });
				const cell = row.createEl("td");
				if (week.unrecorded.length === 0) {
					cell.createSpan({ cls: "jt-diag-muted", text: "—" });
				} else {
					cell.createSpan({ cls: "jt-diag-good", text: week.unrecorded.join(", ") });
				}
			}
		}

		contentEl.createDiv({
			cls: "jt-diag-note",
			text:
				"Note: a week re-runs when it contains a filename not already recorded. Editing an existing entry without renaming it does not re-trigger that week.",
		});
	}

	private line(parent: HTMLElement, label: string, value: string, cls = ""): void {
		const row = parent.createDiv({ cls: "jt-diag-row" });
		row.createSpan({ cls: "jt-diag-label", text: label });
		row.createSpan({ cls: `jt-diag-value ${cls}`, text: value });
	}

	private exclusion(
		parent: HTMLElement,
		title: string,
		files: string[],
		explanation: string
	): void {
		if (files.length === 0) return;
		parent.createEl("h3", { text: `${title} (${files.length})` });
		parent.createDiv({ cls: "jt-diag-note", text: explanation });
		const list = parent.createEl("ul", { cls: "jt-diag-list" });
		for (const name of files.slice(0, 25)) list.createEl("li", { text: name });
		if (files.length > 25) {
			list.createEl("li", { text: `…and ${files.length - 25} more`, cls: "jt-diag-muted" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
