import {
	App,
	DropdownComponent,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	Notice,
} from "obsidian";
import type ConfidantPlugin from "../main";
import { NarrativeVoice, TagMatchMode } from "../settings";
import { LENGTH_LABELS, DIRECTNESS_LABELS } from "../prompts";
import { CUSTOM_PRESET_ID, PROMPT_PRESETS, detectPresetId, findPreset } from "../promptPresets";
import { FolderSuggest } from "./folderSuggest";

export class ConfidantSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ConfidantPlugin) {
		super(app, plugin);
	}

	/**
	 * Declarative settings (Obsidian 1.13+): return the row definitions and
	 * the framework renders and search-indexes them, instead of us building
	 * the DOM ourselves in an overridden display(). Every row here still uses
	 * the `render` escape hatch rather than the fully declarative `control`
	 * binding, because most rows need something the pure declarative form
	 * doesn't give a hook for — a dynamic description, a side effect on
	 * change, conditional fields, or an async action button — so `render`
	 * (which just hands us the same imperative `Setting` API as before) is
	 * the lower-risk fit for this shape of settings tab.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const items: SettingDefinitionItem[] = [];
		const row = (name: string, render: (setting: Setting) => void, desc?: string) => {
			items.push({ name, desc, render });
		};

		// ---------------- Backend ----------------
		row("Backend", (setting) => setting.setHeading());

		row(
			"LLM backend",
			(setting) =>
				setting
					.setName("LLM backend")
					.setDesc(
						"Where summary generation runs. Local needs a server of your own already running; OpenRouter needs only an API key."
					)
					.addDropdown((d) =>
						d
							.addOption("local", "Local server (any OpenAI-compatible endpoint)")
							.addOption("openrouter", "OpenRouter")
							.setValue(s.backend)
							.onChange(async (v) => {
								s.backend = v as typeof s.backend;
								await save();
								this.update();
							})
					),
			"Where summary generation runs."
		);

		if (s.backend === "local") {
			row("Local server URL", (setting) =>
				setting
					.setName("Local server URL")
					.setDesc(
						"Any OpenAI-compatible chat-completions endpoint: LM Studio, llama.cpp's server, Ollama's OpenAI-compat endpoint, mlx-openai-server, etc. Port 8000 below is just a common default, not a requirement."
					)
					.addText((t) =>
						t
							.setPlaceholder("http://localhost:8000/v1/chat/completions")
							.setValue(s.localServerUrl)
							.onChange(async (v) => {
								s.localServerUrl = v.trim();
								await save();
							})
					)
			);

			row("Local model", (setting) =>
				setting
					.setName("Local model")
					.setDesc(
						"Leave blank if your server only has one model loaded. Fill in the model name only when one server routes multiple models by name (e.g. mlx-openai-server's multi-model config, or LM Studio with several models loaded) — leaving it blank there sends requests to whichever model the server picks, which may not be the one you want."
					)
					.addText((t) =>
						t
							.setPlaceholder("(blank = single-model server)")
							.setValue(s.localModel)
							.onChange(async (v) => {
								s.localModel = v.trim();
								await save();
							})
					)
			);
		} else {
			row("OpenRouter API key", (setting) =>
				setting.setName("OpenRouter API key").addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder("sk-or-...")
						.setValue(s.openRouterApiKey)
						.onChange(async (v) => {
							s.openRouterApiKey = v.trim();
							await save();
						});
				})
			);

			row("OpenRouter model", (setting) =>
				setting
					.setName("OpenRouter model")
					.addText((t) =>
						t
							.setPlaceholder("anthropic/claude-sonnet-4.6")
							.setValue(s.openRouterModel)
							.onChange(async (v) => {
								s.openRouterModel = v.trim();
								await save();
							})
					)
			);
		}

		row(
			"Test connection",
			(setting) =>
				setting
					.setName("Test connection")
					.setDesc("Sends a one-token prompt to the configured backend.")
					.addButton((b) =>
						b.setButtonText("Test").onClick(async () => {
							b.setDisabled(true).setButtonText("Testing…");
							try {
								await this.plugin.testConnection();
								new Notice("Confidant: backend reachable.");
							} catch (err) {
								new Notice(
									`Confidant: ${err instanceof Error ? err.message : String(err)}`,
									8000
								);
							} finally {
								b.setDisabled(false).setButtonText("Test");
							}
						})
					),
			"Sends a one-token prompt to the configured backend."
		);

		// ---------------- Source ----------------
		row("Source", (setting) => setting.setHeading());

		row(
			"Source folder",
			(setting) => {
				setting
					.setName("Source folder")
					.setDesc(
						"Vault-relative folder holding your daily notes, searched recursively. A note qualifies if it has a date, from frontmatter `date:` or a YYYY-MM-DD filename. Leave blank to scan your ENTIRE vault for dated notes — most people should set this to their daily-notes folder instead."
					)
					.addText((t) => {
						t.setPlaceholder("e.g. Journal/Daily")
							.setValue(s.sourceFolder)
							.onChange(async (v) => {
								s.sourceFolder = v.trim();
								await save();
							});
						new FolderSuggest(this.app, t.inputEl, (path) => {
							s.sourceFolder = path;
							void save();
						});
					});
			},
			"Vault-relative folder holding your daily notes."
		);

		row(
			"Include tags",
			(setting) =>
				setting
					.setName("Include tags")
					.setDesc(
						"Comma-separated, without the #. A note qualifies if it has ANY of them. Leave empty to include every note in the source folder."
					)
					.addText((t) =>
						t
							.setPlaceholder("journal, daily-log")
							.setValue(s.includeTags.join(", "))
							.onChange(async (v) => {
								s.includeTags = v
									.split(",")
									.map((x) => x.trim().replace(/^#/, ""))
									.filter(Boolean);
								await save();
							})
					),
			"Which tags qualify a note as a journal entry."
		);

		row("Tag match mode", (setting) =>
			setting.setName("Tag match mode").addDropdown((d) =>
				d
					.addOption("frontmatter", "Frontmatter tags only")
					.addOption("inline", "Inline #tags only")
					.addOption("both", "Either")
					.setValue(s.tagMatchMode)
					.onChange(async (v) => {
						s.tagMatchMode = v as TagMatchMode;
						await save();
					})
			)
		);

		// ---------------- Cadences ----------------
		row(
			"Cadences",
			(setting) =>
				setting
					.setDesc(
						"Biweekly and monthly summaries are rollups of weekly summaries; yearly is a rollup of monthly summaries. None re-read the raw entries directly, and each only generates once every summary it depends on exists."
					)
					.setHeading(),
			"Biweekly and monthly summaries are rollups of weekly summaries; yearly is a rollup of monthly summaries."
		);

		row("Weekly", (setting) =>
			setting.setName("Weekly").addToggle((t) =>
				t.setValue(s.enableWeekly).onChange(async (v) => {
					s.enableWeekly = v;
					await save();
				})
			)
		);
		row(
			"Biweekly",
			(setting) =>
				setting
					.setName("Biweekly")
					.setDesc("Weeks 1-2 → BW01, weeks 3-4 → BW02, and so on.")
					.addToggle((t) =>
						t.setValue(s.enableBiweekly).onChange(async (v) => {
							s.enableBiweekly = v;
							await save();
						})
					),
			"Weeks 1-2 → BW01, weeks 3-4 → BW02, and so on."
		);
		row(
			"Monthly",
			(setting) =>
				setting
					.setName("Monthly")
					.setDesc("Every ISO week whose Thursday falls in that calendar month.")
					.addToggle((t) =>
						t.setValue(s.enableMonthly).onChange(async (v) => {
							s.enableMonthly = v;
							await save();
						})
					),
			"Every ISO week whose Thursday falls in that calendar month."
		);
		row(
			"Yearly",
			(setting) =>
				setting
					.setName("Yearly")
					.setDesc("Rolls up every monthly summary in a calendar year. Only generates once the year has ended.")
					.addToggle((t) =>
						t.setValue(s.enableYearly).onChange(async (v) => {
							s.enableYearly = v;
							await save();
						})
					),
			"Rolls up every monthly summary in a calendar year."
		);

		// ---------------- Output ----------------
		row("Output", (setting) => setting.setHeading());

		row(
			"Output folder",
			(setting) => {
				setting
					.setName("Output folder")
					.setDesc(
						"Weekly/, Biweekly/, Monthly/ and Yearly/ subfolders are created under this, each with year subfolders."
					)
					.addText((t) => {
						t.setPlaceholder("Confidant")
							.setValue(s.outputFolder)
							.onChange(async (v) => {
								s.outputFolder = v.trim();
								await save();
							});
						new FolderSuggest(this.app, t.inputEl, (path) => {
							s.outputFolder = path;
							void save();
						});
					});
			},
			"Where generated summaries are written."
		);

		// ---------------- Prompt ----------------
		row(
			"Reflection style",
			(setting) =>
				setting
					.setDesc(
						"Lenses adapted from established psychological and philosophical traditions. They shape how your journal is read — useful for reflection, but not a substitute for working with a professional."
					)
					.setHeading(),
			"Lenses adapted from established psychological and philosophical traditions."
		);

		let presetDropdown: DropdownComponent | null = null;

		row(
			"Framework",
			(setting) => {
				setting.setName("Framework");
				const preset = findPreset(s.promptPresetId);
				setting.setDesc(
					preset
						? preset.description
						: "Your own prompt. Pick a framework below to replace it (your text will be overwritten)."
				);
				setting.addDropdown((d) => {
					presetDropdown = d;
					for (const p of PROMPT_PRESETS) d.addOption(p.id, p.name);
					d.addOption(CUSTOM_PRESET_ID, "Custom (your own prompt)");
					d.setValue(s.promptPresetId).onChange(async (v) => {
						s.promptPresetId = v;
						const p = findPreset(v);
						if (p) s.therapistSystemPrompt = p.prompt;
						await save();
						this.update();
					});
				});
			},
			"Which reflection framework generates your summaries."
		);

		row(
			"System prompt",
			(setting) =>
				setting
					.setName("System prompt")
					.setDesc(
						"Sent as the system message for every synthesis call. Editing this switches the framework to Custom. Voice, tone, length and Markdown rules are added automatically from the settings below — you don't need to state them here."
					)
					.addTextArea((t) => {
						t.inputEl.rows = 14;
						t.inputEl.addClass("confidant-prompt");
						t.setValue(s.therapistSystemPrompt).onChange((v) => {
							s.therapistSystemPrompt = v;
							// Re-detect rather than always forcing Custom, so pasting a
							// preset's text back in re-attaches to that preset. No
							// update() here — a full re-render on every keystroke would
							// steal focus from the textarea mid-edit.
							s.promptPresetId = detectPresetId(v);
							presetDropdown?.setValue(s.promptPresetId);
							void save();
						});
					})
					.addExtraButton((b) =>
						b
							.setIcon("rotate-ccw")
							.setTooltip("Reset to the selected framework's original text")
							.onClick(async () => {
								const preset = findPreset(s.promptPresetId) ?? PROMPT_PRESETS[0];
								s.promptPresetId = preset.id;
								s.therapistSystemPrompt = preset.prompt;
								await save();
								this.update();
							})
					),
			"The system message sent for every synthesis call."
		);

		// ---------------- Voice & tone ----------------
		row(
			"Voice & tone",
			(setting) => setting.setDesc("Applied on top of whichever framework is selected above.").setHeading(),
			"Applied on top of whichever framework is selected above."
		);

		row(
			"Your name",
			(setting) =>
				setting
					.setName("Your name")
					.setDesc(
						"Optional. Helps the model tell you apart from the people you write about, and is used when the voice is set to third person."
					)
					.addText((t) =>
						t
							.setPlaceholder("e.g. Debayan")
							.setValue(s.clientName)
							.onChange(async (v) => {
								s.clientName = v.trim();
								await save();
							})
					),
			"Optional; helps the model tell you apart from people you write about."
		);

		row(
			"Voice",
			(setting) =>
				setting
					.setName("Voice")
					.setDesc(
						"First person reads as your own reflection; second addresses you as a therapist would; third describes you from the outside."
					)
					.addDropdown((d) =>
						d
							.addOption("first", "First person — \"I noticed I kept…\"")
							.addOption("second", "Second person — \"you spent this week…\"")
							.addOption("third", "Third person — \"they spent this week…\"")
							.setValue(s.narrativeVoice)
							.onChange(async (v) => {
								s.narrativeVoice = v as NarrativeVoice;
								await save();
							})
					),
			"Whether summaries are written in first, second or third person."
		);

		row(
			"Directness",
			(setting) => {
				setting.setName("Directness").setDesc(DIRECTNESS_LABELS[s.directness]);
				setting.addSlider((sl) =>
					sl
						.setLimits(1, 5, 1)
						.setValue(s.directness)
						.onChange(async (v) => {
							s.directness = v;
							setting.setDesc(DIRECTNESS_LABELS[v]);
							await save();
						})
				);
			},
			"How gently or bluntly patterns are named."
		);

		row(
			"Length",
			(setting) => {
				setting.setName("Length").setDesc(LENGTH_LABELS[s.length]);
				setting.addSlider((sl) =>
					sl
						.setLimits(1, 5, 1)
						.setValue(s.length)
						.onChange(async (v) => {
							s.length = v;
							setting.setDesc(LENGTH_LABELS[v]);
							await save();
						})
				);
			},
			"How long each generated summary is."
		);

		// ---------------- Mood ----------------
		row("Mood classification", (setting) => setting.setHeading());

		row(
			"Classify each entry",
			(setting) =>
				setting
					.setName("Classify each entry")
					.setDesc(
						"Extracts structured mood data (emotion, valence, energy, sleep, company, topics) per entry, powering the mood sections of the insights dashboard and feeding the weekly summary. Costs one LLM call per new or edited entry."
					)
					.addToggle((t) =>
						t.setValue(s.enableMoodClassification).onChange(async (v) => {
							s.enableMoodClassification = v;
							await save();
						})
					),
			"Extracts structured mood data per entry."
		);

		row(
			"Classified entries",
			(setting) =>
				setting
					.setName("Classified entries")
					.setDesc(
						`${this.plugin.mood.size} entry/entries have mood data. Re-classification happens only when an entry's text changes.`
					)
					.addButton((b) =>
						b.setButtonText("Classify now").onClick(async () => {
							await this.plugin.classifyMoods();
							this.update();
						})
					)
					.addButton((b) =>
						b
							.setButtonText("Clear mood data")
							.setDestructive()
							.onClick(async () => {
								await this.plugin.mood.clear();
								new Notice("Confidant: mood data cleared.");
								this.update();
							})
					),
			"How many entries have mood data."
		);

		// ---------------- Embeddings ----------------
		row(
			"Embeddings (optional)",
			(setting) =>
				setting
					.setDesc(
						"Powers semantic/episodic retrieval — extra context pulled into each summary. Entirely optional: generation works fine without it, and an unreachable or unconfigured embedding server just means summaries are written without that extra context, never a failure. Runs independently of the chat backend above, on its own OpenAI-compatible /v1/embeddings endpoint — any server that exposes one works (mlx-openai-server, LM Studio, an embeddings-capable llama.cpp build, etc.). There is no cloud option; leave this unconfigured if you don't want to run anything locally."
					)
					.setHeading(),
			"Powers optional semantic/episodic retrieval."
		);

		row(
			"Embedding server URL",
			(setting) =>
				setting
					.setName("Embedding server URL")
					.setDesc("OpenAI-compatible /v1/embeddings endpoint. Leave as-is (or blank) to skip retrieval entirely.")
					.addText((t) =>
						t
							.setPlaceholder("http://localhost:8000/v1/embeddings")
							.setValue(s.embeddingServerUrl)
							.onChange(async (v) => {
								s.embeddingServerUrl = v.trim();
								await save();
							})
					)
		);

		row(
			"Embedding model",
			(setting) =>
				setting
					.setName("Embedding model")
					.setDesc(
						"Leave blank if your server only has one embedding model loaded. Changing this invalidates stored vectors — run \"Rebuild memory embeddings\" afterwards."
					)
					.addText((t) =>
						t
							.setPlaceholder("(blank = single-model server)")
							.setValue(s.embeddingModel)
							.onChange(async (v) => {
								s.embeddingModel = v.trim();
								await save();
							})
					)
		);

		row("Test embeddings", (setting) =>
			setting.setName("Test embeddings").addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					try {
						const dims = await this.plugin.testEmbeddings();
						new Notice(`Confidant: embedding server OK (${dims} dimensions).`);
					} catch (err) {
						new Notice(
							`Confidant: ${err instanceof Error ? err.message : String(err)}`,
							10000
						);
					} finally {
						b.setDisabled(false).setButtonText("Test");
					}
				})
			)
		);

		// ---------------- Memory ----------------
		row(
			"Memory",
			(setting) =>
				setting
					.setDesc(`Core memory lives at ${this.plugin.memory.coreMemoryPath} and is safe to edit by hand.`)
					.setHeading(),
			"Three-tier memory: core, semantic facts, episodic summaries."
		);

		row(
			"Core memory max characters",
			(setting) =>
				setting.setName("Core memory max characters").addText((t) =>
					t.setValue(String(s.coreMemoryMaxChars)).onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n > 0) {
							s.coreMemoryMaxChars = Math.floor(n);
							await save();
						}
					})
				)
		);

		row("Semantic facts retrieved", (setting) =>
			setting.setName("Semantic facts retrieved").addSlider((sl) =>
				sl
					.setLimits(0, 20, 1)
					.setValue(s.semanticTopK)
					.onChange(async (v) => {
						s.semanticTopK = v;
						await save();
					})
			)
		);

		row("Past summaries retrieved", (setting) =>
			setting.setName("Past summaries retrieved").addSlider((sl) =>
				sl
					.setLimits(0, 10, 1)
					.setValue(s.episodicTopK)
					.onChange(async (v) => {
						s.episodicTopK = v;
						await save();
					})
			)
		);

		row(
			"Stored memories",
			(setting) => {
				const stats = this.plugin.memory.stats();
				const staleNote = stats.stale
					? ` ${stats.stale} need re-embedding (wrong or missing model) — run "Rebuild memory embeddings".`
					: "";
				setting
					.setName("Stored memories")
					.setDesc(`${stats.semantic} semantic fact(s), ${stats.episodic} past summary/summaries.${staleNote}`)
					.addButton((b) =>
						b.setButtonText("View in note").onClick(async () => {
							await this.plugin.dumpMemory();
						})
					)
					.addButton((b) =>
						b.setButtonText("Rebuild embeddings").onClick(async () => {
							await this.plugin.rebuildEmbeddings();
							this.update();
						})
					)
					.addButton((b) =>
						b
							.setButtonText("Clear semantic + episodic")
							.setDestructive()
							.onClick(async () => {
								await this.plugin.memory.clear();
								new Notice("Confidant: memory cleared (core memory file untouched).");
								this.update();
							})
					);
			},
			"How many semantic facts and past summaries are stored."
		);

		// ---------------- Triggers ----------------
		row("Triggers", (setting) => setting.setHeading());

		row(
			"Auto-check interval (minutes)",
			(setting) =>
				setting
					.setName("Auto-check interval (minutes)")
					.setDesc("0 disables the background check. Runs are never started by a file change alone.")
					.addText((t) =>
						t.setValue(String(s.autoCheckIntervalMinutes)).onChange(async (v) => {
							const n = Number(v);
							if (Number.isFinite(n) && n >= 0) {
								s.autoCheckIntervalMinutes = Math.floor(n);
								await save();
								this.plugin.restartAutoCheck();
							}
						})
					),
			"How often to check for pending summaries in the background."
		);

		row(
			"Run without confirmation",
			(setting) =>
				setting
					.setName("Run without confirmation")
					.setDesc(
						"Off: the interval check shows a notice with a Run button. On: pending summaries generate unattended."
					)
					.addToggle((t) =>
						t.setValue(s.autoRunWithoutConfirmation).onChange(async (v) => {
							s.autoRunWithoutConfirmation = v;
							await save();
						})
					),
			"Whether pending summaries generate unattended."
		);

		return items;
	}
}
