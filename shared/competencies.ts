/**
 * Closed competency vocabulary for behavioral questions (NEE-343).
 *
 * A behavioral question probes exactly one competency out of this fixed
 * set — mirrored in `cli/prompts/categories/behavioral.md`'s Identity and
 * Example Directions sections. Closed, not freeform, for two reasons: a
 * later coverage view (the deferred story bank, NEE-346) can group
 * questions by competency without an unjoinable string-matching problem,
 * and generation's corpus-dedupe (existing competencies fed back into the
 * prompt so five generations in a row don't collapse onto the same one) has
 * something exact to compare against instead of near-miss prose.
 *
 * `shared/` must not import from `cli/` or `ui/` — this module has no
 * dependencies at all, so both sides can use it identically.
 */

export const COMPETENCIES = [
  'conflict',
  'ambiguity',
  'failure',
  'influence-without-authority',
  'prioritisation',
  'mentorship',
  'receiving-feedback',
  'ownership',
] as const;

export type Competency = (typeof COMPETENCIES)[number];

const COMPETENCY_SET: ReadonlySet<string> = new Set(COMPETENCIES);

/**
 * Normalizes free-form text (model output, or a hand-authored README) into
 * a closed `Competency`: lowercased, whitespace/underscore runs collapsed
 * to a single hyphen, anything outside `[a-z0-9-]` dropped, repeated/edge
 * hyphens trimmed. Returns null for empty input or anything that still
 * doesn't land on a known competency after normalization — this never
 * guesses the closest match, it only tolerates formatting noise
 * ("Influence Without Authority", "influence_without_authority").
 */
export function normalizeCompetency(raw: string): Competency | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return COMPETENCY_SET.has(slug) ? (slug as Competency) : null;
}

/**
 * Pulls a competency back out of a rendered README: the
 * `**Competency:** <value>` line `readme.md.hbs`'s `{{competency}}` slot
 * produces. This is how generation's corpus-dedupe feed reads competencies
 * for already-scaffolded behavioral questions — the db has no competency
 * column; the README is the source of truth on purpose (visible framing,
 * not a spoiler; see docs/m7-spec.md's "Where the probes live"). Returns
 * null when the line is absent or its value isn't a known competency.
 */
export function extractCompetencyFromReadme(readme: string): Competency | null {
  const match = /^\*\*Competency:\*\*\s*(.+)$/m.exec(readme);
  return match ? normalizeCompetency(match[1]) : null;
}
