import { ChatMessage } from "../llm/provider";
import {
	AROUSAL_VALUES,
	Arousal,
	PRIMARY_EMOTIONS,
	PrimaryEmotion,
	SLEEP_VALUES,
	SOCIAL_CONTACT_VALUES,
	SleepQuality,
	SocialContact,
} from "./types";

export interface RawMoodFields {
	primaryEmotion: PrimaryEmotion;
	secondaryEmotions: string[];
	valence: number;
	arousal: Arousal;
	topics: string[];
	sleepMentioned: boolean;
	sleepQuality: SleepQuality | null;
	socialContact: SocialContact;
	notableEvent: boolean;
	summary: string;
	confidence: number;
}

export function buildMoodMessages(entryText: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `You extract structured mood data from personal journal entries for later quantitative analysis.

Respond with ONLY a single valid JSON object. No preamble, no explanation, no markdown code fences, no text before or after the JSON.

Use exactly this schema:
{
  "primary_emotion": one of ${JSON.stringify(PRIMARY_EMOTIONS)},
  "secondary_emotions": [0-3 more emotions from that same list, or []],
  "valence": integer from -5 (very negative) to 5 (very positive),
  "arousal": one of ${JSON.stringify(AROUSAL_VALUES)} (energised/activated versus calm/flat),
  "topics": [short lowercase tags, e.g. "work", "health", "family", "finance", "travel", "hobbies", "relationships"],
  "sleep_mentioned": true or false,
  "sleep_quality": one of ${JSON.stringify(SLEEP_VALUES)}, or null if not mentioned,
  "social_contact": one of ${JSON.stringify(SOCIAL_CONTACT_VALUES)},
  "notable_event": true or false (was there a significant or unusual event),
  "summary": one plain-English sentence, max 25 words, capturing the gist of the day,
  "confidence": float 0.0-1.0 for how confident you are given the entry's clarity and length
}

If the entry is very short or ambiguous, still give your best judgment and lower the confidence accordingly.`,
		},
		{
			role: "user",
			content: `Journal entry:\n\n${entryText}\n\nJSON object:`,
		},
	];
}

/** Pull the outermost JSON object out of the response, tolerating fences/prose. */
export function extractMoodJson(raw: string): Record<string, unknown> | null {
	let text = raw.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	if (fenced) text = fenced[1].trim();

	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last <= first) return null;

	try {
		const parsed: unknown = JSON.parse(text.slice(first, last + 1));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function stringList(value: unknown, limit?: number): string[] {
	if (!Array.isArray(value)) return [];
	const out = value
		.filter((v) => typeof v === "string" || typeof v === "number")
		.map((v) => String(v).toLowerCase().trim())
		.filter(Boolean);
	return limit ? out.slice(0, limit) : out;
}

/**
 * Coerce every field into range so a malformed generation can't quietly
 * corrupt the dataset — the whole point of the store is that it's chartable.
 */
export function validateMoodFields(record: Record<string, unknown>): RawMoodFields {
	const emotion = record.primary_emotion;
	const primaryEmotion: PrimaryEmotion =
		typeof emotion === "string" && (PRIMARY_EMOTIONS as readonly string[]).includes(emotion)
			? (emotion as PrimaryEmotion)
			: "unclear";

	const secondaryEmotions = stringList(record.secondary_emotions, 3).filter((e) =>
		(PRIMARY_EMOTIONS as readonly string[]).includes(e)
	);

	let valence = Number(record.valence);
	valence = Number.isFinite(valence) ? Math.max(-5, Math.min(5, Math.round(valence))) : 0;

	let confidence = Number(record.confidence);
	confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5;

	const sleepQuality = oneOf(record.sleep_quality, SLEEP_VALUES, null as unknown as SleepQuality);

	return {
		primaryEmotion,
		secondaryEmotions,
		valence,
		arousal: oneOf(record.arousal, AROUSAL_VALUES, "medium"),
		topics: stringList(record.topics),
		sleepMentioned: Boolean(record.sleep_mentioned),
		// Treat an out-of-vocabulary sleep value as "not mentioned" rather than guessing.
		sleepQuality: (SLEEP_VALUES as readonly string[]).includes(String(record.sleep_quality))
			? sleepQuality
			: null,
		socialContact: oneOf(record.social_contact, SOCIAL_CONTACT_VALUES, "unclear"),
		notableEvent: Boolean(record.notable_event),
		summary: typeof record.summary === "string" ? record.summary.trim() : "",
		confidence,
	};
}
