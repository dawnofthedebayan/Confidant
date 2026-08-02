/**
 * ISO-8601 week helpers.
 *
 * Everything here works off dates parsed out of *filenames*, never file mtimes:
 * iCloud rewrites mtimes when it redownloads a note, so mtime is not a stable
 * signal for which week an entry belongs to.
 */

export interface IsoWeek {
	year: number;
	week: number;
}

const DATE_IN_NAME = /(\d{4})-(\d{2})-(\d{2})/;

function makeUtcDate(year: number, month: number, day: number): Date | null {
	const dt = new Date(Date.UTC(year, month - 1, day));
	// Reject things like 2026-02-31 that Date happily rolls over.
	// Reject things like 2026-02-31 that Date happily rolls over.
	if (
		dt.getUTCFullYear() !== year ||
		dt.getUTCMonth() !== month - 1 ||
		dt.getUTCDate() !== day
	) {
		return null;
	}
	return dt;
}

/** Parse a `YYYY-MM-DD` date out of a note basename. Returns null if absent/invalid. */
export function parseDateFromBasename(basename: string): Date | null {
	const m = DATE_IN_NAME.exec(basename);
	if (!m) return null;
	return makeUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Parse a frontmatter `date:` value. Obsidian hands these back as strings, but
 * a YAML parser may already have turned an unquoted date into a Date, so accept
 * both.
 */
export function parseFrontmatterDate(value: unknown): Date | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return makeUtcDate(
			value.getUTCFullYear(),
			value.getUTCMonth() + 1,
			value.getUTCDate()
		);
	}
	if (typeof value !== "string") return null;
	const m = DATE_IN_NAME.exec(value.trim());
	if (!m) return null;
	return makeUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** ISO week-year and week number for a UTC date. */
export function isoWeekOf(date: Date): IsoWeek {
	const d = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);
	// Shift to the Thursday of this ISO week; its calendar year is the week-year.
	const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const year = d.getUTCFullYear();
	const jan1 = Date.UTC(year, 0, 1);
	const week = Math.ceil(((d.getTime() - jan1) / 86400000 + 1) / 7);
	return { year, week };
}

/** The Thursday of a given ISO week — the day that decides the week's month/year. */
export function isoWeekThursday(year: number, week: number): Date {
	const jan4 = new Date(Date.UTC(year, 0, 4));
	const jan4Day = jan4.getUTCDay() || 7;
	const week1Monday = new Date(jan4);
	week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
	const thursday = new Date(week1Monday);
	thursday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7 + 3);
	return thursday;
}

/** The Sunday that closes a given ISO week. */
export function isoWeekSunday(year: number, week: number): Date {
	const sunday = isoWeekThursday(year, week);
	sunday.setUTCDate(sunday.getUTCDate() + 3);
	return sunday;
}

/** Today at UTC midnight, for comparing against week boundaries. */
export function todayUtc(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** Number of ISO weeks in a week-year (52 or 53). */
export function isoWeeksInYear(year: number): number {
	// Week 53 exists iff its Thursday is still in the same year.
	return isoWeekThursday(year, 53).getUTCFullYear() === year ? 53 : 52;
}

/** The calendar month (1-12) an ISO week belongs to, per the Thursday rule. */
export function monthOfIsoWeek(year: number, week: number): { year: number; month: number } {
	const th = isoWeekThursday(year, week);
	return { year: th.getUTCFullYear(), month: th.getUTCMonth() + 1 };
}

export function weeklyKey(year: number, week: number): string {
	return `${year}-W${String(week).padStart(2, "0")}`;
}

export function biweeklyKey(year: number, pair: number): string {
	return `${year}-BW${String(pair).padStart(2, "0")}`;
}

export function monthlyKey(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, "0")}`;
}

export function yearlyKey(year: number): string {
	return String(year);
}

/** The last UTC day of a given calendar month (1-12). */
export function monthEnd(year: number, month: number): Date {
	return new Date(Date.UTC(year, month, 0));
}

/** Weeks 1-2 -> BW01, weeks 3-4 -> BW02, ... */
export function biweeklyPairOf(week: number): number {
	return Math.ceil(week / 2);
}

/** The ISO weeks that make up a biweekly pair, clamped to weeks that exist that year. */
export function weeksInBiweeklyPair(year: number, pair: number): number[] {
	const max = isoWeeksInYear(year);
	return [pair * 2 - 1, pair * 2].filter((w) => w >= 1 && w <= max);
}

/** The ISO weeks whose Thursday falls inside the given calendar month. */
export function weeksInMonth(year: number, month: number): Array<IsoWeek> {
	const out: IsoWeek[] = [];
	// A month's weeks can belong to the neighbouring ISO week-year at year edges.
	for (const wy of [year - 1, year, year + 1]) {
		const max = isoWeeksInYear(wy);
		for (let w = 1; w <= max; w++) {
			const m = monthOfIsoWeek(wy, w);
			if (m.year === year && m.month === month) out.push({ year: wy, week: w });
		}
	}
	out.sort((a, b) => a.year - b.year || a.week - b.week);
	return out;
}

export function todayIsoWeek(): IsoWeek {
	const now = new Date();
	return isoWeekOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
