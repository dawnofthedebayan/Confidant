import { Counted } from "../insights/metrics";
import { MoodRecord } from "./types";

/** A grouped average, carrying its sample size so thin slices can be labelled. */
export interface Slice {
	label: string;
	average: number;
	count: number;
}

export interface MoodAggregate {
	count: number;
	avgValence: number;
	avgConfidence: number;
	notableEventRate: number;

	series: Array<{ date: string; valence: number; emotion: string; summary: string }>;
	emotions: Counted[];
	arousal: Counted[];
	social: Counted[];
	sleep: Counted[];
	topics: Counted[];

	/** Cross-cuts: the "so what" of the dataset. */
	valenceByWeekday: Slice[];
	valenceBySocial: Slice[];
	valenceBySleep: Slice[];
	valenceByArousal: Slice[];

	best: MoodRecord | null;
	worst: MoodRecord | null;

	/** Records below this confidence are counted but flagged in the UI. */
	lowConfidence: number;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LOW_CONFIDENCE = 0.4;

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function round1(n: number): number {
	return Number(n.toFixed(1));
}

function tally(values: string[]): Counted[] {
	const map = new Map<string, number>();
	for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
	return [...map.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Group records by a key, then average valence within each group. */
function sliceBy(
	records: MoodRecord[],
	key: (r: MoodRecord) => string | null,
	order?: string[]
): Slice[] {
	const groups = new Map<string, number[]>();
	for (const record of records) {
		const label = key(record);
		if (label === null) continue;
		const bucket = groups.get(label);
		if (bucket) bucket.push(record.valence);
		else groups.set(label, [record.valence]);
	}

	const slices = [...groups.entries()].map(([label, values]) => ({
		label,
		average: round1(mean(values)),
		count: values.length,
	}));

	if (order) {
		slices.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
	} else {
		slices.sort((a, b) => b.average - a.average);
	}
	return slices;
}

export function aggregateMood(records: MoodRecord[]): MoodAggregate {
	const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));

	if (sorted.length === 0) {
		return {
			count: 0,
			avgValence: 0,
			avgConfidence: 0,
			notableEventRate: 0,
			series: [],
			emotions: [],
			arousal: [],
			social: [],
			sleep: [],
			topics: [],
			valenceByWeekday: [],
			valenceBySocial: [],
			valenceBySleep: [],
			valenceByArousal: [],
			best: null,
			worst: null,
			lowConfidence: 0,
		};
	}

	return {
		count: sorted.length,
		avgValence: round1(mean(sorted.map((r) => r.valence))),
		avgConfidence: Number(mean(sorted.map((r) => r.confidence)).toFixed(2)),
		notableEventRate: Math.round(
			(sorted.filter((r) => r.notableEvent).length / sorted.length) * 100
		),

		series: sorted.map((r) => ({
			date: r.date,
			valence: r.valence,
			emotion: r.primaryEmotion,
			summary: r.summary,
		})),
		emotions: tally(sorted.map((r) => r.primaryEmotion)),
		arousal: tally(sorted.map((r) => r.arousal)),
		social: tally(sorted.map((r) => r.socialContact)),
		sleep: tally(
			sorted.filter((r) => r.sleepQuality !== null).map((r) => r.sleepQuality as string)
		),
		topics: tally(sorted.flatMap((r) => r.topics)).slice(0, 12),

		valenceByWeekday: sliceBy(
			sorted,
			(r) => {
				// Dates are stored as plain YYYY-MM-DD; parse as UTC so the
				// weekday doesn't shift with the viewer's timezone.
				const d = new Date(`${r.date}T00:00:00Z`);
				if (Number.isNaN(d.getTime())) return null;
				return WEEKDAYS[(d.getUTCDay() + 6) % 7];
			},
			WEEKDAYS
		),
		valenceBySocial: sliceBy(
			sorted.filter((r) => r.socialContact !== "unclear"),
			(r) => r.socialContact.replace("_", " ")
		),
		valenceBySleep: sliceBy(
			sorted.filter((r) => r.sleepQuality !== null),
			(r) => `${r.sleepQuality} sleep`,
			["poor sleep", "ok sleep", "good sleep"]
		),
		valenceByArousal: sliceBy(sorted, (r) => r.arousal, ["low", "medium", "high"]),

		best: sorted.reduce((a, b) => (b.valence > a.valence ? b : a)),
		worst: sorted.reduce((a, b) => (b.valence < a.valence ? b : a)),

		lowConfidence: sorted.filter((r) => r.confidence < LOW_CONFIDENCE).length,
	};
}

export { LOW_CONFIDENCE };
