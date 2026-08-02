import { App, Modal, Setting } from "obsidian";
import type ConfidantPlugin from "../main";
import { Cadence, JournalPluginSettings } from "../settings";

const CADENCES: Cadence[] = ["weekly", "biweekly", "monthly", "yearly"];

const CADENCE_LABEL: Record<Cadence, string> = {
	weekly: "Weekly",
	biweekly: "Biweekly",
	monthly: "Monthly",
	yearly: "Yearly",
};

const CADENCE_DESC: Record<Cadence, string> = {
	weekly: "One summary per ISO week, from the raw daily entries.",
	biweekly: "Rolls up two weekly summaries.",
	monthly: "Rolls up the weekly summaries for a calendar month.",
	yearly: "Rolls up the monthly summaries for a calendar year.",
};

const ENABLE_SETTING: Record<Cadence, keyof JournalPluginSettings> = {
	weekly: "enableWeekly",
	biweekly: "enableBiweekly",
	monthly: "enableMonthly",
	yearly: "enableYearly",
};

/** Ribbon-triggered picker: choose a cadence, then run only that tier's pending work. */
export class CadencePickerModal extends Modal {
	constructor(app: App, private plugin: ConfidantPlugin) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("jt-cadence-picker");

		contentEl.createEl("h2", { text: "Generate journal summary" });
		contentEl.createDiv({
			cls: "jt-diag-note",
			text: "Choose a cadence. Only periods that are actually pending for it will be generated.",
		});

		for (const cadence of CADENCES) {
			const enabled = Boolean(this.plugin.settings[ENABLE_SETTING[cadence]]);
			new Setting(contentEl)
				.setName(CADENCE_LABEL[cadence])
				.setDesc(
					enabled
						? CADENCE_DESC[cadence]
						: `${CADENCE_DESC[cadence]} Disabled — enable it under Cadences in settings first.`
				)
				.addButton((b) =>
					b
						.setButtonText("Generate")
						.setCta()
						.setDisabled(!enabled)
						.onClick(() => {
							this.close();
							void this.plugin.run(cadence);
						})
				);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
