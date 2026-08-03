import {
  APICallError,
  generateObject,
  NoObjectGeneratedError,
  Output,
  streamText,
  type LanguageModel,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { z } from 'zod';
import { loadAceConfig, type AceConfig } from './config.js';
import type { LLMSlot } from '../../shared/wire-types.js';

export type LLMProvider = 'openai' | 'anthropic';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const mockLlm =
  process.env.ACE_E2E_MOCK_LLM === '1' || process.env.ACE_E2E_MOCK_LLM === 'true';

// Mock payloads for keyless testing, keyed by the shape of structured-output
// call each one impersonates. `getMockResponse()` is used by both `chatStream`
// (env-var-selected, unstructured text) and `chatObject`'s explicit-mode
// override path; `chatObject`'s no-mode-var path instead dispatches on the
// caller's zod schema (see MOCK_OBJECT_CANDIDATES below) so one keyless
// server process can serve multiple structured-output shapes.
function getGenerateMockPayload() {
  return {
    title: 'Two Sum',
    slug: 'two-sum',
    description: 'Return indices of the two numbers such that they add up to target.',
    signature: 'export function twoSum(nums: number[], target: number): number[]',
    // GeneratedQuestionSchema's optional fields are required-and-nullable
    // (strict structured outputs, NEE-263) — omitting the keys would fail
    // schema dispatch, so the unused artifacts are explicit nulls. This
    // payload is shared across every category in mock mode (there is only
    // one 'generate'-shaped candidate), so competency/followUps (NEE-343,
    // behavioral-only) and estimatedMinutes/supportCode stay null here too —
    // a keyless e2e run exercises the schema/scaffold plumbing, not real
    // content (mock mode also never reaches the calibrate stage, which is
    // what would otherwise fill estimatedMinutes in).
    testCode: null,
    supportCode: null,
    solutionCode: null,
    referenceSolution: null,
    interviewerPacket: null,
    estimatedMinutes: null,
    competency: null,
    followUps: null,
  };
}

export function getDisputeMockPayload() {
  return {
    verdict: 'test_incorrect',
    summary: 'The expected output for one case does not match the problem statement.',
    details: 'The failing assertion expects an index order that is not required by the spec.',
    failingTests: [
      {
        testName: 'handles duplicate values',
        verdict: 'test_incorrect',
        explanation: 'Either index order is acceptable, but the test fixes one order.',
        fixedAssertion: 'expect(result.sort()).toEqual([0, 1])',
      },
    ],
    fixedTestCode:
      "import { describe, it, expect } from 'vitest';\n\ndescribe('two sum', () => {\n  it('handles duplicate values', () => {\n    const result = [1, 0];\n    expect(result.sort()).toEqual([0, 1]);\n  });\n});\n",
    // Required-and-nullable (strict structured outputs, NEE-263/NEE-378
    // class) — the key must be present, so the unused field is an explicit
    // null, mirroring getGenerateMockPayload above.
    hint: null,
  };
}

function getBrainstormMockPayload() {
  return {
    reply: 'Here are a few ideas to get you started — let me know if you want variations.',
    ideas: [
      {
        title: 'Debounced Search Box',
        category: 'react-apps',
        difficulty: 'medium',
        pitch: 'Build a search input that debounces API calls and cancels stale requests.',
        topic: 'Implement a React search box component with debounced, cancelable API calls.',
      },
      {
        title: 'LRU Cache',
        category: 'leetcode-ds',
        difficulty: 'medium',
        pitch: 'Classic data structure question combining a hash map and a doubly linked list.',
        topic: 'Design and implement an LRU cache with O(1) get/put.',
      },
    ],
  };
}

function getProbeMockPayload() {
  return {
    probes: [
      {
        question: 'What would the other engineer say about how you handled it?',
        source: 'derived',
      },
      {
        question: 'How would your approach change if this happened at 10x the team size?',
        source: 'derived',
      },
    ],
  };
}

function getReviewExtractionMockPayload() {
  return {
    score: 4,
    verdict: 'Hire',
    // {name, score} pairs, not a map — mirrors ReviewExtractionSchema's
    // strict-compatible wire shape (NEE-378).
    dimensions: [
      { name: 'Correctness', score: 4 },
      { name: 'Code Quality', score: 4 },
      { name: 'Edge Case Handling', score: 3 },
    ],
  };
}

function getMockResponse(): string {
  const mode = process.env.ACE_MOCK_LLM_MODE || '';

  if (mode === 'generate') {
    return JSON.stringify(getGenerateMockPayload(), null, 2);
  }

  if (mode === 'dispute') {
    return JSON.stringify(getDisputeMockPayload(), null, 2);
  }

  if (mode === 'brainstorm') {
    return JSON.stringify(getBrainstormMockPayload(), null, 2);
  }

  if (mode === 'probe') {
    return JSON.stringify(getProbeMockPayload(), null, 2);
  }

  if (mode === 'feedback') {
    return 'Overall 4/5\n\nClear solution structure and correct approach. Add a brief complexity note.';
  }

  return 'OK';
}

// Tried in order, against the caller's schema, when chatObject runs in mock
// mode with no explicit ACE_MOCK_LLM_MODE override — first validated wins.
const MOCK_OBJECT_CANDIDATES: Array<() => unknown> = [
  getGenerateMockPayload,
  getDisputeMockPayload,
  getBrainstormMockPayload,
  getProbeMockPayload,
  getReviewExtractionMockPayload,
];

// Load config once at module level
let cachedConfig: AceConfig | null = null;

function getConfig(): AceConfig {
  if (!cachedConfig) {
    cachedConfig = loadAceConfig();
  }
  return cachedConfig;
}

/** Long-running processes (ace ui) must call this after writing ~/.ace/config.json. */
export function clearConfigCache(): void {
  cachedConfig = null;
  // A settings save is also the one moment a Fable retry is worth paying
  // again: the org's data-retention posture (or its key) may have changed.
  fableSessionFallback = false;
}

export function isMockLlm(): boolean {
  return mockLlm;
}

function getAvailableProviders(): LLMProvider[] {
  const config = getConfig();
  const providers: LLMProvider[] = [];
  if (config.OPENAI_API_KEY) providers.push('openai');
  if (config.ANTHROPIC_API_KEY) providers.push('anthropic');
  return providers;
}

export function getDefaultProvider(): LLMProvider | null {
  const config = getConfig();
  const available = getAvailableProviders();
  if (available.length === 0) return null;

  // Respect saved preference if that provider is available
  if (config.default_provider && available.includes(config.default_provider as LLMProvider)) {
    return config.default_provider as LLMProvider;
  }

  // Default to openai if available, otherwise first available
  if (available.includes('openai')) return 'openai';
  return available[0];
}

/**
 * True when this provider can be called at all right now. Mock mode has every
 * provider by construction — no call is ever made — and updateSettings accepts
 * per-slot overrides on exactly that rule, so resolution and the selectable
 * catalog must agree with it or Settings offers rows it cannot serve.
 */
function hasKey(provider: LLMProvider): boolean {
  return mockLlm || getAvailableProviders().includes(provider);
}

/**
 * Whether ANY server-initiated LLM call can run: mock mode short-circuits
 * every call below, otherwise at least one provider key must exist. Which
 * MODEL runs is `resolveSlot`'s job — this is only the keyless gate.
 */
export function hasAnyProvider(): boolean {
  return mockLlm || getAvailableProviders().length > 0;
}

/**
 * One routable step of the product. Declared in shared/wire-types.ts (GET
 * /api/settings exposes the resolved routes) and re-exported here so the
 * existing `./llm.js` importers are untouched.
 */
export type { LLMSlot };

/** Where a slot's model came from — surfaced per row in Settings. */
export type RouteSource = 'default' | 'override' | 'provider-fallback' | 'fable-fallback';

/**
 * The provider + model THIS call will use, plus how it got there. `warning`
 * is non-null only when a saved override could not be honored: an override
 * naming an unknown model, or one whose provider has no key, falls back —
 * but never silently.
 */
export interface ResolvedRoute {
  provider: LLMProvider;
  model: string;
  source: RouteSource;
  warning: string | null;
}

// Every model a slot may route to, by the provider that serves it. A model
// outside this catalog is not selectable: an override naming one resolves to
// a warning, never to a call. Keyed as Record<LLMProvider, …> so adding a
// provider breaks the build here instead of silently offering nothing.
//
// gpt-5.6-terra / gpt-5.6-luna verified against the OpenAI model docs on
// 2026-07-27: both exist (1.05M context, 128K max output, $2.50/$15 and
// $1/$6 per MTok) and are served on Chat Completions, which .chat() below
// pins — and luna's context comfortably holds a full review transcript for
// 'review-extract'. claude-haiku-4-5 (200K context, 64K output) likewise
// still fits review-extract inputs.
//
// NOTE: the Claude 5-series (claude-opus-5, claude-sonnet-5, claude-fable-5)
// rejects temperature/top_p/top_k with a 400, exactly like claude-opus-4-8
// and claude-opus-4-6 — never add sampling params to these calls (none are
// set anywhere today). Adaptive thinking is also ON by default across the
// Opus/Sonnet 5 family and counts against maxOutputTokens — see toCallInput
// below for the sizing.
const KNOWN_MODELS: Record<LLMProvider, readonly string[]> = {
  anthropic: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-6',
  ],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
};

const PROVIDERS: readonly LLMProvider[] = ['openai', 'anthropic'];

/** The provider that serves a model id, or null when it is outside the catalog. */
export function getModelProvider(model: string): LLMProvider | null {
  for (const provider of PROVIDERS) {
    if (KNOWN_MODELS[provider].includes(model)) return provider;
  }
  return null;
}

// Every SLOT_ROUTES entry is in KNOWN_MODELS — pinned by llm.test.ts's drift
// guard, so this never returns null for a table model.
function providerOf(model: string): LLMProvider {
  return getModelProvider(model) as LLMProvider;
}

/** Every model selectable right now — key-present providers only. */
export function getAvailableModels(): Array<{ provider: LLMProvider; model: string }> {
  const models: Array<{ provider: LLMProvider; model: string }> = [];
  for (const provider of PROVIDERS) {
    if (!hasKey(provider)) continue;
    for (const model of KNOWN_MODELS[provider]) models.push({ provider, model });
  }
  return models;
}

// Per-slot routing policy: each step of the product picks the model that is
// actually best at it, across providers, instead of a tier lookup inside one
// vendor. `alternate` is what a user who lacks the default's provider key
// gets — the same step, served by the other vendor — so a single-key install
// still runs every step.
//
// Slot rationale:
// - draft-problem / author-tests: GPT-5.6 writes tighter problem statements
//   and stricter test suites; author-solution / edge-audit sit on the
//   Opus 4.x line, which is the stronger code author and the more consistent
//   critic (consistency > cost on an audit that gates the verify loop).
// - calibrate is a small, blind, structured judgement — luna's basic tier is
//   sized for it (NEE-364 is why it is structured-output-only, not chat).
// - repair leads with claude-fable-5 (see the Fable notes below) and falls
//   back automatically; review-escalated is deliberately anthropic-only.
//
// review-escalated is the ONE slot with no alternate: it exists to re-judge
// revised work with a stronger model than `review`, and an openai-only
// install has no such tier to escalate to — reviews.ts then keeps using the
// `review` slot (resolveSlot returns null here, which IS the signal).
const SLOT_ROUTES: Record<LLMSlot, { default: string; alternate: string | null }> = {
  'draft-problem': { default: 'gpt-5.6-terra', alternate: 'claude-sonnet-5' },
  'author-solution': { default: 'claude-opus-4-8', alternate: 'gpt-5.6-sol' },
  'author-tests': { default: 'gpt-5.6-sol', alternate: 'claude-opus-5' },
  'author-packet': { default: 'claude-sonnet-5', alternate: 'gpt-5.6-terra' },
  'edge-audit': { default: 'claude-opus-4-6', alternate: 'gpt-5.6-sol' },
  calibrate: { default: 'gpt-5.6-luna', alternate: 'claude-haiku-4-5' },
  repair: { default: 'claude-fable-5', alternate: 'gpt-5.6-sol' },
  review: { default: 'claude-sonnet-5', alternate: 'gpt-5.6-sol' },
  'review-escalated': { default: 'claude-opus-5', alternate: null },
  'review-extract': { default: 'claude-haiku-4-5', alternate: 'gpt-5.6-luna' },
  probe: { default: 'claude-sonnet-5', alternate: 'gpt-5.6-terra' },
  dispute: { default: 'claude-opus-5', alternate: 'gpt-5.6-sol' },
  brainstorm: { default: 'claude-sonnet-5', alternate: 'gpt-5.6-terra' },
};

/** Every slot SLOT_ROUTES routes — the iteration order Settings persists against. */
export const ALL_SLOTS = Object.keys(SLOT_ROUTES) as LLMSlot[];

export function isLLMSlot(value: string): value is LLMSlot {
  return Object.prototype.hasOwnProperty.call(SLOT_ROUTES, value);
}

/** The hardcoded default for a slot — what "reset to default" restores. */
export function getSlotDefault(slot: LLMSlot): string {
  return SLOT_ROUTES[slot].default;
}

// Fable is 2x the cost of Opus 5, unavailable under zero data retention
// (every request 400s), runs always-on thinking, and its safety classifiers
// can end a turn with stop_reason "refusal" on an HTTP 200. It leads the
// `repair` slot anyway — repair is where its editing strength pays — but
// only because both failure modes fall back to Opus 5 automatically below.
const FABLE_MODEL = 'claude-fable-5';
const FABLE_FALLBACK_MODEL = 'claude-opus-5';

// A ZDR org 400s EVERY Fable request, so the first 400 latches the swap for
// the process instead of paying the same failure once per call. Cleared by
// clearConfigCache() — a settings save is the one moment it's worth retrying.
let fableSessionFallback = false;

function fableFallbackRoute(route: ResolvedRoute): ResolvedRoute {
  return { ...route, model: FABLE_FALLBACK_MODEL, source: 'fable-fallback' };
}

function applyFableLatch(route: ResolvedRoute): ResolvedRoute {
  return fableSessionFallback && route.model === FABLE_MODEL ? fableFallbackRoute(route) : route;
}

/**
 * A slot's resolution together with the saved override that produced it —
 * everything one Settings row needs. `warning` rides HERE as well as on
 * `route` because a rejected override must never be silent (plan: "invalid →
 * warning, never silent") and a slot that resolves to NOTHING has `route`
 * null, with nowhere else to say so. `override` is the saved model id whether
 * or not it was honored — it is what "reset to default" clears, so the UI
 * must know about it even when the route it produced is a fallback.
 */
export interface SlotResolution {
  route: ResolvedRoute | null;
  override: string | null;
  warning: string | null;
}

/**
 * How a slot resolves right now. Resolution order, highest first:
 *
 * 1. a saved override, if the model is known AND its provider has a key;
 *    an override that fails either test falls through carrying a warning.
 * 2. the slot's default, if its provider has a key.
 * 3. the slot's keyless-provider alternate, if it has one and has a key.
 * 4. nothing — this slot cannot run.
 *
 * Mock mode is not a step of its own: `hasKey` reports every provider there,
 * so a mock run resolves the same way a fully-keyed one does — including
 * honoring a saved override, which updateSettings accepts in mock mode and
 * which reporting the bare default would have silently discarded.
 */
export function resolveSlotDetail(slot: LLMSlot): SlotResolution {
  const route = SLOT_ROUTES[slot];
  const saved = getConfig().model_overrides?.[slot];
  const override = typeof saved === 'string' && saved.length > 0 ? saved : null;

  let warning: string | null = null;
  if (override !== null) {
    const provider = getModelProvider(override);
    if (!provider) {
      warning = `"${override}" is not a model ace can route to — using the default instead.`;
    } else if (!hasKey(provider)) {
      warning = `no ${provider} API key — the saved "${override}" choice cannot run.`;
    } else {
      return {
        route: applyFableLatch({ provider, model: override, source: 'override', warning: null }),
        override,
        warning: null,
      };
    }
  }

  const defaultProvider = providerOf(route.default);
  if (hasKey(defaultProvider)) {
    return {
      route: applyFableLatch({
        provider: defaultProvider,
        model: route.default,
        source: 'default',
        warning,
      }),
      override,
      warning,
    };
  }
  if (route.alternate) {
    const altProvider = providerOf(route.alternate);
    if (hasKey(altProvider)) {
      return {
        route: applyFableLatch({
          provider: altProvider,
          model: route.alternate,
          source: 'provider-fallback',
          warning,
        }),
        override,
        warning,
      };
    }
  }
  return { route: null, override, warning };
}

/** The provider/model a slot resolves to right now, or null when nothing can serve it. */
export function resolveSlot(slot: LLMSlot): ResolvedRoute | null {
  return resolveSlotDetail(slot).route;
}

/**
 * The model id a slot resolves to — for callers that persist which model
 * produced an output (review rows, probe sets) without re-stating ids. Falls
 * back to the slot's default when nothing resolves, so a persisted row is
 * never blank: callers only reach this after a call actually ran.
 */
export function getModelId(slot: LLMSlot): string {
  return resolveSlot(slot)?.model ?? SLOT_ROUTES[slot].default;
}

/**
 * Every slot's current resolution — what GET /api/settings exposes so the UI
 * can state which model a paid action will invoke *before* the user commits
 * to it, and so Settings can render (and edit) the whole routing table.
 */
export function getSlotRoutes(): Record<LLMSlot, SlotResolution> {
  const routes = {} as Record<LLMSlot, SlotResolution>;
  for (const slot of ALL_SLOTS) routes[slot] = resolveSlotDetail(slot);
  return routes;
}

// When no fetchImpl is given the factories must receive no `fetch` key at
// all — default construction stays exactly as before NEE-322.
export function getModelFor(route: ResolvedRoute, fetchImpl?: typeof fetch): LanguageModel {
  const config = getConfig();
  if (route.provider === 'openai') {
    // .chat() pins the Chat Completions API rather than the Responses API.
    return createOpenAI({
      apiKey: config.OPENAI_API_KEY,
      ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }).chat(route.model);
  }
  // A base URL (e.g. a local proxy exposing /v1/messages) still speaks the
  // native Anthropic wire protocol, so the same SDK client is used either way.
  return createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })(route.model);
}

function requireRoute(slot: LLMSlot): ResolvedRoute {
  const route = resolveSlot(slot);
  if (!route) {
    throw new Error(`no model can run the "${slot}" step — add an API key in Settings`);
  }
  return route;
}

type RefusalMetadata = { anthropic?: { stopDetails?: { type?: unknown } } } | undefined;

/**
 * @ai-sdk/anthropic maps stop_reason "refusal" to finishReason
 * 'content-filter' on an HTTP 200 (verified against the pinned provider
 * package). `stopDetails` rides along on providerMetadata but the SDK's own
 * docs say to branch on the finish reason — a refusal may carry no details
 * at all — so that is the primary test and the metadata only a backstop.
 */
function isRefusalFinish(finishReason: unknown, providerMetadata?: unknown): boolean {
  if (finishReason === 'content-filter') return true;
  return (providerMetadata as RefusalMetadata)?.anthropic?.stopDetails?.type === 'refusal';
}

async function isRefusedStream(result: {
  finishReason?: PromiseLike<unknown>;
  providerMetadata?: PromiseLike<unknown>;
}): Promise<boolean> {
  return isRefusalFinish(await result.finishReason, await result.providerMetadata);
}

/**
 * The route to retry a failed Fable call on, or null to let the error stand.
 * A 400 means the org runs zero data retention, where EVERY Fable request
 * fails — so it latches for the session; a refusal is per-request and never
 * latches. Any other model, or any other error, is not ours to retry.
 */
function fableRetryRoute(route: ResolvedRoute, err: unknown): ResolvedRoute | null {
  if (route.model !== FABLE_MODEL) return null;
  if (APICallError.isInstance(err) && err.statusCode === 400) {
    fableSessionFallback = true;
    return fableFallbackRoute(route);
  }
  if (NoObjectGeneratedError.isInstance(err) && isRefusalFinish(err.finishReason)) {
    return fableFallbackRoute(route);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Double-encoded structured output (NEE-411)
// ---------------------------------------------------------------------------
//
// Observed live on the `probe` slot: the model answered with its whole payload
// JSON-encoded *into* the single field the payload was supposed to contain —
//
//   {"probes": "{\"probes\":[{\"question\":\"…\",\"source\":\"derived\"}, …]}"}
//
// The inner object was complete and perfectly valid; only the envelope was
// wrong. The AI SDK's schema check rejected it, and every caller here turned
// that into a hard user-facing failure ("the model did not return parseable
// follow-up probes"), throwing away a good, already-paid-for answer. Retrying
// by hand produced the same content on the next sample.
//
// So: before an unparseable structured response is allowed to fail, try a few
// mechanical re-readings of the raw text and see whether any of them satisfy
// the CALLER'S OWN schema. That schema stays the sole judge — nothing here
// loosens, coerces, or repairs anything, so a genuinely bad response still
// fails exactly as it does today.

// JSON.parse rounds per candidate, counting the first parse of `err.text`.
// The shape observed above needs 2; 3 leaves one round of headroom without
// letting a pathological payload walk forever.
const SALVAGE_MAX_DEPTH = 3;

// The walk branches twice per JSON-ish string field and the widest schema here
// (GeneratedQuestionSchema) has 12 — a flat ceiling is cheaper to reason about
// than a per-level one, and any real double-encode is found in the first few.
const SALVAGE_MAX_CANDIDATES = 16;

/**
 * Strict JSON.parse, `undefined` on failure.
 *
 * Deliberately NOT the SDK's `fixJson`/`parsePartialJson` (which back
 * `partialOutputStream`): those close unterminated strings and arrays, which
 * would turn a TRUNCATED response into a valid-looking short one. ProbeResultSchema
 * accepts 2..4 probes, so a four-probe answer cut off mid-flight would "repair"
 * into a plausible two-probe answer and be saved as if the model meant it.
 */
function parseStrictJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A string that could be a JSON object or array — the only thing worth
 * decoding. Bare scalars are excluded on purpose: turning `"42"` into `42`
 * is type coercion (exactly what the caller's schema is there to catch),
 * not un-encoding.
 */
function looksLikeJsonContainer(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Yields the re-readings of `raw` worth testing against a schema, nearest
 * interpretation first.
 *
 * For every string-valued field that looks like JSON, two readings are tried,
 * in this order:
 *   1. DECODE — replace just that field with its parsed value, keeping every
 *      sibling. Strictly less lossy, so it goes first.
 *   2. COLLAPSE — the parsed value *is* the whole payload and the outer object
 *      was a stray envelope. This is the shape actually observed in the wild.
 */
function* salvageCandidates(raw: unknown, depth: number): Generator<unknown> {
  yield raw;
  if (depth >= SALVAGE_MAX_DEPTH) return;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return;

  for (const [key, value] of Object.entries(raw)) {
    if (!looksLikeJsonContainer(value)) continue;
    const inner = parseStrictJson(value);
    if (inner === undefined) continue;
    yield* salvageCandidates({ ...raw, [key]: inner }, depth + 1);
    yield* salvageCandidates(inner, depth + 1);
  }
}

/**
 * Recovers a schema-valid object from a failed structured-output call, or
 * `undefined` when there is nothing honest to recover.
 *
 * Total by contract — it validates with `safeParse` and never throws. That is
 * load-bearing: `job-engine.ts`'s `toEngineErrorMessage` keys its friendly
 * fallback off `NoObjectGeneratedError` identity, and `generation.ts` persists
 * `err.text` into the job row's rawText column. Substituting a different error
 * on the way out would break both.
 */
export function salvageObject<T>(schema: z.ZodType<T>, err: unknown): T | undefined {
  if (!NoObjectGeneratedError.isInstance(err)) return undefined;
  if (!err.text) return undefined;
  // Truncation and refusal have nothing mis-encoded to un-wrap: a 'length'
  // finish means the bytes needed are simply absent, and "salvaging" that is
  // precisely the masking this must not do. A refusal is fableRetryRoute's
  // business, and its text is prose, not a payload.
  if (err.finishReason === 'length' || isRefusalFinish(err.finishReason)) return undefined;

  const raw = parseStrictJson(err.text);
  if (raw === undefined) return undefined;

  let tried = 0;
  for (const candidate of salvageCandidates(raw, 0)) {
    if (++tried > SALVAGE_MAX_CANDIDATES) break;
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// Statuses whose Response constructor rejects a body outright — those (and
// bodyless responses) must pass through untouched or the wrap itself throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Wraps a fetch so every raw chunk of the response body fires `onChunk` and
 * passes through byte-identical (NEE-322). Raw bytes are the only liveness
 * signal that survives a buffering proxy: it can hold back every partial
 * object for an entire healthy turn while SSE pings keep the socket alive.
 * Callback throws are swallowed — a logging bug must never kill a paid call.
 */
export function withResponseActivityTap(
  onChunk: () => void,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response;
    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            onChunk();
          } catch {
            // Swallowed by contract — see the doc comment.
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function toCallInput(
  messages: LLMMessage[],
  // Default doubled from 4096 (NEE-274): adaptive thinking is on by default
  // on claude-opus-5/claude-sonnet-5 and counts against maxOutputTokens, so
  // a cap sized tightly around the visible answer can truncate mid-response.
  maxOutputTokens = 8192,
): {
  instructions?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
} {
  // AI SDK 7 rejects system-role messages inside `messages`; the system
  // prompt must go through the top-level `instructions` param.
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  return {
    ...(systemMsg ? { instructions: systemMsg.content } : {}),
    messages: nonSystemMessages,
    maxOutputTokens,
  };
}

export async function chatStream(
  slot: LLMSlot,
  messages: LLMMessage[],
  opts?: {
    abortSignal?: AbortSignal;
    /** Same contract as chatObjectStream's onStreamActivity (NEE-322):
     *  fired on every raw chunk of the underlying HTTP response body,
     *  including frames that never materialise a text delta — the only
     *  liveness signal that survives a buffering proxy or a long
     *  adaptive-thinking pause (NEE-361). Swallow contract identical to
     *  onPartial elsewhere: a logging bug must never kill a paid call. */
    onStreamActivity?: () => void;
    /** The route this call is actually running on, fired again for a Fable
     *  fallback retry. Callers that PERSIST which model produced an output
     *  must record THIS, not a re-resolution: a refusal retry is per-request
     *  and deliberately does not latch, so the slot still resolves to Fable
     *  afterwards. Never fired in mock mode (no route is taken). Same swallow
     *  contract as onStreamActivity. */
    onRoute?: (route: ResolvedRoute) => void;
  },
): Promise<AsyncIterable<string>> {
  const fireActivity = (): void => {
    try {
      opts?.onStreamActivity?.();
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };
  const fireRoute = (route: ResolvedRoute): void => {
    try {
      opts?.onRoute?.(route);
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };

  if (mockLlm) {
    const response = getMockResponse();
    return {
      async *[Symbol.asyncIterator]() {
        fireActivity();
        yield response;
      },
    };
  }

  // Every request this call issues goes through here, retries included, so
  // this is the one place onRoute can report the route actually used.
  const start = (route: ResolvedRoute) => {
    fireRoute(route);
    return streamText({
      // The tapped fetch is scoped to THIS call's model — same threading as
      // chatObjectStream; without the callback getModelFor receives no fetch
      // at all and construction is unchanged.
      model: getModelFor(
        route,
        opts?.onStreamActivity ? withResponseActivityTap(fireActivity) : undefined,
      ),
      ...toCallInput(messages),
      abortSignal: opts?.abortSignal,
    });
  };

  // The call is started HERE, not inside the generator: a lazy generator
  // would defer the request until the caller's first read, which is a
  // different (and unannounced) contract than every other wrapper here.
  async function* stream(
    result: ReturnType<typeof start>,
    route: ResolvedRoute,
    retried: boolean,
  ): AsyncGenerator<string> {
    let emitted = false;
    try {
      for await (const chunk of result.textStream) {
        if (chunk.length > 0) emitted = true;
        yield chunk;
      }
    } catch (err) {
      const retry = retried ? null : fableRetryRoute(route, err);
      if (!retry) throw err;
      yield* stream(start(retry), retry, true);
      return;
    }
    // A refusal ends the turn on an HTTP 200, before any answer text — so
    // retrying costs the caller nothing it already consumed. `emitted` is
    // the guard for the pathological case: a caller that already has bytes
    // keeps them rather than receiving two concatenated bodies.
    if (!retried && !emitted && route.model === FABLE_MODEL && (await isRefusedStream(result))) {
      const retry = fableFallbackRoute(route);
      yield* stream(start(retry), retry, true);
    }
  }

  const route = requireRoute(slot);
  return stream(start(route), route, false);
}

export async function chatObject<T>(
  slot: LLMSlot,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts?: { abortSignal?: AbortSignal; maxOutputTokens?: number },
): Promise<T> {
  if (mockLlm) {
    if (process.env.ACE_MOCK_LLM_MODE) {
      // Explicit override: honored first, exactly as before.
      return schema.parse(JSON.parse(getMockResponse()));
    }
    // No mode var: dispatch on the schema itself, so a single keyless
    // process can serve differently-shaped structured-output calls (e.g.
    // brainstorm turns and question generation) without per-call config.
    for (const candidate of MOCK_OBJECT_CANDIDATES) {
      const result = schema.safeParse(candidate());
      if (result.success) return result.data;
    }
    // No candidate matched this schema — fall through to today's
    // parse-failure behavior.
    return schema.parse('OK');
  }

  const route = requireRoute(slot);
  const call = (r: ResolvedRoute) =>
    generateObject({
      model: getModelFor(r),
      ...toCallInput(messages, opts?.maxOutputTokens),
      schema,
      abortSignal: opts?.abortSignal,
      // Opt out of OpenAI strict mode: several caller schemas still carry
      // optional properties, which strict mode rejects. Do NOT rely on this
      // flag for correctness — the codex backend enforces strict mode
      // regardless (NEE-263), so schemas used on the openai path must be
      // strict-compatible by construction: every property required, with
      // optionality expressed as `.nullable()` (see GeneratedQuestionSchema).
      providerOptions: { openai: { strictJsonSchema: false } },
    });

  let result;
  try {
    result = await call(route);
  } catch (err) {
    const retry = fableRetryRoute(route, err);
    // The Fable branch is checked first so its ZDR latch and no-latch refusal
    // behaviour stay byte-identical. A response that fails to parse only on
    // that retry is knowingly not salvaged — a rare double failure, not worth
    // the extra nesting here.
    if (!retry) {
      const salvaged = salvageObject(schema, err);
      if (salvaged !== undefined) return salvaged;
      throw err;
    }
    return (await call(retry)).object;
  }
  // A refusal arrives on an HTTP 200 with no usable object — retry it on
  // Opus 5 exactly once, without latching (it is per-request, not per-org).
  if (route.model === FABLE_MODEL && isRefusalFinish(result.finishReason, result.providerMetadata)) {
    return (await call(fableFallbackRoute(route))).object;
  }
  return result.object;
}

/**
 * Streaming variant of chatObject: same validated-final-object contract, but
 * surfaces each partial object as the JSON materialises so callers (e.g. the
 * Activity Log) can render a response arriving live. Ships beside chatObject —
 * review-extract and the CLI commands stay on the non-streaming call.
 */
export async function chatObjectStream<T>(
  slot: LLMSlot,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts?: {
    abortSignal?: AbortSignal;
    maxOutputTokens?: number;
    /** Each partial as the JSON materialises. NOT schema-validated —
     *  every field may be truncated mid-string. Throws are swallowed:
     *  a logging bug must never kill a paid call. */
    onPartial?: (partial: Record<string, unknown>) => void;
    /** Fired on every raw chunk of the underlying HTTP response body —
     *  including frames that never materialise a partial: a buffering proxy
     *  can send only pings for a whole turn (NEE-322), so this is the only
     *  liveness signal that never goes silent on a healthy call. Same
     *  swallow contract as onPartial. */
    onStreamActivity?: () => void;
    /** The route this call is actually running on, fired again for a Fable
     *  fallback retry — see chatStream's onRoute for why a caller that
     *  persists the model must record this instead of re-resolving. */
    onRoute?: (route: ResolvedRoute) => void;
  },
): Promise<T> {
  const firePartial = (partial: unknown): void => {
    try {
      opts?.onPartial?.(partial as Record<string, unknown>);
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };
  const fireActivity = (): void => {
    try {
      opts?.onStreamActivity?.();
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };
  const fireRoute = (route: ResolvedRoute): void => {
    try {
      opts?.onRoute?.(route);
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };

  if (mockLlm) {
    if (process.env.ACE_MOCK_LLM_MODE) {
      // Explicit override: honored first, exactly like chatObject.
      const parsed = schema.parse(JSON.parse(getMockResponse()));
      fireActivity();
      firePartial(parsed);
      return parsed;
    }
    // No mode var: same schema dispatch as chatObject, firing onPartial at
    // least once so keyless e2e still renders a stream.
    for (const candidate of MOCK_OBJECT_CANDIDATES) {
      const result = schema.safeParse(candidate());
      if (result.success) {
        fireActivity();
        firePartial(result.data);
        return result.data;
      }
    }
    // No candidate matched this schema — fall through to today's
    // parse-failure behavior.
    return schema.parse('OK');
  }

  const runOnce = async (route: ResolvedRoute): Promise<{ value: T; refused: boolean }> => {
    // Every request this call issues starts here, retries included — the one
    // place onRoute can report the route actually used.
    fireRoute(route);
    const result = streamText({
      // The tapped fetch is scoped to THIS call's model; without the callback
      // getModelFor receives no fetch at all and construction is unchanged.
      model: getModelFor(
        route,
        opts?.onStreamActivity ? withResponseActivityTap(fireActivity) : undefined,
      ),
      ...toCallInput(messages, opts?.maxOutputTokens),
      output: Output.object({ schema }),
      abortSignal: opts?.abortSignal,
      // Same strict-mode opt-out as chatObject — see the comment there.
      providerOptions: { openai: { strictJsonSchema: false } },
    });

    // The partial stream must be FULLY drained or `result.output` below never
    // settles. Never read result.textStream here — that is the raw JSON
    // including referenceSolution; only the partial-object stream may be
    // surfaced, filtered downstream.
    for await (const partial of result.partialOutputStream) {
      firePartial(partial);
    }

    // The schema-validated final object. Parse/validation failure rejects with
    // NoObjectGeneratedError carrying .text — the same contract chatObject's
    // callers already match on.
    const value = await result.output;
    return { value, refused: route.model === FABLE_MODEL && (await isRefusedStream(result)) };
  };

  const route = requireRoute(slot);
  let attempt;
  try {
    attempt = await runOnce(route);
  } catch (err) {
    // A Fable retry replays the whole streaming call, so onPartial fires
    // again from the start — callers overwrite per partial, never append.
    const retry = fableRetryRoute(route, err);
    // Same ordering rationale (and the same knowing gap on the retry's own
    // response) as chatObject above.
    if (!retry) {
      const salvaged = salvageObject(schema, err);
      if (salvaged === undefined) throw err;
      // Push the recovered object through as a final partial: ai-log.ts's
      // PartialDiffer emits a wholesale `set` once a value stops being a
      // prefix of its successor, so the Activity Log ends showing what the
      // caller actually received rather than the mis-encoded blob.
      firePartial(salvaged);
      return salvaged;
    }
    return (await runOnce(retry)).value;
  }
  if (attempt.refused) return (await runOnce(fableFallbackRoute(route))).value;
  return attempt.value;
}

/**
 * HTTP/2 responses carry no reason phrase, so the vendor APIs report a bare
 * "401" while an HTTP/1.1 proxy reports "401 Unauthorized". Naming the host
 * that answered is what makes a wrong-host validation self-evident.
 */
function probeFailure(response: Response, base: string): string {
  const reason = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
  return `${reason} from ${base}`;
}

/**
 * A 2xx status alone is not proof a provider answered: ace's own SPA
 * catch-all (cli/server/routes/static.ts) serves index.html with a 200 for
 * ANY extension-less GET, so a misconfigured base URL that loops back into
 * ace itself (or a proxy that renders an error page) would otherwise
 * green-check the key and every subsequent paid call would die with a bare
 * 404 (NEE-360). The real /v1/models endpoint always answers with a JSON
 * object carrying a `data` array — demand that shape and name what was
 * actually found when it's missing.
 */
async function describeUnexpectedBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return 'the response body could not be read';
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'an empty body';
  if (/^<(!doctype|html)/i.test(trimmed)) return 'an HTML page, not a provider API response';
  try {
    JSON.parse(trimmed);
    return 'JSON that is not a models-list response (no "data" array)';
  } catch {
    return 'a non-JSON body';
  }
}

async function validateModelsListResponse(
  response: Response,
  base: string,
): Promise<{ valid: boolean; error?: string }> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    const description = await describeUnexpectedBody(response);
    return {
      valid: false,
      error:
        `${base} returned a 2xx status but ${description} — check that this is the ` +
        'right provider (or proxy) address and that something is actually listening on it.',
    };
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).data)
  ) {
    return {
      valid: false,
      error:
        `${base} returned a 2xx status but the body is not a models-list response ` +
        '(no "data" array) — check that this is the right provider (or proxy) address.',
    };
  }
  return { valid: true };
}

export async function validateOpenAIKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  // Env-sourced base URLs bypass normalizeBaseUrl, so strip trailing
  // slashes here too — the SDK clients do the same internally.
  const base = (baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return { valid: false, error: probeFailure(response, base) };
    }
    return await validateModelsListResponse(response, base);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: `${message} (${base})` };
  }
}

export async function validateAnthropicKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  const base = anthropicProbeBase(baseUrl);
  try {
    const response = await fetch(`${base}/models`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (response.status === 401) {
      return { valid: false, error: `Invalid API key (401) from ${base}` };
    }
    if (!response.ok) {
      return { valid: false, error: probeFailure(response, base) };
    }
    return await validateModelsListResponse(response, base);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: `${message} (${base})` };
  }
}

/**
 * @ai-sdk/anthropic appends /v1 to a bare host at call time, so a base URL of
 * http://localhost:4242 hits /v1/messages during generation. Match that here —
 * otherwise a config that works at runtime is rejected at save time.
 */
function anthropicProbeBase(baseUrl?: string): string {
  const base = (baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  try {
    if (new URL(base).pathname === '/') return `${base}/v1`;
  } catch {
    // Unparseable; let fetch surface the failure rather than guessing.
  }
  return base;
}
