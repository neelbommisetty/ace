// @vitest-environment node
//
// Route-level tests for the AI activity read API (GET /api/ai/runs, GET
// /api/ai/runs/:id, GET /api/ai/steps/:id). Mirrors app-session.test.ts's
// pattern: a real Hono app + real Request/Response over a real (temp-dir) db
// with fake engines — the routes are read-only, so rows are seeded straight
// through the db.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { AiRunRow, AiStepRow, AiStepSummary } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-ai');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

/** Seeds one run with one step carrying the multi-KB text fields. */
function seedRunWithStep(opts: { refId?: string | null } = {}) {
  const run = ws.session.db.createAiRun({
    kind: 'generation',
    refId: opts.refId ?? 'job-1',
    label: 'Generate: closures',
  });
  const step = ws.session.db.createAiStep({
    runId: run.id,
    kind: 'llm',
    slug: 'generate',
    label: 'Generate question',
    promptText: 'SECRET_PROMPT_TEXT',
  });
  ws.session.db.appendAiStepResponse(step.id, 'SECRET_RESPONSE_TEXT');
  return { run, step };
}

type RunWithSteps = AiRunRow & { steps: AiStepSummary[] };

describe('GET /api/ai/runs', () => {
  it('lists runs newest-first with their steps riding along', async () => {
    const { run, step } = seedRunWithStep();
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(run.id);
    expect(body.runs[0].steps.length).toBe(1);
    expect(body.runs[0].steps[0].id).toBe(step.id);
    expect(body.runs[0].steps[0].seq).toBe(1);
  });

  it('never returns promptText/responseText (summary shape)', async () => {
    seedRunWithStep();
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs');
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('SECRET_PROMPT_TEXT');
    expect(raw).not.toContain('SECRET_RESPONSE_TEXT');
    expect(raw).not.toContain('promptText');
    expect(raw).not.toContain('responseText');
  });

  it('respects an explicit limit', async () => {
    seedRunWithStep();
    seedRunWithStep();
    seedRunWithStep();
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(ws.session.db, 'listAiRuns');
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?limit=9000');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('defaults the limit to 30', async () => {
    const spy = vi.spyOn(ws.session.db, 'listAiRuns');
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }));
  });

  it('400s on a non-positive limit', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?limit=0');
    expect(res.status).toBe(400);
  });

  it('400s on a non-numeric limit', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?limit=abc');
    expect(res.status).toBe(400);
  });

  it('filters by refId (the job-card drawer query)', async () => {
    seedRunWithStep({ refId: 'job-a' });
    const { run } = seedRunWithStep({ refId: 'job-b' });
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?refId=job-b');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(run.id);
  });

  it('filters by kind', async () => {
    seedRunWithStep(); // kind: 'generation'
    const review = ws.session.db.createAiRun({ kind: 'review', label: 'Review: debounce' });
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?kind=review');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(review.id);
  });

  // NEE-345 trap: AI_RUN_KINDS in routes/ai.ts is hand-maintained and only
  // catches a BAD member, never a missing one — forgetting to add 'probe'
  // there would 400 this query while probe rows kept writing fine.
  it('filters by kind=probe', async () => {
    seedRunWithStep(); // kind: 'generation'
    const probe = ws.session.db.createAiRun({ kind: 'probe', label: 'Probes: a-story' });
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?kind=probe');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(probe.id);
  });

  it('400s on an unknown kind', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs?kind=nonsense');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ai/runs/:id', () => {
  it('returns the run and its steps (summary shape)', async () => {
    const { run, step } = seedRunWithStep();
    const fetch = buildApp();
    const res = await fetch(`/api/ai/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: AiRunRow; steps: AiStepSummary[] };
    expect(body.run.id).toBe(run.id);
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].id).toBe(step.id);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET_PROMPT_TEXT');
    expect(raw).not.toContain('SECRET_RESPONSE_TEXT');
  });

  it('404s on an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/ai/runs/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ai run not found');
  });
});

describe('GET /api/ai/steps/:id', () => {
  it('returns the full step including promptText/responseText', async () => {
    const { step } = seedRunWithStep();
    const fetch = buildApp();
    const res = await fetch(`/api/ai/steps/${step.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { step: AiStepRow };
    expect(body.step.id).toBe(step.id);
    expect(body.step.promptText).toBe('SECRET_PROMPT_TEXT');
    expect(body.step.responseText).toBe('SECRET_RESPONSE_TEXT');
  });

  it('404s on an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/ai/steps/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ai step not found');
  });
});
