import type { DisputeVerdict } from '../types';

/** CSS suffix for a verdict badge ('Strong Hire' → 'strong-hire'). */
export function verdictClass(verdict: string): string {
  return verdict.toLowerCase().replace(/[^a-z]+/g, '-');
}

/** Score badge tone: 4+ green, 3+ amber, else red. */
export function scoreClass(score: number): string {
  if (score >= 4) return 'vb-score-good';
  if (score >= 3) return 'vb-score-mid';
  return 'vb-score-bad';
}

export const DISPUTE_VERDICT_LABELS: Record<DisputeVerdict, string> = {
  test_incorrect: 'test incorrect',
  solution_incorrect: 'solution incorrect',
  ambiguous: 'ambiguous',
};

const IMPROVE_HEADING = /^#{1,4}\s.*(improve|weak|gap|missing|issue|fix|next)/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Strip the most common markdown inline markup for plain-text previews. */
function plain(line: string): string {
  return line
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * First few "what to improve" lines from a review body, for history cards.
 * Prefers bullets under an improvement-ish heading; falls back to the first
 * body lines.
 */
export function firstImprovementLines(bodyMd: string, max = 2): string[] {
  const lines = bodyMd.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      if (inSection && out.length > 0) break;
      inSection = IMPROVE_HEADING.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = BULLET.exec(line);
    if (m) {
      out.push(plain(m[1]));
      if (out.length >= max) return out;
    }
  }
  if (out.length > 0) return out;
  // fallback: first non-heading, non-blank lines
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line) || line.trim() === '') continue;
    out.push(plain(line.replace(BULLET, '$1')));
    if (out.length >= max) break;
  }
  return out;
}
