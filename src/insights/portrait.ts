import { ChatMessage } from "../llm/provider";
import { buildStyleDirectives } from "../prompts";
import { JournalPluginSettings } from "../settings";
import { InsightMetrics } from "./metrics";

export interface Portrait {
	text: string;
	generatedAt: string;
	model: string;
}

function bullets(items: Array<{ label: string; count: number }>, limit: number): string {
	return items
		.slice(0, limit)
		.map((i) => `${i.label} (${i.count})`)
		.join(", ");
}

/**
 * A "who does this person seem to be" reflection, grounded in the measured
 * corpus rather than only in the summaries — otherwise it just restates core
 * memory. Deliberately framed as description, not diagnosis.
 */
export function buildPortraitMessages(
	settings: JournalPluginSettings,
	metrics: InsightMetrics,
	core: string,
	facts: string[]
): ChatMessage[] {
	const measured = [
		`Entries: ${metrics.entryCount} over ${metrics.spanDays} days (${metrics.activeWeeks} active weeks, ${metrics.silentWeeks} silent)`,
		`Length: median ${metrics.medianWords} words, range ${metrics.minWords}-${metrics.maxWords}`,
		`Sentences average ${metrics.avgSentenceLength} words; ${metrics.questionsPerEntry} question marks per entry`,
		`Self-reference: ${metrics.selfReferenceRate}% of all words are I/me/my`,
		`Pronoun mix: ${bullets(metrics.pronouns, 6)}`,
		`Writes most on: ${dayName(metrics.byDayOfWeek)}`,
		metrics.domains.length ? `Tagged domains: ${bullets(metrics.domains, 8)}` : "",
		metrics.people.length ? `People tagged: ${bullets(metrics.people, 10)}` : "",
		metrics.topics.length ? `Topics tagged: ${bullets(metrics.topics, 8)}` : "",
		`Distinctive vocabulary: ${bullets(metrics.topWords, 25)}`,
	]
		.filter(Boolean)
		.join("\n");

	return [
		{
			role: "system",
			content: `You are writing a short, perceptive portrait of a person based on measured statistics from their private journal plus facts previously extracted from it.

Write 3-4 short paragraphs, in Markdown. Cover:
- What their writing rhythm and length suggest about how they use journaling (a release valve? a ledger? a thinking tool?)
- What the recurring people, domains and vocabulary reveal about where their attention and loyalty actually go, as opposed to where they say it goes
- One genuine tension or throughline that the numbers and themes together point to

Be specific and cite the actual numbers or words where they support a point. Be warm but not flattering, and do not simply list the statistics back. Crucially: describe, do not diagnose — no mental-health labels, no clinical language, no advice. If the data is thin, say so plainly rather than over-reading it.`,
		},
		{
			role: "system",
			content: buildStyleDirectives(settings, { includeLength: false }),
		},
		{
			role: "user",
			content: `Measured from the journal:
${measured}

${core.trim() ? `Existing profile notes:\n"""\n${core.trim()}\n"""` : "No profile notes yet."}

${facts.length ? `Facts extracted from past summaries:\n${facts.map((f) => `- ${f}`).join("\n")}` : "No extracted facts yet."}

Write the portrait.`,
		},
	];
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function dayName(byDayOfWeek: number[]): string {
	let best = 0;
	for (let i = 1; i < byDayOfWeek.length; i++) {
		if (byDayOfWeek[i] > byDayOfWeek[best]) best = i;
	}
	return `${DAY_NAMES[best]} (${byDayOfWeek[best]})`;
}

export { DAY_NAMES };
