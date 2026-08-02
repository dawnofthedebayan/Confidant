import { App, getAllTags } from "obsidian";
import { DailyEntry, discoverDailyEntries } from "../journal/discovery";
import { isoWeeksInYear, weeklyKey } from "../journal/dates";
import { JournalPluginSettings } from "../settings";

/**
 * Corpus statistics over the journal, computed locally with no LLM involvement
 * so the dashboard works whether or not a model server is running.
 */

export interface EntryStat {
	path: string;
	basename: string;
	date: Date;
	year: number;
	week: number;
	words: number;
	sentences: number;
	questions: number;
	tags: string[];
}

export interface Counted {
	label: string;
	count: number;
}

export interface WeekVolume {
	key: string;
	entries: number;
	words: number;
}

export interface InsightMetrics {
	generatedAt: Date;

	// --- corpus ---
	entryCount: number;
	totalWords: number;
	meanWords: number;
	medianWords: number;
	minWords: number;
	maxWords: number;
	shortest: EntryStat | null;
	longest: EntryStat | null;

	// --- time ---
	firstDate: Date | null;
	lastDate: Date | null;
	spanDays: number;
	activeWeeks: number;
	silentWeeks: number;
	entriesPerActiveWeek: number;
	longestStreak: number;
	currentStreak: number;
	byDayOfWeek: number[]; // Mon..Sun
	byWeek: WeekVolume[];

	// --- voice ---
	avgSentenceLength: number;
	questionsPerEntry: number;
	pronouns: Counted[];
	selfReferenceRate: number; // self-words per 100 words

	// --- themes ---
	tags: Counted[];
	people: Counted[];
	domains: Counted[];
	topics: Counted[];
	topWords: Counted[];
}

// ---------------------------------------------------------------- text utils --

/** Reduce a note to prose: no frontmatter, code, link syntax, or tag markers. */
export function stripToProse(raw: string): string {
	return raw
		.replace(/^---[\s\S]*?\n---/, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/!\[\[[^\]]*\]\]/g, " ")
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/(^|\s)#[\w/-]+/g, " ")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/[*_~>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function countWords(prose: string): string[] {
	return prose.match(WORD) ?? [];
}

function countSentences(prose: string): number {
	const parts = prose.split(/[.!?]+(?=\s|$)/).filter((s) => s.trim().length > 0);
	// A note with no terminal punctuation is still one sentence.
	return Math.max(parts.length, prose.trim() ? 1 : 0);
}

const STOPWORDS = new Set(
	`a about above after again against all am an and any are aren't as at be because been before being below between
	both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further
	had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's
	i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on
	once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some
	such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've
	this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when
	when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've
	your yours yourself yourselves just really quite also get got getting go going went one two also like even still
	back much many lot bit thing things day today yesterday tomorrow time feel feeling felt was were being am`
		.split(/\s+/)
		.filter(Boolean)
);

const SELF_WORDS = new Set(["i", "i'm", "i've", "i'd", "i'll", "me", "my", "myself", "mine"]);
const WE_WORDS = new Set(["we", "we're", "we've", "we'd", "we'll", "us", "our", "ours", "ourselves"]);
const YOU_WORDS = new Set(["you", "you're", "you've", "you'd", "you'll", "your", "yours"]);
const THEY_WORDS = new Set([
	"he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "he's", "she's", "they're",
]);

// ---------------------------------------------------------------- aggregation --

function median(sorted: number[]): number {
	if (sorted.length === 0) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function topCounted(map: Map<string, number>, limit: number): Counted[] {
	return [...map.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
		.slice(0, limit);
}

function bump(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Consecutive ISO weeks containing at least one entry. Weeks are compared in
 * calendar order across year boundaries via each year's real week count.
 */
function streaks(weekKeys: Set<string>, entries: EntryStat[]): { longest: number; current: number } {
	if (entries.length === 0) return { longest: 0, current: 0 };

	const ordered: Array<{ year: number; week: number }> = [];
	const years = [...new Set(entries.map((e) => e.year))].sort();
	for (const year of years) {
		for (let week = 1; week <= isoWeeksInYear(year); week++) {
			ordered.push({ year, week });
		}
	}

	let longest = 0;
	let running = 0;
	let trailing = 0;
	for (const { year, week } of ordered) {
		if (weekKeys.has(weeklyKey(year, week))) {
			running++;
			longest = Math.max(longest, running);
			trailing = running;
		} else {
			running = 0;
			trailing = 0;
		}
	}
	return { longest, current: trailing };
}

export async function computeMetrics(
	app: App,
	settings: JournalPluginSettings
): Promise<InsightMetrics> {
	const grouped = discoverDailyEntries(app, settings);
	const flat: DailyEntry[] = [...grouped.values()].flat();

	const stats: EntryStat[] = [];
	const tagCounts = new Map<string, number>();
	const wordCounts = new Map<string, number>();
	const pronounCounts = new Map<string, number>();
	let selfWordTotal = 0;

	for (const entry of flat) {
		const raw = await app.vault.cachedRead(entry.file);
		const prose = stripToProse(raw);
		const words = countWords(prose);
		const lowered = words.map((w) => w.toLowerCase());

		for (const word of lowered) {
			if (SELF_WORDS.has(word)) {
				bump(pronounCounts, "I / me");
				selfWordTotal++;
			} else if (WE_WORDS.has(word)) bump(pronounCounts, "we / us");
			else if (YOU_WORDS.has(word)) bump(pronounCounts, "you");
			else if (THEY_WORDS.has(word)) bump(pronounCounts, "he / she / they");

			if (word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) {
				bump(wordCounts, word);
			}
		}

		const cache = app.metadataCache.getFileCache(entry.file);
		const tags = (cache ? getAllTags(cache) ?? [] : []).map((t) =>
			t.replace(/^#/, "").toLowerCase()
		);
		for (const tag of tags) bump(tagCounts, tag);

		stats.push({
			path: entry.file.path,
			basename: entry.file.basename,
			date: entry.date,
			year: entry.year,
			week: entry.week,
			words: words.length,
			sentences: countSentences(prose),
			questions: (prose.match(/\?/g) ?? []).length,
			tags,
		});
	}

	stats.sort((a, b) => a.date.getTime() - b.date.getTime());

	const wordSeries = stats.map((s) => s.words);
	const sortedWords = [...wordSeries].sort((a, b) => a - b);
	const totalWords = wordSeries.reduce((sum, n) => sum + n, 0);
	const totalSentences = stats.reduce((sum, s) => sum + s.sentences, 0);
	const totalQuestions = stats.reduce((sum, s) => sum + s.questions, 0);

	// Day-of-week, Monday-first to match ISO weeks.
	const byDayOfWeek = new Array<number>(7).fill(0);
	for (const s of stats) byDayOfWeek[(s.date.getUTCDay() + 6) % 7]++;

	const weekMap = new Map<string, WeekVolume>();
	for (const s of stats) {
		const key = weeklyKey(s.year, s.week);
		const existing = weekMap.get(key);
		if (existing) {
			existing.entries++;
			existing.words += s.words;
		} else {
			weekMap.set(key, { key, entries: 1, words: s.words });
		}
	}
	const byWeek = [...weekMap.values()].sort((a, b) => a.key.localeCompare(b.key));

	const first = stats[0]?.date ?? null;
	const last = stats[stats.length - 1]?.date ?? null;
	const spanDays =
		first && last ? Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1 : 0;
	// Calendar weeks the journal spans, versus weeks that actually have entries.
	const spannedWeeks = spanDays > 0 ? Math.ceil(spanDays / 7) : 0;
	const activeWeeks = byWeek.length;

	const { longest, current } = streaks(new Set(weekMap.keys()), stats);

	const withPrefix = (prefix: string): Counted[] =>
		[...tagCounts.entries()]
			.filter(([tag]) => tag.startsWith(prefix))
			.map(([tag, count]) => ({ label: tag.slice(prefix.length).replace(/-/g, " "), count }))
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

	return {
		generatedAt: new Date(),

		entryCount: stats.length,
		totalWords,
		meanWords: stats.length ? Math.round(totalWords / stats.length) : 0,
		medianWords: Math.round(median(sortedWords)),
		minWords: sortedWords[0] ?? 0,
		maxWords: sortedWords[sortedWords.length - 1] ?? 0,
		shortest: stats.length ? stats.reduce((a, b) => (b.words < a.words ? b : a)) : null,
		longest: stats.length ? stats.reduce((a, b) => (b.words > a.words ? b : a)) : null,

		firstDate: first,
		lastDate: last,
		spanDays,
		activeWeeks,
		silentWeeks: Math.max(spannedWeeks - activeWeeks, 0),
		entriesPerActiveWeek: activeWeeks ? Number((stats.length / activeWeeks).toFixed(1)) : 0,
		longestStreak: longest,
		currentStreak: current,
		byDayOfWeek,
		byWeek,

		avgSentenceLength: totalSentences ? Math.round(totalWords / totalSentences) : 0,
		questionsPerEntry: stats.length ? Number((totalQuestions / stats.length).toFixed(1)) : 0,
		pronouns: topCounted(pronounCounts, 6),
		selfReferenceRate: totalWords ? Number(((selfWordTotal / totalWords) * 100).toFixed(1)) : 0,

		tags: topCounted(tagCounts, 20),
		people: withPrefix("people/"),
		domains: withPrefix("domain/"),
		topics: withPrefix("topic/"),
		topWords: topCounted(wordCounts, 30),
	};
}
