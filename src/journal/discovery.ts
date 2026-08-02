import { App, TFile, getAllTags } from "obsidian";
import { JournalPluginSettings } from "../settings";
import { isoWeekOf, parseDateFromBasename, parseFrontmatterDate, weeklyKey } from "./dates";

export interface DailyEntry {
	file: TFile;
	date: Date;
	year: number;
	week: number;
}

function normalizeTag(tag: string): string {
	return tag.replace(/^#/, "").trim().toLowerCase();
}

/** True if the note is inside `sourceFolder` (or the whole vault when it's blank). */
export function inSourceFolder(path: string, sourceFolder: string): boolean {
	const folder = sourceFolder.replace(/^\/+|\/+$/g, "");
	if (!folder) return true;
	return path === `${folder}` || path.startsWith(`${folder}/`);
}

/**
 * Tag eligibility. OR logic across `includeTags`; an empty list means no
 * filtering at all, so the plugin behaves like the original script until the
 * user opts in.
 */
export function matchesTags(app: App, file: TFile, settings: JournalPluginSettings): boolean {
	const wanted = settings.includeTags.map(normalizeTag).filter(Boolean);
	if (wanted.length === 0) return true;

	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return false;

	const frontmatterTags: string[] = [];
	const fm = cache.frontmatter?.tags;
	if (typeof fm === "string") {
		frontmatterTags.push(...fm.split(/[,\s]+/));
	} else if (Array.isArray(fm)) {
		frontmatterTags.push(...fm.map((t) => String(t)));
	}

	const inlineTags = (cache.tags ?? []).map((t) => t.tag);

	let pool: string[];
	switch (settings.tagMatchMode) {
		case "frontmatter":
			pool = frontmatterTags;
			break;
		case "inline":
			pool = inlineTags;
			break;
		case "both":
		default:
			// getAllTags covers both surfaces and any tags Obsidian resolves for us.
			pool = getAllTags(cache) ?? [...frontmatterTags, ...inlineTags];
			break;
	}

	const have = new Set(pool.map(normalizeTag).filter(Boolean));
	return wanted.some((w) => have.has(w));
}

/**
 * Which day a note belongs to.
 *
 * Frontmatter `date:` wins, falling back to a `YYYY-MM-DD` in the filename for
 * vaults that use that convention. File mtime is deliberately never consulted:
 * iCloud rewrites mtimes when it redownloads a note, which would silently
 * reshuffle entries between weeks.
 */
export function resolveEntryDate(app: App, file: TFile): Date | null {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return parseFrontmatterDate(fm?.date) ?? parseDateFromBasename(file.basename);
}

/** All eligible daily notes, grouped by ISO year/week key (`2026-W01`). */
export function discoverDailyEntries(
	app: App,
	settings: JournalPluginSettings
): Map<string, DailyEntry[]> {
	const grouped = new Map<string, DailyEntry[]>();

	for (const file of app.vault.getMarkdownFiles()) {
		if (!inSourceFolder(file.path, settings.sourceFolder)) continue;
		const date = resolveEntryDate(app, file);
		if (!date) continue; // no resolvable date -> not a dated journal entry
		if (!matchesTags(app, file, settings)) continue;

		const { year, week } = isoWeekOf(date);
		const key = weeklyKey(year, week);
		const entry: DailyEntry = { file, date, year, week };
		const bucket = grouped.get(key);
		if (bucket) bucket.push(entry);
		else grouped.set(key, [entry]);
	}

	for (const bucket of grouped.values()) {
		bucket.sort((a, b) => a.date.getTime() - b.date.getTime());
	}
	return grouped;
}

/** Concatenate entries the way the original script did, one delimited block per note. */
export async function loadEntryText(app: App, entries: DailyEntry[]): Promise<string> {
	const parts: string[] = [];
	for (const entry of entries) {
		const content = await app.vault.cachedRead(entry.file);
		parts.push(`--- Entry: ${entry.file.name} ---\n${content}\n`);
	}
	return parts.join("\n");
}
