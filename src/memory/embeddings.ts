import { requestUrl } from "obsidian";
import { JournalPluginSettings } from "../settings";

/**
 * Local embeddings for semantic/episodic retrieval, served by any local
 * server exposing the OpenAI `/v1/embeddings` shape (mlx-openai-server, LM
 * Studio, an embeddings-capable llama.cpp build, ...). Retrieval runs locally
 * regardless of which generation backend is selected, but is entirely
 * optional — see MemoryStore.retrieve, which degrades to core-memory-only
 * rather than failing when this is unreachable or unconfigured.
 *
 * Note `mlx_lm.server` specifically does NOT expose an embeddings endpoint —
 * MLX users need a separate server for this (mlx-openai-server, mlx-serve),
 * which is why the URL is configured independently of the chat backend.
 */
export interface EmbeddingProvider {
	/** Tags stored vectors so a model change can be detected and repaired. */
	readonly id: string;
	embed(text: string): Promise<number[]>;
	embedBatch(texts: string[]): Promise<number[][]>;
}

/** Marks a record whose embedding could not be computed. Never retrieved. */
export const UNEMBEDDED = "unembedded";

/** Keeps requests inside the encoder's context window (bge/MiniLM are 512 tokens). */
const MAX_CHARS = 2000;

interface EmbeddingsResponse {
	data?: Array<{ embedding?: number[]; index?: number }>;
	error?: { message?: string };
}

export class MlxEmbeddingProvider implements EmbeddingProvider {
	constructor(private url: string, readonly id: string) {}

	async embed(text: string): Promise<number[]> {
		const [vector] = await this.embedBatch([text]);
		return vector;
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (!this.url.trim()) throw new Error("Embedding server URL is not configured.");

		const response = await requestUrl({
			url: this.url.trim(),
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.id,
				input: texts.map((t) => t.slice(0, MAX_CHARS)),
			}),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(
				`Embedding request failed (HTTP ${response.status}): ${response.text?.slice(0, 300) ?? ""}`
			);
		}

		const body = response.json as EmbeddingsResponse;
		if (body.error?.message) throw new Error(`Embedding error: ${body.error.message}`);
		if (!Array.isArray(body.data) || body.data.length !== texts.length) {
			throw new Error(
				`Embedding server returned ${body.data?.length ?? 0} vectors for ${texts.length} inputs.`
			);
		}

		// The spec allows out-of-order results, so respect `index` when present.
		const out = new Array<number[]>(texts.length);
		body.data.forEach((item, i) => {
			const vector = item.embedding;
			if (!Array.isArray(vector) || vector.length === 0) {
				throw new Error("Embedding server returned an empty vector.");
			}
			out[item.index ?? i] = vector;
		});
		return out;
	}
}

export function createEmbeddingProvider(settings: JournalPluginSettings): EmbeddingProvider {
	return new MlxEmbeddingProvider(settings.embeddingServerUrl, settings.embeddingModel);
}

// ---------------------------------------------------------------- similarity --

export function cosineSimilarity(a: number[], b: number[]): number {
	// Differing lengths mean vectors from different models; not comparable.
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Top-k by cosine similarity. Zero-similarity items are dropped, not padded. */
export function topK<T extends { embedding: number[] }>(
	items: T[],
	query: number[],
	k: number
): T[] {
	if (k <= 0 || query.length === 0) return [];
	return items
		.map((item) => ({ item, score: cosineSimilarity(item.embedding, query) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
		.map((s) => s.item);
}
