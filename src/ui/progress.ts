import { Notice } from "obsidian";

/**
 * What long-running work needs from the UI, without depending on it — so the
 * pipeline stays testable and unaware of Obsidian's Notice.
 */
export interface RunProgress {
	/** Checked between units of work; set by the Cancel button. */
	readonly cancelled: boolean;
	/** Completes one unit and optionally updates the detail line. */
	advance(detail?: string): void;
	/** Updates the detail line without completing a unit. */
	detail(text: string): void;
	/** Adjusts the total when the real amount of work becomes known. */
	setTotal(total: number): void;
}

/** A no-op implementation, for callers that don't want UI. */
export const SILENT_PROGRESS: RunProgress = {
	cancelled: false,
	advance: () => undefined,
	detail: () => undefined,
	setTotal: () => undefined,
};

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A persistent Notice with a progress bar, live detail line, running ETA and a
 * Cancel button. Stays put until the work finishes or is cancelled.
 */
export class ProgressReporter implements RunProgress {
	private notice: Notice;
	private fillEl: HTMLElement;
	private countEl: HTMLElement;
	private etaEl: HTMLElement;
	private detailEl: HTMLElement;
	private titleEl: HTMLElement;

	private completed = 0;
	private total = 0;
	private startedAt = Date.now();
	private cancelledFlag = false;

	constructor(title: string, total = 0) {
		this.total = total;
		// Duration 0 keeps the notice up until we hide it ourselves.
		this.notice = new Notice("", 0);
		const root = this.notice.messageEl;
		root.empty();
		root.addClass("jt-progress");

		const head = root.createDiv({ cls: "jt-progress-head" });
		this.titleEl = head.createSpan({ cls: "jt-progress-title", text: title });
		const cancel = head.createEl("button", {
			cls: "jt-progress-cancel",
			text: "Cancel",
		});
		cancel.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.cancelledFlag = true;
			cancel.setText("Stopping…");
			cancel.setAttribute("disabled", "true");
			this.detail("finishing the current step, then stopping");
		});

		const track = root.createDiv({ cls: "jt-progress-track" });
		this.fillEl = track.createDiv({ cls: "jt-progress-fill" });

		const meta = root.createDiv({ cls: "jt-progress-meta" });
		this.countEl = meta.createSpan({ cls: "jt-progress-count" });
		this.etaEl = meta.createSpan({ cls: "jt-progress-eta" });

		this.detailEl = root.createDiv({ cls: "jt-progress-detail", text: "starting…" });
		this.paint();
	}

	get cancelled(): boolean {
		return this.cancelledFlag;
	}

	setTitle(title: string): void {
		this.titleEl.setText(title);
	}

	setTotal(total: number): void {
		this.total = Math.max(total, this.completed);
		this.paint();
	}

	advance(detail?: string): void {
		this.completed++;
		if (detail) this.detailEl.setText(detail);
		this.paint();
	}

	detail(text: string): void {
		this.detailEl.setText(text);
	}

	private paint(): void {
		if (this.total > 0) {
			const pct = Math.min(100, (this.completed / this.total) * 100);
			this.fillEl.setCssStyles({ width: `${pct}%` });
			this.fillEl.removeClass("is-indeterminate");
			this.countEl.setText(`${this.completed} / ${this.total}`);
		} else {
			// Unknown total: show motion rather than a misleading percentage.
			// Width is set by the is-indeterminate CSS class, not inline here.
			this.fillEl.addClass("is-indeterminate");
			this.countEl.setText(`${this.completed} done`);
		}

		const elapsed = Date.now() - this.startedAt;
		// Two samples before estimating — the first call is unrepresentative
		// because it includes model load time.
		if (this.total > 0 && this.completed >= 2 && this.completed < this.total) {
			const perUnit = elapsed / this.completed;
			const remaining = (this.total - this.completed) * perUnit;
			this.etaEl.setText(`~${formatDuration(remaining)} left`);
		} else if (this.completed > 0) {
			this.etaEl.setText(formatDuration(elapsed));
		} else {
			this.etaEl.setText("");
		}
	}

	/** Replaces the panel with a short-lived summary. */
	finish(summary: string, isError = false): void {
		this.notice.hide();
		new Notice(summary, isError ? 15_000 : 8_000);
	}

	hide(): void {
		this.notice.hide();
	}

	get elapsed(): number {
		return Date.now() - this.startedAt;
	}
}
