import { DEFAULT_PRESET_ID, findPreset } from "./promptPresets";

export type Backend = "local" | "openrouter";
export type TagMatchMode = "frontmatter" | "inline" | "both";
export type Cadence = "weekly" | "biweekly" | "monthly" | "yearly";
/** Whose voice the summary is written in. */
export type NarrativeVoice = "first" | "second" | "third";

export interface JournalPluginSettings {
	// --- Backend ---
	backend: Backend;
	localServerUrl: string;
	/** Blank = whatever the server currently has loaded. */
	localModel: string;
	openRouterApiKey: string;
	openRouterModel: string;

	// --- Source filtering ---
	sourceFolder: string;
	includeTags: string[];
	tagMatchMode: TagMatchMode;

	// --- Cadences ---
	enableWeekly: boolean;
	enableBiweekly: boolean;
	enableMonthly: boolean;
	enableYearly: boolean;

	// --- Output ---
	outputFolder: string;

	// --- Prompt customization ---
	/** Preset id the prompt came from, or "custom" once edited by hand. */
	promptPresetId: string;
	therapistSystemPrompt: string;

	// --- Voice & tone (appended to whichever prompt is in use) ---
	narrativeVoice: NarrativeVoice;
	/** Optional; helps the model tell the author apart from people they write about. */
	clientName: string;
	/** 1 = very gentle and hedged, 5 = blunt and challenging. */
	directness: number;
	/** 1 = very brief, 5 = very expansive. */
	length: number;

	// --- Mood classification (one LLM call per journal entry) ---
	enableMoodClassification: boolean;

	// --- Embeddings (retrieval only; independent of the generation backend) ---
	embeddingServerUrl: string;
	embeddingModel: string;

	// --- Memory ---
	coreMemoryMaxChars: number;
	semanticTopK: number;
	episodicTopK: number;

	// --- Trigger behavior ---
	autoCheckIntervalMinutes: number;
	autoRunWithoutConfirmation: boolean;
}

/**
 * The default lens. Voice, tone, length and Markdown rules are no longer part
 * of the prompt text — they're generated from the voice/tone settings and
 * appended at build time, so switching presets never loses them.
 */
export const DEFAULT_THERAPIST_PROMPT = findPreset(DEFAULT_PRESET_ID)!.prompt;

export const DEFAULT_SETTINGS: JournalPluginSettings = {
	backend: "local",
	// Any OpenAI-compatible chat-completions server works here (LM Studio,
	// llama.cpp's server, Ollama's OpenAI-compat endpoint, mlx-openai-server,
	// ...) — 8000 is just a common default, not a requirement.
	localServerUrl: "http://localhost:8000/v1/chat/completions",
	// Blank = single-model server; only needed when one server routes several
	// models by name. Never assume the author's own served_model_name here.
	localModel: "",
	openRouterApiKey: "",
	openRouterModel: "anthropic/claude-sonnet-4.6",

	// "/" = whole vault (normalized the same as blank by inSourceFolder).
	sourceFolder: "/",
	includeTags: ["journal"],
	tagMatchMode: "both",

	enableWeekly: true,
	enableBiweekly: false,
	enableMonthly: false,
	enableYearly: false,

	outputFolder: "Confidant",

	promptPresetId: DEFAULT_PRESET_ID,
	therapistSystemPrompt: DEFAULT_THERAPIST_PROMPT,

	narrativeVoice: "first",
	clientName: "",
	directness: 3,
	length: 3,

	enableMoodClassification: true,

	embeddingServerUrl: "http://localhost:8000/v1/embeddings",
	embeddingModel: "",

	coreMemoryMaxChars: 2000,
	semanticTopK: 5,
	episodicTopK: 3,

	autoCheckIntervalMinutes: 0,
	autoRunWithoutConfirmation: false,
};

/** Subfolder name under `outputFolder` for each cadence. Fixed, not configurable. */
export const CADENCE_FOLDER: Record<Cadence, string> = {
	weekly: "Weekly",
	biweekly: "Biweekly",
	monthly: "Monthly",
	yearly: "Yearly",
};
