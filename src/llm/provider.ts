import { requestUrl } from "obsidian";
import { JournalPluginSettings } from "../settings";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	maxTokens?: number;
	temperature?: number;
}

export interface LLMProvider {
	/** Short label used in output frontmatter, e.g. `llm/<modelLabel>`. */
	readonly modelLabel: string;
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

/** Reasoning models can burn the whole budget inside <think> before answering. */
export const DEFAULT_MAX_TOKENS = 4096;

export class TruncatedGenerationError extends Error {
	constructor(maxTokens: number) {
		super(
			`The model ran out of tokens while still reasoning and never produced a final answer (max_tokens=${maxTokens}).`
		);
		this.name = "TruncatedGenerationError";
	}
}

/**
 * Strip a reasoning model's <think> block. If the block was opened but never
 * closed, generation was cut off mid-thought — surface that loudly rather than
 * letting raw reasoning text leak into the vault.
 */
export function stripThinking(raw: string, maxTokens: number): string {
	let result = raw.trim();
	for (const seq of ["<|im_end|>", "<|endoftext|>"]) {
		const idx = result.indexOf(seq);
		if (idx !== -1) result = result.slice(0, idx).trim();
	}

	const hasOpen = result.includes("<think>");
	const hasClose = result.includes("</think>");
	if (hasOpen && !hasClose) throw new TruncatedGenerationError(maxTokens);

	const match = /<\/think>\s*([\s\S]*)$/.exec(result);
	if (match) result = match[1].trim();
	return result;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: { content?: string; reasoning?: string };
		finish_reason?: string;
	}>;
	error?: { message?: string };
}

function extractContent(body: ChatCompletionResponse): { text: string; finish?: string } {
	if (body.error?.message) throw new Error(`LLM error: ${body.error.message}`);
	const choice = body.choices?.[0];
	const text = choice?.message?.content;
	if (typeof text !== "string") {
		throw new Error("LLM response contained no message content.");
	}
	return { text, finish: choice?.finish_reason };
}

abstract class ChatCompletionsProvider implements LLMProvider {
	abstract readonly modelLabel: string;
	protected abstract endpoint(): string;
	protected abstract headers(): Record<string, string>;
	protected abstract body(messages: ChatMessage[], options: Required<ChatOptions>): unknown;

	async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
		const resolved: Required<ChatOptions> = {
			maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
			temperature: options.temperature ?? 0.7,
		};

		const response = await requestUrl({
			url: this.endpoint(),
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.headers() },
			body: JSON.stringify(this.body(messages, resolved)),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(
				`LLM request failed (HTTP ${response.status}): ${response.text?.slice(0, 400) ?? ""}`
			);
		}

		const { text, finish } = extractContent(response.json as ChatCompletionResponse);
		if (finish === "length" && !text.includes("</think>")) {
			throw new TruncatedGenerationError(resolved.maxTokens);
		}
		return stripThinking(text, resolved.maxTokens);
	}
}

class LocalProvider extends ChatCompletionsProvider {
	readonly modelLabel: string;

	constructor(private url: string, private model: string) {
		super();
		this.modelLabel = model.trim() || "local";
	}

	protected endpoint(): string {
		if (!this.url.trim()) throw new Error("Local server URL is not configured.");
		return this.url.trim();
	}

	protected headers(): Record<string, string> {
		return {};
	}

	protected body(messages: ChatMessage[], options: Required<ChatOptions>) {
		// `model` is optional for a single-model server (mlx_lm.server,
		// llama.cpp, a single mlx-openai-server instance), but REQUIRED when
		// the server multiplexes several models by served_model_name —
		// mlx-openai-server's --config YAML mode, or LM Studio with several
		// models loaded. Leaving it blank there routes to the wrong model.
		return {
			...(this.model.trim() ? { model: this.model.trim() } : {}),
			messages,
			max_tokens: options.maxTokens,
			temperature: options.temperature,
			stream: false,
		};
	}
}

class OpenRouterProvider extends ChatCompletionsProvider {
	constructor(private apiKey: string, readonly modelLabel: string) {
		super();
	}

	protected endpoint(): string {
		return "https://openrouter.ai/api/v1/chat/completions";
	}

	protected headers(): Record<string, string> {
		if (!this.apiKey.trim()) throw new Error("OpenRouter API key is not configured.");
		return {
			Authorization: `Bearer ${this.apiKey.trim()}`,
			"HTTP-Referer": "https://obsidian.md",
			"X-Title": "Obsidian Confidant",
		};
	}

	protected body(messages: ChatMessage[], options: Required<ChatOptions>) {
		return {
			model: this.modelLabel,
			messages,
			max_tokens: options.maxTokens,
			temperature: options.temperature,
			stream: false,
		};
	}
}

export function createProvider(settings: JournalPluginSettings): LLMProvider {
	return settings.backend === "openrouter"
		? new OpenRouterProvider(settings.openRouterApiKey, settings.openRouterModel)
		: new LocalProvider(settings.localServerUrl, settings.localModel);
}

/**
 * Ask a local server what it has loaded, by rewriting any /v1/... endpoint to
 * /v1/models. A wrong model identifier is the most common local-server failure,
 * so the test buttons use this to show what's actually available.
 */
export async function listModels(endpointUrl: string): Promise<string[]> {
	const url = endpointUrl.trim().replace(/\/v1\/.*$/, "/v1/models");
	if (!/\/v1\/models$/.test(url)) return [];
	const response = await requestUrl({ url, method: "GET", throw: false });
	if (response.status >= 400) return [];
	const body = response.json as { data?: Array<{ id?: string }> };
	return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}
