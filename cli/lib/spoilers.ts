// Spoiler chokepoint (NEE-265): the single place that knows which generated
// artifacts are answer key and how to withhold them from anything wire- or
// log-bound. In `lib`, not `server` — gen-pipeline.ts imports it and cli/lib
// must never import cli/server.
import { splitMarkdownSections } from './prompt-builder.js';

/** Replacement text for anything withheld from the wire or a log. */
export const WITHHELD_MARKER = '█ withheld █';

/**
 * The generated-question fields that are answer key: they exist for the
 * review-gated debrief and must never reach the browser outside it.
 * Single source of truth — redactGenerationJob, the masked prompt builders,
 * and the drift guard in spoilers.test.ts all derive from this list.
 */
// followUps (NEE-343, behavioral-only) joins this list, not
// WIRE_SAFE_KEYS.generate: it is the candidate drill-down question bank
// (written to the hidden `.probes.md`, NEE-345's territory), structurally
// the same kind of content as interviewerPacket's own "Skeptical
// Follow-ups" section for coding/design — a probe read before the
// candidate writes their story is worthless the same way a spoiled
// reference solution is. Withholding it here keeps it out of the
// Activity Log's live stream and the generation job's wire result;
// `.probes.md` on disk (never SPOILER_KEYS/redactGenerationJob) is the
// actual reveal path, mirroring how `.interviewer.md` is read straight off
// disk by the review-gated debrief endpoint (reviews.ts), not reconstructed
// from a job row.
export const SPOILER_KEYS = [
  'referenceSolution',
  'solutionCode',
  'interviewerPacket',
  'followUps',
] as const;

const SPOILER_KEY_SET: ReadonlySet<string> = new Set(SPOILER_KEYS);

/**
 * Partitions an object's entries into wire-safe ones and withheld spoiler
 * keys: `safe` preserves every non-spoiler entry as-is, `withheld` names the
 * spoiler keys that were present (whatever their value).
 */
export function splitSpoilers<T extends object>(
  o: T,
): { safe: Record<string, unknown>; withheld: string[] } {
  const safe: Record<string, unknown> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(o)) {
    if (SPOILER_KEY_SET.has(key)) withheld.push(key);
    else safe[key] = value;
  }
  return { safe, withheld };
}

/** Per-step wire allowlist. Fail-closed: an unknown slug maps to the empty set. */
export const WIRE_SAFE_KEYS: Record<string, ReadonlySet<string>> = {
  // competency (NEE-343, behavioral-only) is wire-safe: it is visible
  // interview framing, written straight into the README (the same
  // treatment coding/design questions give their whole problem statement)
  // — knowing "this probes conflict-handling" doesn't hand the candidate an
  // answer. followUps is deliberately NOT here — see SPOILER_KEYS below.
  generate: new Set(['title', 'slug', 'description', 'signature', 'testCode', 'competency']),
  repair: new Set(['title', 'slug', 'description', 'signature', 'testCode', 'competency']),
  'edge-audit': new Set(['description', 'testCode']), // edgeCases withheld — the names are hints
  dispute: new Set(['verdict', 'summary', 'details', 'failingTests', 'fixedTestCode', 'hint']),
  brainstorm: new Set(['reply', 'ideas']),
  // Extraction over the finished review prose — derived from text the user
  // already sees, so every field is safe. (The `review` step itself streams
  // plain chatStream text via append(), never partials.)
  'review-extract': new Set(['score', 'verdict', 'dimensions']),
};

/**
 * Headings whose whole `## ` section is withheld by maskPromptText — the
 * sections our own prompt builders wrap around spoiler content.
 */
const MASKED_HEADINGS: ReadonlySet<string> = new Set([
  'Reference Solution',
  'Interviewer Packet',
  'Verification Failure Report',
  'Solution Code',
]);

/**
 * Deep-replaces every non-null spoiler-keyed value with the withheld marker;
 * arrays/objects are walked, null spoilers stay null (nothing to withhold),
 * everything else passes through untouched.
 */
export function maskSpoilerValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSpoilerValues(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SPOILER_KEY_SET.has(key) && v != null ? WITHHELD_MARKER : maskSpoilerValues(v);
    }
    return out;
  }
  return value;
}

// A ```json fence: opener at line start (optionally indented), body up to
// the first line that is a bare closing ```. JSON.stringify output never
// puts a raw ``` at line start (newlines in strings are escaped), so the
// non-greedy body can't terminate early on well-formed fences.
const JSON_FENCE_RE = /^[ \t]*```json[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/**
 * Pass 1: withhold every MASKED_HEADINGS `## ` block, up to the next `## `.
 * Reuses prompt-builder's fence-aware section scan rather than a fresh
 * regex — capsules embed `## ` inside code fences and so do generated
 * prompts — and reconstructs the unmasked remainder verbatim.
 */
function maskSections(text: string): string {
  const lines: string[] = [];
  for (const section of splitMarkdownSections(text)) {
    if (section.headingLine !== null) lines.push(section.headingLine);
    if (section.heading !== null && MASKED_HEADINGS.has(section.heading)) {
      lines.push('', WITHHELD_MARKER, '');
    } else {
      lines.push(...section.body);
    }
  }
  return lines.join('\n');
}

/**
 * Pass 2: parse each ```json fence and re-serialise with spoiler values
 * withheld. A fence that doesn't parse is replaced whole — fail closed.
 */
function maskJsonFences(text: string): string {
  return text.replace(JSON_FENCE_RE, (_fence, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return WITHHELD_MARKER;
    }
    return '```json\n' + JSON.stringify(maskSpoilerValues(parsed), null, 2) + '\n```';
  });
}

/**
 * Structurally masks prompt text we assembled ourselves. This is the second
 * line of defence for a caller who forgets the constructed maskedPrompt
 * (gen-pipeline builds both variants from the same tagged sections), not the
 * primary mechanism — e.g. a spoiler that embeds its own `## ` headings
 * unfenced would split the section scan.
 */
export function maskPromptText(text: string): string {
  return maskJsonFences(maskSections(text));
}

/**
 * Literal-scrub backstop for the structural masking above: register each
 * spoiler value as it materialises, then scrub every string headed for a
 * log or emission. Catches the one case structure can't — a provider error
 * that echoes prompt content back verbatim. NEE-268's
 * AiRunHandle.registerSecret delegates here.
 */
export class SecretScrubber {
  private readonly literals = new Set<string>();

  /**
   * Registers a secret: the full text plus each of its non-blank lines of
   * ≥40 characters (trimmed), so a partial echo of a multi-line secret is
   * still caught. Short lines are skipped — scrubbing them would eat
   * innocent common substrings. Blank input registers nothing.
   */
  register(text: string): void {
    if (text.trim().length === 0) return;
    this.literals.add(text);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 40) this.literals.add(trimmed);
    }
  }

  /** Replaces every occurrence of every registered literal, longest first. */
  scrub(text: string): string {
    let out = text;
    for (const literal of [...this.literals].sort((a, b) => b.length - a.length)) {
      out = out.split(literal).join(WITHHELD_MARKER);
    }
    return out;
  }
}
