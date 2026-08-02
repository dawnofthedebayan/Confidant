import { App, TFile } from "obsidian";
import { JournalPluginSettings } from "../settings";
import { inSourceFolder, matchesTags, resolveEntryDate } from "./discovery";
import { isoWeekOf, weeklyKey } from "./dates";
import { ProcessedDb } from "./tracking";

/**
 * Why each candidate note was or wasn't picked up.
 *
 * "Nothing to generate" has several possible causes that look identical from
 * the outside — wrong folder, no resolvable date, tag filter, or an already
 * recorded filename. This reports which one actually applied.
 */
export interface DiscoveryDiagnosis {
	sourceFolder: string;
	includeTags: string[];
	tagMatchMode: string;

	markdownInVault: number;
	markdownInFolder: number;

	includedCount: number;
	/** In the folder but with no date in frontmatter or filename. */
	noDate: string[];
	/** Dated, but filtered out by `includeTags`. */
	tagFiltered: string[];
	/** Obsidian hasn't indexed these yet, so tags/frontmatter are unreadable. */
	notIndexed: string[];

	weeks: Array<{
		key: string;
		found: number;
		recorded: number;
		unrecorded: string[];
	}>;
}

export function diagnoseDiscovery(
	app: App,
	settings: JournalPluginSettings,
	db: ProcessedDb
): DiscoveryDiagnosis {
	const all = app.vault.getMarkdownFiles();
	const inFolder = all.filter((f) => inSourceFolder(f.path, settings.sourceFolder));

	const noDate: string[] = [];
	const tagFiltered: string[] = [];
	const notIndexed: string[] = [];
	const included: Array<{ file: TFile; year: number; week: number }> = [];

	for (const file of inFolder) {
		if (!app.metadataCache.getFileCache(file)) notIndexed.push(file.name);

		const date = resolveEntryDate(app, file);
		if (!date) {
			noDate.push(file.name);
			continue;
		}
		if (!matchesTags(app, file, settings)) {
			tagFiltered.push(file.name);
			continue;
		}
		const { year, week } = isoWeekOf(date);
		included.push({ file, year, week });
	}

	const byWeek = new Map<string, TFile[]>();
	for (const { file, year, week } of included) {
		const key = weeklyKey(year, week);
		const bucket = byWeek.get(key);
		if (bucket) bucket.push(file);
		else byWeek.set(key, [file]);
	}

	const weeks = [...byWeek.entries()]
		.map(([key, files]) => {
			const recorded = new Set(db.weekly[key] ?? []);
			return {
				key,
				found: files.length,
				recorded: recorded.size,
				unrecorded: files.map((f) => f.name).filter((n) => !recorded.has(n)),
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));

	return {
		sourceFolder: settings.sourceFolder || "(whole vault)",
		includeTags: settings.includeTags,
		tagMatchMode: settings.tagMatchMode,
		markdownInVault: all.length,
		markdownInFolder: inFolder.length,
		includedCount: included.length,
		noDate,
		tagFiltered,
		notIndexed,
		weeks,
	};
}
