/**
 * Preview fixture derivation (NEE-352): given the `signature` a web-components
 * question scaffolds from (an optional `interface`/`type` declaration plus a
 * bare component declaration head — see cli/prompts/categories/web-components.md
 * for the exact contract), synthesises the CONTENT for a seeded `preview.tsx`:
 * the component's export name plus a plausible example-props object literal.
 *
 * This is a best-effort, regex-based reader of the signature text — not a
 * real TypeScript parser. When anything fails to parse (an unusual shape,
 * no signature at all, a props type this heuristic doesn't recognise) it
 * degrades to an empty-but-valid fixture (`propsCode: '{}'`) rather than
 * throwing: a bare preview is still strictly better than no preview.tsx at
 * all, and the file is a seed the user can freely edit either way.
 */

export interface PreviewFixtureData {
  /** The named export to import from './Component' (falls back to "Component"). */
  componentName: string;
  /** Source text of a props object literal, spread onto the mounted component. */
  propsCode: string;
}

/** Text-index of `open` at `openIdx`, scanned forward to its matching `close` (same-char depth counting only). */
function extractBalanced(
  text: string,
  open: string,
  close: string,
  openIdx: number,
): { content: string; endIdx: number } | null {
  if (text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx + 1, i), endIdx: i };
    }
  }
  return null;
}

/**
 * Splits on the given separator chars, but only at bracket depth 0 — so a
 * nested `(next: string[]) => void` never gets sliced in half. Deliberately
 * NOT tracking `<`/`>` (generics): the `>` in an arrow function's `=>` would
 * be miscounted as a lone close-bracket with no matching open, driving depth
 * negative and breaking every split after it.
 */
function splitTopLevel(text: string, seps: string[]): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (depth === 0 && seps.includes(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every top-level `interface Name { ... }` / `type Name = { ... }` in the signature, by name -> raw body. */
function parseInterfaces(signature: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:interface|type)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*)?{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(signature))) {
    const braceIdx = match.index + match[0].length - 1;
    const balanced = extractBalanced(signature, '{', '}', braceIdx);
    if (balanced) map.set(match[1], balanced.content);
  }
  return map;
}

/** From a param-list's raw text (e.g. `{ value, onChange }: TagInputProps` or `props: FooProps`), the type annotation text — or null when there isn't one. */
function paramTypeText(paramList: string): string | null {
  const trimmed = paramList.trim();
  if (trimmed === '') return null;
  let idx: number;
  if (trimmed[0] === '{') {
    const balanced = extractBalanced(trimmed, '{', '}', 0);
    idx = balanced ? balanced.endIdx + 1 : trimmed.length;
  } else {
    idx = 0;
    while (idx < trimmed.length && /[\w$]/.test(trimmed[idx])) idx++;
  }
  const rest = trimmed.slice(idx).trim();
  return rest.startsWith(':') ? rest.slice(1).trim() : null;
}

/** Resolves a type annotation (an inline `{ ... }` object type, or an identifier looked up in `interfaces`) to its raw field body. */
function resolveObjectBody(typeText: string, interfaces: Map<string, string>): string {
  const trimmed = typeText.trim();
  if (trimmed.startsWith('{')) {
    const balanced = extractBalanced(trimmed, '{', '}', 0);
    return balanced ? balanced.content : '';
  }
  const idMatch = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
  return idMatch ? (interfaces.get(idMatch[1]) ?? '') : '';
}

interface PropField {
  name: string;
  type: string;
  optional: boolean;
}

function parseFields(body: string): PropField[] {
  const cleaned = stripComments(body);
  const fields: PropField[] = [];
  for (const entry of splitTopLevel(cleaned, [';', ','])) {
    const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m) continue;
    fields.push({ name: m[1], optional: m[2] === '?', type: m[3].trim() });
  }
  return fields;
}

/** Title-Cases a camelCase/kebab-case/snake_case identifier into words (`maxTags` -> `Max Tags`). */
function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A plausible literal for one field, as JS source text — never throws, degrades to `'{}'`-shaped fallbacks for anything unrecognised. */
function valueForField(name: string, rawType: string): string {
  const type = rawType.trim().replace(/\s*\|\s*undefined\s*$/, '');
  const lower = name.toLowerCase();

  if (/=>/.test(type)) {
    // A handler prop — an arity-agnostic logger beats a silent no-op: it
    // proves the wiring works the moment the user interacts with the preview.
    return `(...args) => console.log(${JSON.stringify(name)}, ...args)`;
  }
  const literalMatch = /'([^']*)'/.exec(type);
  if (literalMatch && !/\[\]\s*$/.test(type)) {
    return JSON.stringify(literalMatch[1]);
  }
  if (/\[\]\s*$/.test(type)) {
    const element = type.replace(/\[\]\s*$/, '').trim();
    if (element === 'string') return `['Example one', 'Example two']`;
    if (element === 'number') return `[1, 2, 3]`;
    return '[]';
  }
  if (/^boolean$/.test(type)) return 'false';
  if (/^number$/.test(type)) {
    // Timer-named props (durationMs, delay, timeoutMs, pollIntervalMs, ...) seeded
    // 1 made otherwise-correct solutions auto-dismiss instantly, so the preview
    // looked broken — 5000ms is a humanly-visible default. Checked before the
    // max/min/count checks below: maxDurationMs must hit this rule, not 'max'.
    // The suffix check is the capital-M unit suffix on the RAW name — a
    // case-insensitive ends-with-ms would swallow plurals (maxItems, numForms).
    if (/[a-z0-9]Ms$/.test(name) || /duration|delay|timeout|interval/.test(lower)) return '5000';
    if (lower.includes('max')) return '10';
    if (lower.includes('min')) return '0';
    if (lower.includes('count') || lower.includes('total')) return '3';
    return '1';
  }
  if (/^string$/.test(type)) {
    if (lower === 'label') return `'Example label'`;
    if (lower.includes('placeholder')) return `'Type here…'`;
    if (lower.includes('title')) return `'Example title'`;
    return JSON.stringify(`Example ${humanize(name)}`);
  }
  return '{}';
}

/**
 * Derives a preview fixture from a scaffold `signature` string. Never throws:
 * a null/empty/unparseable signature degrades to `{ componentName: 'Component',
 * propsCode: '{}' }` — a bare mount, matching the no-signature Component.tsx.hbs
 * branch (`export function Component()`).
 */
export function derivePreviewFixture(signatureInput: string | null | undefined): PreviewFixtureData {
  const fallback: PreviewFixtureData = { componentName: 'Component', propsCode: '{}' };
  const signature = (signatureInput ?? '').trim();
  if (!signature) return fallback;

  const funcMatch = /function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(signature);
  if (!funcMatch) return fallback;
  const componentName = funcMatch[1];

  const parenStart = signature.indexOf('(', funcMatch.index);
  const balancedParens = extractBalanced(signature, '(', ')', parenStart);
  const paramList = balancedParens ? balancedParens.content : '';

  const typeText = paramTypeText(paramList);
  if (typeText == null) return { componentName, propsCode: '{}' };

  const interfaces = parseInterfaces(signature);
  const body = resolveObjectBody(typeText, interfaces);
  const fields = parseFields(body);
  if (fields.length === 0) return { componentName, propsCode: '{}' };

  const lines = fields.map((f) => `  ${f.name}: ${valueForField(f.name, f.type)},`);
  return { componentName, propsCode: `{\n${lines.join('\n')}\n}` };
}
