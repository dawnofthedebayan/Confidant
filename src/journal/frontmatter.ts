import { App, TFile } from "obsidian";
import { JournalPluginSettings } from "../settings";
import { inSourceFolder } from "./discovery";
import { parseDateFromBasename, todayUtc } from "./dates";

/**
 * `processFrontMatter`'s callback parameter is typed `any` by Obsidian (the
 * frontmatter shape is arbitrary user YAML) — this narrows it to `unknown`
 * members instead, so setting the handful of fields we care about doesn't
 * require unsafe `any` access.
 */
interface FrontmatterLike {
	date?: unknown;
	title?: unknown;
	tags?: unknown;
	[key: string]: unknown;
}

export interface FrontmatterBackfillResult {
	updated: string[];
	/** Subset of `updated` that had no date in frontmatter or filename, so today's date was used instead. */
	fallbackDated: string[];
	failed: Array<{ path: string; error: string }>;
}

/**
 * `processFrontMatter` resolves once the write to disk completes, but the
 * metadata cache reparses asynchronously afterward and fires its own
 * "changed" event — so a `getFileCache` call right after can still return
 * the pre-write cache. Discovery depends on that cache to place an entry in
 * its week, so without this wait a note backfilled and then immediately
 * planned would be silently skipped for one run (fixed on the very next
 * press, once the cache had caught up — which is exactly the confusing
 * "generate again and it works" symptom this closes).
 */
function waitForFrontmatterCache(app: App, file: TFile): Promise<void> {
	if (app.metadataCache.getFileCache(file)?.frontmatter) return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = window.setTimeout(() => {
			app.metadataCache.offref(ref);
			resolve();
		}, 2000); // safety net: never block a run indefinitely on a cache event that doesn't fire
		const ref = app.metadataCache.on("changed", (changed) => {
			if (changed.path !== file.path) return;
			window.clearTimeout(timeout);
			app.metadataCache.offref(ref);
			resolve();
		});
	});
}

/**
 * Adds minimal frontmatter (date, title, tags) to notes in the source folder
 * that don't have any yet, via Obsidian's own API so it plays nicely with the
 * metadata cache and iCloud sync instead of writing files directly.
 *
 * A note's filename date wins when present. Otherwise this falls back to
 * today's date rather than skipping the note — file mtime is deliberately
 * never consulted (see dates.ts: iCloud rewrites it on redownload), but a
 * one-time backfill is different from a repeated read: today's date gets
 * frozen into frontmatter once and never reconsulted, so it can't cause the
 * reshuffling mtime would. Notes dated this way are reported back so the
 * caller can flag them for a manual date correction.
 */
export async function ensureFrontmatter(
	app: App,
	settings: JournalPluginSettings
): Promise<FrontmatterBackfillResult> {
	const result: FrontmatterBackfillResult = { updated: [], fallbackDated: [], failed: [] };

	for (const file of app.vault.getMarkdownFiles()) {
		if (!inSourceFolder(file.path, settings.sourceFolder)) continue;
		if (app.metadataCache.getFileCache(file)?.frontmatter) continue;

		const filenameDate = parseDateFromBasename(file.basename);
		const date = filenameDate ?? todayUtc();

		try {
			await app.fileManager.processFrontMatter(file, (fm: FrontmatterLike) => {
				fm.date = date.toISOString().slice(0, 10);
				fm.title = file.basename;
				fm.tags = fm.tags ?? [];
			});
			await waitForFrontmatterCache(app, file);
			result.updated.push(file.path);
			if (!filenameDate) result.fallbackDated.push(file.path);
		} catch (err) {
			result.failed.push({
				path: file.path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}
