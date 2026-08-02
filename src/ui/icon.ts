import { addIcon } from "obsidian";

/**
 * Custom ribbon glyph: a trail of past days (dots) leading up to an eye
 * glancing back over them — the plugin's own visual mark, in the same
 * stroke-based, 24x24, currentColor style as Obsidian's built-in Lucide
 * icons so it doesn't look out of place next to them.
 */
export const CONFIDANT_ICON_ID = "confidant-glyph";

const CONFIDANT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
<circle cx="4" cy="18.5" r="1" fill="currentColor" stroke="none"/>
<circle cx="8" cy="16" r="1" fill="currentColor" stroke="none"/>
<circle cx="11.5" cy="13" r="1" fill="currentColor" stroke="none"/>
<ellipse cx="17" cy="8.5" rx="4.2" ry="2.8"/>
<circle cx="17" cy="8.5" r="1.1" fill="currentColor" stroke="none"/>
</svg>`;

let registered = false;

/** Idempotent: onload() can run more than once across a disable/enable cycle. */
export function registerConfidantIcon(): void {
	if (registered) return;
	registered = true;
	addIcon(CONFIDANT_ICON_ID, CONFIDANT_ICON_SVG);
}
