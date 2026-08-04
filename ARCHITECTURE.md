# How Confidant actually works

This is the internals doc — discovery, the rollup/tracking mechanics, memory,
edge cases. None of this is required reading to use the plugin; see the main
[README](README.md) for that. This is for anyone extending Confidant, curious
about a design decision, or debugging something odd.

## How it works

**Discovery.** Every `.md` file under `sourceFolder` (recursively) that has a
resolvable date is a candidate. The date comes from frontmatter `date:` first,
falling back to a `YYYY-MM-DD` in the filename for vaults that use that naming
convention. Notes with neither are ignored.

File mtime is deliberately never consulted, even though it's what the original
script used: iCloud rewrites mtimes when it redownloads a note, so mtime
silently reshuffles entries between weeks.

**Tag filtering.** A note qualifies if it carries at least one tag from
`includeTags` (OR logic), checked against frontmatter tags, inline `#tags`, or
either, per `tagMatchMode`. An empty `includeTags` disables filtering entirely,
so out of the box the plugin behaves like the original script.

**Cadences.**

| Tier | Input | Key |
| --- | --- | --- |
| Weekly | raw daily notes for one ISO week | `2026-W01` |
| Biweekly | the two weekly summaries for weeks 1-2, 3-4, … | `2026-BW01` |
| Monthly | every weekly summary whose ISO week's Thursday falls in that month | `2026-01` |
| Yearly | every monthly summary in that calendar year | `2026` |

Each tier above weekly is a **rollup of the tier directly below it, not a
fresh pass over the raw entries** — see [Design
note](#design-note-rollups-vs-re-analysis). Yearly reads monthly summaries,
never weeklies or raw dailies directly.

A rollup generates once two conditions hold, applied recursively — a monthly
depends on weeklies existing, a yearly depends on monthlies existing:

1. Every period **that has material** at the tier below has a summary on
   disk. A week you didn't journal at all, or a month with no weekly
   summaries, is treated as nothing-to-say and skipped. (A strict
   everything-must-exist rule would let one gap block that period's rollup
   forever — which is the normal case for most people, not an edge case.)
2. The period has **ended**. An in-progress month or year is never summarized
   from its first constituent alone.

If either doesn't hold, the period is skipped and retried on the next run.

**Mood classification.** Optionally, each entry is separately classified into
structured data — primary and secondary emotion, valence (-5 to +5), arousal,
topics, sleep quality, whether the day was spent alone or with others, whether
anything notable happened, and a confidence score. One LLM call per entry, at
low temperature, with every field coerced into its allowed range so malformed
output can't corrupt the dataset.

This runs *before* the weekly synthesis and is handed to it as a second block,
framed as a second opinion to weigh rather than ground truth — so the prose
summary can reason over the measured arc instead of re-deriving it. Rollups
inherit it via the weekly summaries they read.

Re-classification is triggered by a **content hash**, not mtime. The original
script compared mtimes, but iCloud rewrites those on redownload, which would
silently re-classify the whole corpus (one call per entry) after any sync.

Records live in `mood-data.json` in the plugin's config dir, keyed by vault
path, and are pruned when their source note disappears.

**Output.**

```
<outputFolder>/
  Weekly/2026/2026-W01.md
  Biweekly/2026/2026-BW01.md
  Monthly/2026/2026-01.md
  _memory/core.md
```

Each file gets frontmatter with title, generation date, and tags including the
cadence and the model used.

**Memory (three tiers).**

- **Core** — a single size-bounded markdown file at `<outputFolder>/_memory/core.md`.
  Human-readable and safe to hand-edit; rewritten in full by the memory-manager
  call and hard-truncated at `coreMemoryMaxChars` regardless of what the model
  returns.
- **Semantic** — durable extracted facts, embedded and retrieved top-`semanticTopK`.
- **Episodic** — past summaries, embedded and retrieved top-`episodicTopK`.

Embeddings come from a local embedding server over the OpenAI `/v1/embeddings`
shape, independently of the generation backend — so retrieval stays local even
if you switch generation to OpenRouter.

Failures never lose data. If the embedding server is down when a summary is
written, the record is stored *unembedded* rather than dropped, and repaired
later by **"Rebuild memory embeddings"**. During retrieval, an unreachable
server degrades to core-memory-only rather than failing the run. Vectors are
tagged with the model that produced them, so switching models makes stale
records inert instead of returning neighbours from a different vector space.

The embedded stores live in the plugin's own config dir (`memory-store.json`),
not in the vault, so float arrays never show up as notes.

**Two calls per run.** First a synthesis call that writes the summary the user
reads, then a separate memory-manager call that consolidates core memory and
extracts new semantic facts. Keeping them apart means bookkeeping instructions
never shape the summary. If the memory call fails, the summary is still saved.

**Triggering.** Manual commands, plus an optional interval check. The interval
check surfaces a Notice with a "Generate now" button rather than running
unattended, unless `autoRunWithoutConfirmation` is on. Nothing is ever triggered
by a file change alone.

**Truncation handling.** Carried over from the original script: if a reasoning
model opens `<think>` and never closes it (or the API reports
`finish_reason: "length"` mid-thought), the summary is *not* written and the
period is *not* marked processed, so it retries on the next run instead of
committing half a thought to the vault.

## Processed-entry tracking

Stored in the plugin's `data.json` alongside settings:

```json
{
  "weekly":   { "2026-W01": ["2026-01-01.md", "2026-01-02.md"] },
  "biweekly": { "2026-BW01": ["2026-W01.md", "2026-W02.md"] },
  "monthly":  { "2026-01": ["2026-W01.md", "2026-W02.md"] },
  "yearly":   { "2026": ["2026-01.md", "2026-02.md"] }
}
```

A cadence run fires only when its dependency set contains an input not yet
recorded under that key. Note this is **name-based**: editing a daily note
without renaming it will not re-trigger its week. Delete the tracking key (or
the whole entry) to force a regeneration.

## Design note: rollups vs. re-analysis

Biweekly and monthly tiers summarize the weekly summaries, and yearly
summarizes the monthly summaries, rather than any of them re-reading the raw
daily entries. This is deliberate:

- the same daily text is never pushed through the model twice
- each higher tier reasons over already-distilled material
- rollups read their inputs from the episodic store, which is already holding
  past summaries at every tier, instead of needing a second retrieval path

**If you'd rather every tier analyzed the raw entries directly**, the change is
localized but not free: `buildBody()` in `src/pipeline.ts` would load dailies
for every cadence, `resolveWeeklyInputs()`/`resolveMonthlyInputs()` would be
replaced by date-range groupings of daily notes, and the tracking values for
`biweekly`, `monthly` and `yearly` in `src/journal/tracking.ts` would become
daily-note basenames instead of the summary filenames they currently are —
which invalidates any existing tracking data.

## Edge cases handled

- **53-week ISO years.** `2026-BW27` covers week 53 alone, because week 54
  doesn't exist. In 52-week years that pair is never generated.
- **Year-boundary weeks.** `2025-12-29` belongs to `2026-W01`; monthly grouping
  uses the ISO Thursday rule, so a January month can pull in a week whose
  ISO week-year is the previous year.
- **Invalid dates.** `2026-02-31` is rejected rather than rolling over into
  March.
- **Unjournaled periods.** Gaps at any tier don't deadlock the rollup above
  them; see the readiness rules above.
- **Archived summaries.** Candidates at each rollup tier are derived from
  existing summary files one tier down as well as from what's currently
  visible (weeklies for monthly, monthlies for yearly), so moving old
  material out of view doesn't block a rollup that already has what it needs.
