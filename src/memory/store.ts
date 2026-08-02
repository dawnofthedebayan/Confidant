import { App, normalizePath } from "obsidian";
import { Cadence, JournalPluginSettings } from "../settings";
import { ensureFolder } from "../journal/output";
import { EmbeddingProvider, UNEMBEDDED, topK } from "./embeddings";

export interface SemanticFact {
	id: string;
	text: string;
	embedding: number[];
	/** Which model produced `embedding`, so a model swap can be repaired. */
	embeddingModel: string;
	createdAt: string;
	source: string;
}

export interface EpisodicMemory {
	id: string;
	cadence: Cadence;
	key: string;
	/** The summary text itself — biweekly/monthly rollups read from this store. */
	text: string;
	embedding: number[];
	embeddingModel: string;
	createdAt: string;
}

interface StoreFile {
	semantic: SemanticFact[];
	episodic: EpisodicMemory[];
}

export interface RetrievedMemory {
	core: string;
	semantic: SemanticFact[];
	episodic: EpisodicMemory[];
}

const STORE_FILENAME = "memory-store.json";

function newId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Three-tier memory.
 *
 * - core: a single size-bounded markdown file the user can read and edit, kept
 *   in the vault under `<outputFolder>/_memory/core.md`.
 * - semantic: durable extracted facts, embedded for retrieval.
 * - episodic: past summaries, embedded for retrieval. Biweekly/monthly rollups
 *   read their inputs from here rather than re-reading raw dailies.
 *
 * The embedded stores live in the plugin's own config dir, not the vault, so
 * float arrays never show up as notes.
 */
export class MemoryStore {
	private data: StoreFile = { semantic: [], episodic: [] };
	private loaded = false;

	constructor(
		private app: App,
		private pluginDir: string,
		private settings: () => JournalPluginSettings,
		private embedder: () => EmbeddingProvider
	) {}

	/**
	 * Embed, but never lose data to a down embedding server: on failure the
	 * record is stored unembedded and repaired later by "Rebuild memory
	 * embeddings". An empty vector scores 0, so it is simply never retrieved.
	 */
	private async tryEmbed(text: string): Promise<{ embedding: number[]; embeddingModel: string }> {
		const embedder = this.embedder();
		try {
			return { embedding: await embedder.embed(text), embeddingModel: embedder.id };
		} catch (err) {
			console.warn("[confidant] embedding failed; storing unembedded:", err);
			return { embedding: [], embeddingModel: UNEMBEDDED };
		}
	}

	private get storePath(): string {
		return normalizePath(`${this.pluginDir}/${STORE_FILENAME}`);
	}

	get coreMemoryPath(): string {
		const base = this.settings().outputFolder.replace(/^\/+|\/+$/g, "");
		return normalizePath(base ? `${base}/_memory/core.md` : "_memory/core.md");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (await this.app.vault.adapter.exists(this.storePath)) {
				const raw = await this.app.vault.adapter.read(this.storePath);
				const parsed = JSON.parse(raw) as Partial<StoreFile>;
				this.data = {
					semantic: parsed.semantic ?? [],
					episodic: parsed.episodic ?? [],
				};
			}
		} catch (err) {
			console.error("[confidant] failed to read memory store:", err);
			this.data = { semantic: [], episodic: [] };
		}
	}

	private async save(): Promise<void> {
		await this.app.vault.adapter.write(this.storePath, JSON.stringify(this.data));
	}

	// --- core memory -------------------------------------------------------

	async readCore(): Promise<string> {
		const path = this.coreMemoryPath;
		if (!(await this.app.vault.adapter.exists(path))) return "";
		const raw = await this.app.vault.adapter.read(path);
		return raw.replace(/^---[\s\S]*?---\n/, "").trim();
	}

	async writeCore(content: string): Promise<void> {
		const max = this.settings().coreMemoryMaxChars;
		let body = content.trim();
		if (body.length > max) {
			// Hard bound, even if the memory-manager call ignored the budget.
			body = `${body.slice(0, max).trimEnd()}\n\n<!-- truncated to ${max} characters -->`;
		}
		const path = this.coreMemoryPath;
		await this.ensureParent(path);
		const file = `---\ntitle: "Core memory"\nupdated: "${new Date().toISOString().slice(0, 10)}"\ntags:\n  - confidant/core-memory\n---\n\n${body}\n`;
		await this.app.vault.adapter.write(path, file);
	}

	private async ensureParent(path: string): Promise<void> {
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent) await ensureFolder(this.app, parent);
	}

	// --- semantic ----------------------------------------------------------

	async addSemanticFacts(facts: string[], source: string): Promise<number> {
		const existing = new Set(this.data.semantic.map((f) => f.text.trim().toLowerCase()));
		let added = 0;
		for (const raw of facts) {
			const text = raw.trim();
			if (!text || existing.has(text.toLowerCase())) continue;
			existing.add(text.toLowerCase());
			this.data.semantic.push({
				id: newId(),
				text,
				...(await this.tryEmbed(text)),
				createdAt: new Date().toISOString(),
				source,
			});
			added++;
		}
		if (added > 0) await this.save();
		return added;
	}

	// --- episodic ----------------------------------------------------------

	async addEpisode(cadence: Cadence, key: string, text: string): Promise<void> {
		this.data.episodic = this.data.episodic.filter(
			(e) => !(e.cadence === cadence && e.key === key)
		);
		this.data.episodic.push({
			id: newId(),
			cadence,
			key,
			text,
			...(await this.tryEmbed(text)),
			createdAt: new Date().toISOString(),
		});
		await this.save();
	}

	getEpisode(cadence: Cadence, key: string): EpisodicMemory | undefined {
		return this.data.episodic.find((e) => e.cadence === cadence && e.key === key);
	}

	// --- retrieval ---------------------------------------------------------

	/**
	 * Core memory verbatim plus the top-k semantic facts and past episodes.
	 *
	 * If the embedding server is unreachable, core memory is still returned —
	 * the run continues with less context rather than failing outright.
	 */
	async retrieve(query: string, excludeKeys: string[] = []): Promise<RetrievedMemory> {
		const settings = this.settings();
		const core = await this.readCore();
		const embedder = this.embedder();

		let queryVec: number[];
		try {
			queryVec = await embedder.embed(query);
		} catch (err) {
			console.warn("[confidant] retrieval embedding failed; core memory only:", err);
			return { core, semantic: [], episodic: [] };
		}

		// Vectors from another model live in a different space; ignore them
		// rather than returning nonsense neighbours.
		const usable = <T extends { embeddingModel: string }>(items: T[]) =>
			items.filter((i) => i.embeddingModel === embedder.id);

		const episodicPool = usable(this.data.episodic).filter((e) => !excludeKeys.includes(e.key));
		return {
			core,
			semantic: topK(usable(this.data.semantic), queryVec, settings.semanticTopK),
			episodic: topK(episodicPool, queryVec, settings.episodicTopK),
		};
	}

	/**
	 * Re-embed everything with the current model. Needed after changing the
	 * embedding model, and to repair records stored while the server was down.
	 */
	async rebuildEmbeddings(onProgress?: (done: number, total: number) => void): Promise<number> {
		const embedder = this.embedder();
		const records: Array<SemanticFact | EpisodicMemory> = [
			...this.data.semantic,
			...this.data.episodic,
		];
		const stale = records.filter((r) => r.embeddingModel !== embedder.id);
		if (stale.length === 0) return 0;

		const BATCH = 16;
		for (let i = 0; i < stale.length; i += BATCH) {
			const chunk = stale.slice(i, i + BATCH);
			const vectors = await embedder.embedBatch(chunk.map((r) => r.text));
			chunk.forEach((record, j) => {
				record.embedding = vectors[j];
				record.embeddingModel = embedder.id;
			});
			onProgress?.(Math.min(i + BATCH, stale.length), stale.length);
			await this.save();
		}
		return stale.length;
	}

	/** Read-only snapshot for rendering (e.g. "Dump memory to note"). */
	snapshot(): { semantic: SemanticFact[]; episodic: EpisodicMemory[] } {
		return { semantic: [...this.data.semantic], episodic: [...this.data.episodic] };
	}

	stats(): { semantic: number; episodic: number; stale: number } {
		const id = this.settings().embeddingModel;
		const stale = [...this.data.semantic, ...this.data.episodic].filter(
			(r) => r.embeddingModel !== id
		).length;
		return {
			semantic: this.data.semantic.length,
			episodic: this.data.episodic.length,
			stale,
		};
	}

	async clear(): Promise<void> {
		this.data = { semantic: [], episodic: [] };
		await this.save();
	}
}
