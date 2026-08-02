import { Cadence } from "../settings";

/**
 * Cadence-namespaced processed-entry tracking.
 *
 * For `weekly`, the recorded values are daily-note basenames. For `biweekly`
 * and `monthly` they are the *weekly summary* filenames that were rolled up,
 * because those summaries — not the raw dailies — are the actual inputs to
 * those tiers.
 */
export interface ProcessedDb {
	weekly: Record<string, string[]>;
	biweekly: Record<string, string[]>;
	monthly: Record<string, string[]>;
	yearly: Record<string, string[]>;
}

export function emptyDb(): ProcessedDb {
	return { weekly: {}, biweekly: {}, monthly: {}, yearly: {} };
}

export function normalizeDb(raw: unknown): ProcessedDb {
	const db = emptyDb();
	if (!raw || typeof raw !== "object") return db;
	const obj = raw as Record<string, unknown>;
	for (const cadence of ["weekly", "biweekly", "monthly", "yearly"] as Cadence[]) {
		const section = obj[cadence];
		if (!section || typeof section !== "object") continue;
		for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
			if (Array.isArray(value)) db[cadence][key] = value.map(String);
		}
	}
	return db;
}

/**
 * A cadence run fires only when its dependency set differs from what's already
 * recorded under that key — i.e. there is at least one input not yet reflected.
 */
export function needsRun(db: ProcessedDb, cadence: Cadence, key: string, inputs: string[]): boolean {
	const recorded = new Set(db[cadence][key] ?? []);
	return inputs.some((i) => !recorded.has(i));
}

export function markProcessed(
	db: ProcessedDb,
	cadence: Cadence,
	key: string,
	inputs: string[]
): void {
	db[cadence][key] = [...inputs].sort();
}
