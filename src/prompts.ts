import { ChatMessage } from "./llm/provider";
import { RetrievedMemory } from "./memory/store";
import { Cadence, JournalPluginSettings, NarrativeVoice } from "./settings";

const CADENCE_FRAMING: Record<Cadence, string> = {
	weekly: "You are reading the client's raw daily journal entries for one week.",
	biweekly:
		"You are reading two weekly therapeutic summaries you previously wrote for this client. Synthesize across them: what carried over, what changed, what resolved. Do not simply concatenate the two.",
	monthly:
		"You are reading the weekly therapeutic summaries you previously wrote for this client across one calendar month. Zoom out: identify the month's arc, the throughlines, and what has shifted since earlier periods.",
	yearly:
		"You are reading the monthly therapeutic summaries you previously wrote for this client across one calendar year. Zoom far out: identify the year's overall arc, the major turning points, what changed from January to December, and the throughlines connecting the months. This is a longer-lens reflection than the monthly summaries — favor the client's growth and patterns over the year rather than any single month's detail.",
};

/** Human-readable meaning of each directness step, shown next to the slider. */
export const DIRECTNESS_LABELS: Record<number, string> = {
	1: "Very gentle — tentative and heavily softened; offers possibilities, never conclusions.",
	2: "Gentle — warm and cautious; hedges before naming anything difficult.",
	3: "Balanced — warm, but willing to name a pattern plainly.",
	4: "Direct — names patterns and contradictions with little hedging.",
	5: "Very direct — blunt; challenges avoidance and says the hard thing outright.",
};

/** Human-readable meaning of each brevity step, shown next to the slider. */
export const BREVITY_LABELS: Record<number, string> = {
	1: "Very expansive — follows every thread in depth (~900-1300 words).",
	2: "Detailed — thorough, with room to develop ideas (~600-900 words).",
	3: "Balanced — substantial but focused (~400-600 words).",
	4: "Concise — only the observations that earn their place (~250-350 words).",
	5: "Very brief — tight and essential, minimal elaboration (~120-200 words).",
};

const DIRECTNESS_DIRECTIVE: Record<number, string> = {
	1: "Be exceptionally gentle. Frame every observation as a tentative possibility the client may or may not recognise (\"I wonder whether…\", \"it's possible that…\"). Never state a conclusion about them as fact.",
	2: "Be gentle. Soften difficult observations and lead into them carefully, but do still make them.",
	3: "Be warm but clear. Name patterns plainly once you have evidence for them, without either bluntness or excessive hedging.",
	4: "Be direct. Name patterns, contradictions and avoidance explicitly and with minimal hedging. Do not soften an observation you have real evidence for.",
	5: "Be very direct and unsparing. Say the thing that is difficult to hear. Name self-deception, avoidance and contradiction outright, and challenge comfortable stories the client is telling themselves. Stay respectful and never contemptuous — the bluntness is in service of clarity, not judgement.",
};

const BREVITY_DIRECTIVE: Record<number, string> = {
	1: "Write expansively, roughly 900-1300 words. Follow threads in depth and develop each observation fully.",
	2: "Write a detailed reflection, roughly 600-900 words.",
	3: "Write roughly 400-600 words: substantial, but every paragraph earning its place.",
	4: "Be concise: roughly 250-350 words. Keep only the observations with the most weight, and cut all preamble.",
	5: "Be very brief: roughly 120-200 words. Essential observations only, tightly written, no preamble and no restating of events.",
};

function clampStep(value: number): number {
	if (!Number.isFinite(value)) return 3;
	return Math.min(5, Math.max(1, Math.round(value)));
}

function voiceDirective(voice: NarrativeVoice, name: string): string {
	switch (voice) {
		case "first":
			return `Write the reflection in the FIRST PERSON, as though ${
				name || "the client"
			} were writing it about themselves — "I noticed I kept…", "what I was avoiding was…". The insight is yours; the voice is theirs. Never refer to "the client" or "you" in the output.`;
		case "third":
			return name
				? `Write the reflection in the THIRD PERSON, referring to the client by name as ${name} — "${name} spent much of this week…". Do not address them as "you".`
				: `Write the reflection in the THIRD PERSON, referring to the client as "they" — "they spent much of this week…". Do not address them as "you".`;
		case "second":
		default:
			return `Write the reflection in the SECOND PERSON, addressing the client directly as "you" — "you spent much of this week…".`;
	}
}

export interface StyleOptions {
	/**
	 * Apply the brevity word-count target. Off for callers that specify their
	 * own length (the portrait), where a global target would fight it.
	 */
	includeLength?: boolean;
}

/**
 * Voice, tone, length and format rules, appended to whichever lens is in use.
 *
 * Kept out of the prompt presets themselves so that switching lenses (or a
 * user rewriting one) can never drop the formatting contract that
 * `writeSummary` depends on.
 */
export function buildStyleDirectives(
	settings: JournalPluginSettings,
	options: StyleOptions = {}
): string {
	const { includeLength = true } = options;
	const name = settings.clientName.trim();
	const parts: string[] = [];

	if (name) {
		parts.push(
			`The client's name is ${name}. Use it to tell them apart from the other people they write about; those others are not the client.`
		);
	}

	parts.push(voiceDirective(settings.narrativeVoice, name));
	parts.push(DIRECTNESS_DIRECTIVE[clampStep(settings.directness)]);
	if (includeLength) parts.push(BREVITY_DIRECTIVE[clampStep(settings.brevity)]);
	parts.push(
		`Write in Markdown. Do not wrap the response in a code fence, do not include YAML frontmatter, and do not open with a title heading — one is added automatically. These ${
			includeLength ? "length, voice and tone" : "voice and tone"
		} rules override any conflicting instruction above.`
	);

	return `## How to write this\n\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

function renderMemory(memory: RetrievedMemory): string {
	const blocks: string[] = [];

	if (memory.core.trim()) {
		blocks.push(
			`## Core memory (stable, long-running context about this client)\n${memory.core.trim()}`
		);
	}
	if (memory.semantic.length) {
		const facts = memory.semantic.map((f) => `- ${f.text}`).join("\n");
		blocks.push(`## Relevant known facts\n${facts}`);
	}
	if (memory.episodic.length) {
		const episodes = memory.episodic
			.map((e) => `### ${e.key} (${e.cadence})\n${e.text.slice(0, 1500)}`)
			.join("\n\n");
		blocks.push(`## Relevant past summaries\n${episodes}`);
	}

	if (!blocks.length) return "";
	return `Background you already hold about this client. Use it to notice continuity and change; do not quote it back verbatim.\n\n${blocks.join("\n\n")}`;
}

/** First of the two calls per run: the actual therapeutic synthesis. */
export function buildSynthesisMessages(
	settings: JournalPluginSettings,
	cadence: Cadence,
	periodKey: string,
	body: string,
	memory: RetrievedMemory,
	moodContext = ""
): ChatMessage[] {
	// Style goes in its own system message, after the lens, so its overrides
	// read as the later and more specific instruction.
	const messages: ChatMessage[] = [
		{ role: "system", content: settings.therapistSystemPrompt },
		{ role: "system", content: buildStyleDirectives(settings) },
	];

	const memoryBlock = renderMemory(memory);
	if (memoryBlock) messages.push({ role: "system", content: memoryBlock });

	// Measured mood data goes in as its own block, framed as corroboration
	// rather than instruction — the reading of the entries stays primary.
	const mood = moodContext.trim()
		? `\n\n${moodContext}\n\nTreat this as a second opinion to weigh against your own reading, not as ground truth.`
		: "";

	messages.push({
		role: "user",
		content: `${CADENCE_FRAMING[cadence]}\n\nPeriod: ${periodKey}\n\n${body}${mood}\n\nWrite your reflection below, following the style rules given above.`,
	});

	return messages;
}

/**
 * Second call: consolidate core memory and extract durable facts. Kept
 * separate from synthesis so the summary the user reads is never shaped by
 * bookkeeping instructions.
 */
export function buildMemoryManagerMessages(
	cadence: Cadence,
	periodKey: string,
	summary: string,
	currentCore: string,
	maxChars: number
): ChatMessage[] {
	return [
		{
			role: "system",
			content: `You are the memory manager for a journaling assistant. You maintain two things:

1. CORE MEMORY — a compact, always-loaded profile of the client: stable traits, ongoing relationships, recurring struggles, current life situation, active goals. It must stay under ${maxChars} characters. Rewrite it in full each time: merge new information in, drop what is stale or superseded, keep it dense and factual. No preamble, no headings deeper than "##".

2. SEMANTIC FACTS — discrete, durable, self-contained statements worth remembering independently (e.g. "Works as a data engineer; started a new role in March 2026"). Not moods, not one-off events, not anything already captured in core memory. Return 0-8 of them; returning none is fine.

Respond with a single JSON object and nothing else:
{"core_memory": "<full rewritten core memory>", "semantic_facts": ["fact", "..."]}`,
		},
		{
			role: "user",
			content: `Current core memory:
"""
${currentCore || "(empty)"}
"""

New ${cadence} summary for ${periodKey}:
"""
${summary}
"""

Return the updated JSON.`,
		},
	];
}

export interface MemoryManagerResult {
	coreMemory: string;
	semanticFacts: string[];
}

/** Tolerant parse — models wrap JSON in prose or fences more often than not. */
export function parseMemoryManagerResponse(raw: string): MemoryManagerResult | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
	const candidates = [fenced?.[1], raw].filter((c): c is string => Boolean(c));

	for (const candidate of candidates) {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start === -1 || end <= start) continue;
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
			const core = parsed.core_memory;
			const facts = parsed.semantic_facts;
			return {
				coreMemory: typeof core === "string" ? core : "",
				semanticFacts: Array.isArray(facts) ? facts.map(String) : [],
			};
		} catch {
			continue;
		}
	}
	return null;
}
