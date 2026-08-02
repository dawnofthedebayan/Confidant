import { App, TFile, normalizePath } from "obsidian";
import { ensureFolder } from "../journal/output";
import { EpisodicMemory, SemanticFact } from "./store";
import { JournalPluginSettings } from "../settings";

/** `<outputFolder>/_memory/dump.md` — read-only, regenerated each time. */
export function memoryDumpPath(settings: JournalPluginSettings): string {
	const base = settings.outputFolder.replace(/^\/+|\/+$/g, "");
	return normalizePath(base ? `${base}/_memory/dump.md` : "_memory/dump.md");
}

function renderSemantic(facts: SemanticFact[]): string {
	if (facts.length === 0) return "_No semantic facts stored yet._";

	const bySource = new Map<string, SemanticFact[]>();
	for (const fact of facts) {
		const bucket = bySource.get(fact.source);
		if (bucket) bucket.push(fact);
		else bySource.set(fact.source, [fact]);
	}

	const sources = [...bySource.keys()].sort();
	return sources
		.map((source) => {
			const lines = bySource
				.get(source)!
				.map((f) => `- ${f.text}${f.embeddingModel === "unembedded" ? " *(unembedded)*" : ""}`)
				.join("\n");
			return `### ${source}\n${lines}`;
		})
		.join("\n\n");
}

function renderEpisodic(episodes: EpisodicMemory[]): string {
	if (episodes.length === 0) return "_No episodic memories stored yet._";

	const sorted = [...episodes].sort((a, b) => a.key.localeCompare(b.key));
	return sorted
		.map((e) => {
			const flag = e.embeddingModel === "unembedded" ? " *(unembedded)*" : "";
			return `### ${e.key} (${e.cadence})${flag}\n\n${e.text.trim()}`;
		})
		.join("\n\n---\n\n");
}

/**
 * Render a read-only snapshot of everything except core memory (which is
 * already a normal, editable vault note). Regenerated on demand by the
 * "Dump memory to note" command — not kept in sync automatically.
 */
export function renderMemoryDump(
	core: string,
	semantic: SemanticFact[],
	episodic: EpisodicMemory[]
): string {
	const now = new Date();
	const frontmatter =
		"---\n" +
		'title: "Confidant Memory Dump"\n' +
		`generated: "${now.toISOString()}"\n` +
		"tags:\n" +
		"  - confidant/memory-dump\n" +
		"  - generated\n" +
		"---\n\n";

	const heading =
		"# Confidant Memory Dump\n\n" +
		`*Snapshot as of ${now.toISOString().slice(0, 19).replace("T", " ")}. ` +
		"Read-only — re-run \"Dump memory to note\" to refresh; edits here are not saved back.*\n\n";

	const coreSection = `## Core memory\n\n${core.trim() || "_Empty._"}\n\n`;
	const semanticSection = `## Semantic facts (${semantic.length})\n\n${renderSemantic(semantic)}\n\n`;
	const episodicSection = `## Episodic memory (${episodic.length})\n\n${renderEpisodic(episodic)}\n`;

	return frontmatter + heading + coreSection + semanticSection + episodicSection;
}

export async function writeMemoryDump(
	app: App,
	settings: JournalPluginSettings,
	content: string
): Promise<TFile> {
	const path = memoryDumpPath(settings);
	await ensureFolder(app, path.split("/").slice(0, -1).join("/"));

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return existing;
	}
	return app.vault.create(path, content);
}
