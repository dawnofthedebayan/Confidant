/**
 * Per-entry structured mood classification.
 *
 * The vocabulary is fixed here so the prompt, the validator and every
 * downstream aggregation agree on the same terms — a classifier that invents
 * new emotion labels produces data you can't chart.
 */

export const PRIMARY_EMOTIONS = [
	"happy",
	"content",
	"calm",
	"excited",
	"grateful",
	"sad",
	"anxious",
	"angry",
	"frustrated",
	"lonely",
	"stressed",
	"tired",
	"neutral",
	"mixed",
] as const;

/** `unclear` is a sentinel written by the validator, never offered to the model. */
export type PrimaryEmotion = (typeof PRIMARY_EMOTIONS)[number] | "unclear";

export const AROUSAL_VALUES = ["low", "medium", "high"] as const;
export type Arousal = (typeof AROUSAL_VALUES)[number];

export const SLEEP_VALUES = ["poor", "ok", "good"] as const;
export type SleepQuality = (typeof SLEEP_VALUES)[number];

export const SOCIAL_CONTACT_VALUES = ["alone", "with_others", "mixed", "unclear"] as const;
export type SocialContact = (typeof SOCIAL_CONTACT_VALUES)[number];

export interface MoodRecord {
	/** Vault-relative path — unique even when two folders share a basename. */
	path: string;
	filename: string;
	/** `YYYY-MM-DD`, resolved from frontmatter `date:` or the filename. */
	date: string;
	primaryEmotion: PrimaryEmotion;
	secondaryEmotions: string[];
	/** -5 (very negative) to 5 (very positive). */
	valence: number;
	arousal: Arousal;
	topics: string[];
	sleepMentioned: boolean;
	sleepQuality: SleepQuality | null;
	socialContact: SocialContact;
	notableEvent: boolean;
	summary: string;
	confidence: number;

	/**
	 * Hash of the note's content at classification time.
	 *
	 * The original script compared file mtimes, but iCloud rewrites mtimes when
	 * it redownloads a note — that would silently re-classify the entire corpus
	 * (one LLM call per entry) after any sync. Hashing the text re-runs only on
	 * a real edit.
	 */
	contentHash: string;
	classifiedAt: string;
	model: string;
}

/** Non-cryptographic content hash, for change detection only. */
export function contentHash(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
		h2 = Math.imul(h2 + c, 2246822519) >>> 0;
	}
	return `${h1.toString(36)}${h2.toString(36)}-${text.length.toString(36)}`;
}
