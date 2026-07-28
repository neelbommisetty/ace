import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyFn, VerifyResult } from '../lib/gen-verify.js';
import type { LLMProvider } from '../lib/llm.js';
import { createAiLog } from './ai-log.js';
import { openDb } from './db.js';
import { createGenerationEngine } from './generation.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb } from './types.js';

/**
 * THE canary test (NEE-268): drive the full generation pipeline with fakes
 * whose every spoiler-bearing artifact — referenceSolution, solutionCode,
 * interviewerPacket, edge-case names, the vitest failure report, streamed
 * partials — contains a canary literal, then assert the canary appears in
 * ZERO ai_steps rows, ZERO ai_runs rows, and ZERO payloads captured off the
 * Bus. One test guards every row of the leak table and every future step
 * type: if a new code path forgets the mask, the canary surfaces here.
 */
const CANARY = 'ACE_SPOILER_CANARY_7f3a';

const PAYLOAD = {
  title: 'Canary Question',
  slug: 'canary-question',
  description: 'Return the number of canaries. A perfectly safe description.',
  signature: 'export function countCanaries(coop: string[]): number',
  testCode:
    "import { countCanaries } from './solution';\n\nit('counts', () => {\n  expect(countCanaries(['c'])).toBe(1);\n});\n",
  solutionCode: `export function countCanaries(coop) { return coop.length; } // ${CANARY}`,
  referenceSolution: `export function countCanaries(coop: string[]): number {\n  // ${CANARY} — the hidden reference body\n  return coop.length;\n}\n`,
  interviewerPacket: `## Capability Tested\n\n${CANARY} hidden interviewer guidance.`,
};

const AUDIT = {
  edgeCases: [
    { name: `${CANARY} hidden hint case`, covered: false, action: 'add-test' },
    { name: 'empty coop', covered: true, action: 'none' },
  ],
  description: null,
  testCode: null,
  referenceSolution: `export function countCanaries(): number { return 0; } // audited ${CANARY}`,
  interviewerPacket: null,
};

// First line is a plain `✕ name` (that is what may surface, names only);
// every following line is answer-key material and must never leave the row.
const RED: VerifyResult = {
  green: false,
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 5 },
  failureReport: `✕ counts\nAssertionError: expected [${CANARY}] to deeply equal [1]\n    at ${CANARY}/canary-frame/solution.ts:2:3`,
};
const GREEN: VerifyResult = {
  green: true,
  summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 5 },
  failureReport: null,
};

/**
 * chatObjectStream fake: audit calls get AUDIT, generate/repair calls get
 * PAYLOAD — each streaming canary-laden partials first, exactly like the
 * real SDK re-emitting the whole object on every delta.
 */
function makeCanaryLlm() {
  const chatObjectStream = async (
    _provider: LLMProvider,
    _messages: unknown,
    schema: any,
    opts?: { purpose?: string; onPartial?: (p: Record<string, unknown>) => void },
  ) => {
    if (opts?.purpose === 'edge-audit') {
      opts.onPartial?.({ edgeCases: AUDIT.edgeCases });
      opts.onPartial?.(AUDIT);
      return schema.parse(AUDIT);
    }
    opts?.onPartial?.({ title: 'Canary', referenceSolution: `${CANARY} partial leak attempt` });
    opts?.onPartial?.(PAYLOAD);
    return schema.parse(PAYLOAD);
  };
  return { chatObjectStream } as unknown as Parameters<
    typeof createGenerationEngine
  >[0]['llm'];
}

let tempRoot = '';
let db: AceDb;
let bus: Bus;
let busPayloads: string[];

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ai-canary-test-'));
  db = openDb(tempRoot);
  bus = createBus();
  busPayloads = [];
  bus.subscribe((name, data) => busPayloads.push(JSON.stringify({ name, data })));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeEngine(verify: VerifyFn) {
  return createGenerationEngine({
    db,
    bus,
    workspaceRoot: tempRoot,
    llm: makeCanaryLlm(),
    resolveProvider: () => 'openai',
    verify,
    aiLog: createAiLog({ db, bus }),
  });
}

function waitFor(name: string): Promise<any> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((eventName, data) => {
      if (eventName === name) {
        unsub();
        resolve(data);
      }
    });
  });
}

/** Reads the REAL persisted bytes — a second connection straight at the db file. */
function readRawAiTables(): { runs: unknown[]; steps: unknown[] } {
  const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
  try {
    return {
      runs: raw.prepare('SELECT * FROM ai_runs ORDER BY id').all(),
      steps: raw.prepare('SELECT * FROM ai_steps ORDER BY run_id, seq').all(),
    };
  } finally {
    raw.close();
  }
}

function expectNoCanaryAnywhere(): { runs: any[]; steps: any[] } {
  const { runs, steps } = readRawAiTables();
  expect(JSON.stringify(runs)).not.toContain(CANARY);
  expect(JSON.stringify(steps)).not.toContain(CANARY);
  expect(busPayloads.join('\n')).not.toContain(CANARY);
  return { runs: runs as any[], steps: steps as any[] };
}

describe('ai-log spoiler canary', () => {
  it('a verify-exhausted run (3 reds, 2 repairs) leaks the canary nowhere — not in ai_steps, ai_runs, or any bus payload', async () => {
    const engine = makeEngine(async () => RED);
    const errored = waitFor('generation-error');
    const { jobId } = engine.start({
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'counting canaries',
    });
    await errored;

    const { runs, steps } = expectNoCanaryAnywhere();

    // The run really recorded (an empty table would pass the canary check
    // trivially): full taxonomy for generate → audit → 3 × (check, verify)
    // with 2 repairs in between.
    expect(runs).toHaveLength(1);
    expect(runs[0].ref_id).toBe(jobId);
    expect(runs[0].status).toBe('error');
    expect(runs[0].error_message).toBe('verification exhausted after 3 attempts');
    expect(steps.map((s) => [s.slug, s.status])).toEqual([
      ['generate', 'done'],
      ['edge-audit', 'done'],
      ['static-check', 'done'],
      ['verify', 'error'],
      ['repair', 'done'],
      ['static-check', 'done'],
      ['verify', 'error'],
      ['repair', 'done'],
      ['static-check', 'done'],
      ['verify', 'error'],
    ]);

    // Verify detail is the closed vocabulary: test NAMES only, never report
    // text; the terminal one carries the exhausted phrase.
    const verifies = steps.filter((s) => s.slug === 'verify');
    expect(verifies[0].error_message).toBe('counts');
    expect(verifies[2].error_message).toBe('verification exhausted after 3 attempts');
    // Verify responses are withheld wholesale.
    for (const v of verifies) expect(v.response_text).toBeNull();

    // Audit surfaces counts only — never the edge-case names.
    const audit = steps.find((s) => s.slug === 'edge-audit')!;
    expect(audit.detail).toBe('2 edge cases · 1 change applied');

    // The generate prompt is shown; repair prompts are the masked twins.
    const generate = steps.find((s) => s.slug === 'generate')!;
    expect(generate.prompt_text).toContain('counting canaries');
    const repair = steps.find((s) => s.slug === 'repair')!;
    expect(repair.prompt_text).toContain('█ withheld █');

    // Streamed partials landed (safe keys only) — the differ path really ran.
    expect(generate.response_text).toContain('Canary Question');
  });

  it('a green run (scaffold included) leaks the canary nowhere and records the full happy-path taxonomy', async () => {
    const engine = makeEngine(async () => GREEN);
    const done = waitFor('generation-done');
    engine.start({ category: 'js-ts', difficulty: 'easy', topic: 'counting canaries' });
    await done;

    const { runs, steps } = expectNoCanaryAnywhere();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('done');
    expect(steps.map((s) => [s.slug, s.status])).toEqual([
      ['generate', 'done'],
      ['edge-audit', 'done'],
      ['static-check', 'done'],
      ['verify', 'done'],
      ['scaffold', 'done'],
    ]);
    const verify = steps.find((s) => s.slug === 'verify')!;
    expect(verify.detail).toBe('2/2 passed vs reference · stub fails as required');
    const scaffold = steps.find((s) => s.slug === 'scaffold')!;
    expect(scaffold.detail).toBe('questions/js-ts/canary-question');
  });

  it('a missing API key leaves a zero-step errored run for Activity to render', async () => {
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm: makeCanaryLlm(),
      resolveProvider: () => null,
      verify: async () => GREEN,
      aiLog: createAiLog({ db, bus }),
    });
    const errored = waitFor('generation-error');
    engine.start({ category: 'js-ts', difficulty: 'easy', topic: 'no key' });
    await errored;

    const { runs, steps } = expectNoCanaryAnywhere();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('error');
    expect(runs[0].error_message).toContain('no LLM API key configured');
    expect(steps).toHaveLength(0);
  });

  it('retry with a persisted result records a second run with a single scaffold step', async () => {
    const engine = makeEngine(async () => GREEN);

    // First attempt: pipeline green, then the scaffold mkdir fails — the
    // result is persisted, so the retry is scaffold-only.
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, mkdir');
    });
    const errored = waitFor('generation-error');
    const { jobId } = engine.start({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'counting canaries',
    });
    await errored;
    mkdirSpy.mockRestore();

    const done = waitFor('generation-done');
    engine.retry(db.getGenerationJob(jobId)!);
    await done;

    const { runs, steps } = expectNoCanaryAnywhere();
    expect(runs).toHaveLength(2);
    // Both runs reference the SAME job — the run id is minted per run.
    expect(runs.map((r) => r.ref_id)).toEqual([jobId, jobId]);
    expect(runs.map((r) => r.status).sort()).toEqual(['done', 'error']);

    const firstRun = runs.find((r) => r.status === 'error')!;
    const firstSteps = steps.filter((s) => s.run_id === firstRun.id);
    expect(firstSteps.at(-1)!.slug).toBe('scaffold');
    expect(firstSteps.at(-1)!.status).toBe('error');

    // The retry isn't invisible: one run, one scaffold step, done.
    const retryRun = runs.find((r) => r.status === 'done')!;
    const retrySteps = steps.filter((s) => s.run_id === retryRun.id);
    expect(retrySteps.map((s) => [s.slug, s.status])).toEqual([['scaffold', 'done']]);
  });
});
