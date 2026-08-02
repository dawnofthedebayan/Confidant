import { App, TFile, normalizePath } from "obsidian";
import { CADENCE_FOLDER, Cadence, JournalPluginSettings } from "../settings";

const CADENCE_TITLE: Record<Cadence, string> = {
	weekly: "Weekly",
	biweekly: "Biweekly",
	monthly: "Monthly",
	yearly: "Yearly",
};

/** `<outputFolder>/<Cadence>/<year>/<key>.md` */
export function summaryPath(
	settings: JournalPluginSettings,
	cadence: Cadence,
	key: string,
	year: number
): string {
	const base = settings.outputFolder.replace(/^\/+|\/+$/g, "");
	return normalizePath(`${base}/${CADENCE_FOLDER[cadence]}/${year}/${key}.md`);
}

export function summaryFilename(key: string): string {
	return `${key}.md`;
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) {
			await app.vault.createFolder(current).catch(() => undefined);
		}
	}
}

export async function summaryExists(app: App, path: string): Promise<boolean> {
	return app.vault.adapter.exists(path);
}

export async function readSummary(app: App, path: string): Promise<string | null> {
	if (!(await app.vault.adapter.exists(path))) return null;
	const raw = await app.vault.adapter.read(path);
	// Drop frontmatter and the generated-on heading; rollups want the prose.
	return raw
		.replace(/^---[\s\S]*?---\n/, "")
		.replace(/^#\s.*\n(\*Generated on[^\n]*\*\n)?/, "")
		.trim();
}

export async function writeSummary(
	app: App,
	settings: JournalPluginSettings,
	cadence: Cadence,
	key: string,
	year: number,
	modelLabel: string,
	content: string
): Promise<TFile | null> {
	const path = summaryPath(settings, cadence, key, year);
	await ensureFolder(app, path.split("/").slice(0, -1).join("/"));

	const now = new Date();
	const frontmatter =
		"---\n" +
		`title: "${CADENCE_TITLE[cadence]} Therapeutic Summary - ${key}"\n` +
		`date: "${now.toISOString().slice(0, 10)}"\n` +
		"tags:\n" +
		"  - type/journal\n" +
		"  - generated\n" +
		`  - cadence/${cadence}\n` +
		`  - llm/${modelLabel.replace(/[^A-Za-z0-9._/-]/g, "-")}\n` +
		"---\n\n";

	const heading =
		`# ${CADENCE_TITLE[cadence]} Therapeutic Summary - ${key}\n` +
		`*Generated on ${now.toISOString().slice(0, 19).replace("T", " ")}*\n\n`;

	const body = `${frontmatter}${heading}${content.trim()}\n`;

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, body);
		return existing;
	}
	return app.vault.create(path, body);
}
