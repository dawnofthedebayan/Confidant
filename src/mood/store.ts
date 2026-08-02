import { App, normalizePath } from "obsidian";
import { MoodRecord, contentHash } from "./types";

const STORE_FILENAME = "mood-data.json";

/**
 * Per-entry mood records, keyed by vault path.
 *
 * Kept in the plugin's config dir rather than the vault: it's machine data
 * consumed by the dashboard, and writing it as a note would put a large JSON
 * blob in the user's search results.
 */
export class MoodStore {
	private data = new Map<string, MoodRecord>();
	private loaded = false;

	constructor(private app: App, private pluginDir: string) {}

	private get storePath(): string {
		return normalizePath(`${this.pluginDir}/${STORE_FILENAME}`);
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (await this.app.vault.adapter.exists(this.storePath)) {
				const raw = await this.app.vault.adapter.read(this.storePath);
				const records = JSON.parse(raw) as MoodRecord[];
				if (Array.isArray(records)) {
					for (const record of records) {
						if (record?.path) this.data.set(record.path, record);
					}
				}
			}
		} catch (err) {
			console.error("[confidant] failed to read mood store:", err);
			this.data.clear();
		}
	}

	private async save(): Promise<void> {
		// Stored as a date-sorted array so the file is readable and diffable.
		const records = [...this.data.values()].sort(
			(a, b) => a.date.localeCompare(b.date) || a.filename.localeCompare(b.filename)
		);
		await this.app.vault.adapter.write(this.storePath, JSON.stringify(records, null, 2));
	}

	/** True when the entry has never been classified, or its text changed since. */
	needsClassification(path: string, text: string): boolean {
		const existing = this.data.get(path);
		if (!existing) return true;
		return existing.contentHash !== contentHash(text);
	}

	async upsert(record: MoodRecord): Promise<void> {
		this.data.set(record.path, record);
		await this.save();
	}

	/** Drop records whose source note no longer exists. */
	async prune(existingPaths: Set<string>): Promise<number> {
		let removed = 0;
		for (const path of [...this.data.keys()]) {
			if (!existingPaths.has(path)) {
				this.data.delete(path);
				removed++;
			}
		}
		if (removed > 0) await this.save();
		return removed;
	}

	all(): MoodRecord[] {
		return [...this.data.values()].sort((a, b) => a.date.localeCompare(b.date));
	}

	forPaths(paths: string[]): MoodRecord[] {
		return paths
			.map((p) => this.data.get(p))
			.filter((r): r is MoodRecord => Boolean(r))
			.sort((a, b) => a.date.localeCompare(b.date));
	}

	get size(): number {
		return this.data.size;
	}

	async clear(): Promise<void> {
		this.data.clear();
		await this.save();
	}
}
