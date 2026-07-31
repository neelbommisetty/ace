import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyResult } from './gen-verify.js';
import {
  buildAuditUserMessage,
  buildCalibrationReworkUserMessage,
  buildCalibrationUserMessage,
  buildRegenerateUserMessage,
  buildRepairUserMessage,
  findDisallowedImports,
  generateVerifiedQuestion,
  GenerationVerifyError,
  verifyFailureDetail,
  type CalibrationResult,
  type EdgeAuditResult,
  type GeneratedQuestion,
  type GenerationPhase,
  type GenerationStepsSink,
} from './gen-pipeline.js';
import { maskPromptText, WITHHELD_MARKER } from './spoilers.js';

const STAGE1: GeneratedQuestion = {
  title: 'Autosave Queue',
  slug: 'autosave-queue',
  description: 'Build a debounced autosave queue for a config-driven form editor.',
  signature: 'export function createAutosaver(save: (draft: string) => Promise<void>): Autosaver',
  testCode:
    "import { describe, expect, it } from 'vitest';\nimport { createAutosaver } from './solution';\n\ndescribe('autosaver', () => {\n  it('saves', () => { expect(1).toBe(1); });\n});\n",
  supportCode: null,
  solutionCode: null,
  referenceSolution: 'export function createAutosaver() {\n  return {} as never;\n}\n',
  interviewerPacket: '## Capability Tested\n\nConcurrency realities.',
  estimatedMinutes: null,
  competency: null,
  followUps: null,
};

const AUDIT_NOOP: EdgeAuditResult = {
  edgeCases: [{ name: 'boundary timing', covered: true, action: 'none' }],
  description: null,
  testCode: null,
  supportCode: null,
  referenceSolution: null,
  interviewerPacket: null,
};

const GREEN: VerifyResult = {
  green: true,
  summary: { total: 3, passed: 3, failed: 0, skipped: 0, durationMs: 10 },
  failureReport: null,
};

const RED: VerifyResult = {
  green: false,
  summary: { total: 3, passed: 2, failed: 1, skipped: 0, durationMs: 10 },
  failureReport: '✕ autosaver › saves\nexpected 2 to be 1',
};

interface CapturedCall {
  purpose: string | undefined;
  system: string;
  user: string;
}

/** The stage 2.5 default when a test doesn't care about calibration: an immediate 'fits', no rework. */
const DEFAULT_CALIBRATION: CalibrationResult = { verdict: 'fits', estimatedMinutes: null, issues: null };

/**
 * chatObjectStream fake dispatching on opts.purpose: 'generate' calls pop
 * from `generates` (initial call first, then repairs AND calibrate reworks
 * — both reuse the 'generate' purpose); 'edge-audit' pops from `audits`;
 * 'calibrate' pops from `calibrations`, defaulting to an immediate 'fits' so
 * tests that don't care about calibration never need to thread it through.
 * Captures every call for message assertions. The pipeline is
 * streaming-only now (NEE-264), so the fake exposes only chatObjectStream.
 */
function makeLlm(
  generates: GeneratedQuestion[],
  audits: EdgeAuditResult[],
  calibrations: CalibrationResult[] = [],
) {
  const calls: CapturedCall[] = [];
  const genQueue = [...generates];
  const auditQueue = [...audits];
  const calibQueue = [...calibrations];
  const chatObjectStream = vi.fn(async (_provider, messages, _schema, opts) => {
    calls.push({
      purpose: opts?.purpose,
      system: messages[0]?.content ?? '',
      user: messages[1]?.content ?? '',
    });
    if (opts?.purpose === 'edge-audit') return auditQueue.shift();
    if (opts?.purpose === 'calibrate') return calibQueue.shift() ?? DEFAULT_CALIBRATION;
    return genQueue.shift();
  });
  return { llm: { chatObjectStream: chatObjectStream as never }, calls };
}

function makeVerify(results: VerifyResult[]) {
  const queue = [...results];
  return vi.fn(async () => queue.shift() ?? RED);
}

const PARAMS = {
  provider: 'openai' as const,
  category: 'js-ts' as const,
  difficulty: 'medium' as const,
  userMessage: 'Generate a medium question about autosave queues.',
  workspaceRoot: '/nonexistent-not-touched-by-fakes',
};

describe('generateVerifiedQuestion', () => {
  it('merges non-null audit artifacts over the stage-1 result and verifies once', async () => {
    const audit: EdgeAuditResult = {
      ...AUDIT_NOOP,
      testCode: 'AUDITED TESTS',
      interviewerPacket: 'AUDITED PACKET',
    };
    const { llm } = makeLlm([STAGE1], [audit]);
    const verify = makeVerify([GREEN]);
    const staged: GeneratedQuestion[] = [];

    const result = await generateVerifiedQuestion(PARAMS, {
      llm,
      verify,
      onStageResult: (q) => staged.push(q),
    });

    expect(result.question.testCode).toBe('AUDITED TESTS');
    expect(result.question.interviewerPacket).toBe('AUDITED PACKET');
    expect(result.question.description).toBe(STAGE1.description);
    expect(result.question.title).toBe(STAGE1.title);
    expect(result.edgeCases).toEqual(audit.edgeCases);
    expect(verify).toHaveBeenCalledTimes(1);
    // The verifier receives the audited testCode and a real rendered stub.
    const [, , artifacts] = verify.mock.calls[0] as unknown as [string, string, { testCode: string; stubSolution: string }];
    expect(artifacts.testCode).toBe('AUDITED TESTS');
    expect(artifacts.stubSolution).toContain('createAutosaver');
    expect(artifacts.stubSolution).toContain('// TODO: implement');
    // Per-stage persistence: stage 1 + post-audit merge.
    expect(staged).toHaveLength(2);
  });

  it('repairs on red and re-verifies, pinning title/slug across the repair', async () => {
    const repaired: GeneratedQuestion = {
      ...STAGE1,
      title: 'Drifted Title',
      slug: 'drifted-slug',
      testCode: 'FIXED TESTS',
    };
    const { llm, calls } = makeLlm([STAGE1, repaired], [AUDIT_NOOP]);
    const verify = makeVerify([RED, GREEN]);
    const phases: Array<[GenerationPhase, number]> = [];

    const result = await generateVerifiedQuestion(PARAMS, {
      llm,
      verify,
      onProgress: (phase, attempt) => phases.push([phase, attempt]),
    });

    expect(result.question.testCode).toBe('FIXED TESTS');
    expect(result.question.title).toBe(STAGE1.title);
    expect(result.question.slug).toBe(STAGE1.slug);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(phases).toEqual([
      ['generating', 1],
      ['auditing', 1],
      ['calibrating', 1],
      ['verifying', 1],
      ['repairing', 2],
      ['verifying', 2],
    ]);
    // calls[2] is the (default-fits) calibrate call; the repair call comes after it.
    const repairCall = calls[3];
    expect(repairCall.purpose).toBe('generate');
    expect(repairCall.user).toContain('Verification Failure Report');
    expect(repairCall.user).toContain('expected 2 to be 1');
  });

  it('throws GenerationVerifyError with the last result after exhausting attempts', async () => {
    const { llm } = makeLlm([STAGE1, STAGE1, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([RED, RED, RED]);

    const err = await generateVerifiedQuestion(PARAMS, { llm, verify }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GenerationVerifyError);
    expect((err as GenerationVerifyError).failureReport).toBe(RED.failureReport);
    expect((err as GenerationVerifyError).lastResult.title).toBe(STAGE1.title);
    expect(verify).toHaveBeenCalledTimes(3);
    // Known residual, deliberately not widened (NEE-265): the message embeds
    // the failure report's FIRST LINE only — a test name on the
    // buildFailureReport path, possibly a compiler frame on the stderr-tail
    // paths — and reaches the browser via generation-error/job.errorMessage.
    // Pinned so any change to what it embeds is a decision, not drift; the
    // AI-activity-log recorder must never source ai_steps text from it.
    expect((err as GenerationVerifyError).message).toBe(
      'generated tests could not be verified after 3 attempts — ✕ autosaver › saves',
    );
  });

  it('rejects disallowed test imports before spending a vitest run', async () => {
    const badStage1: GeneratedQuestion = {
      ...STAGE1,
      testCode: "import userEvent from '@testing-library/user-event';\nimport { createAutosaver } from './solution';\n",
    };
    const { llm, calls } = makeLlm([badStage1, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([GREEN]);

    const result = await generateVerifiedQuestion(PARAMS, { llm, verify });

    expect(result.question.testCode).toBe(STAGE1.testCode);
    // Attempt 1 never reached the sandbox; only the repaired suite did.
    expect(verify).toHaveBeenCalledTimes(1);
    // calls[2] is the (default-fits) calibrate call; the repair call comes after it.
    const repairCall = calls[3];
    expect(repairCall.user).toContain('@testing-library/user-event');
    expect(repairCall.user).toContain('allowlist');
  });

  it('treats missing coding fields as a repairable failure, not a crash', async () => {
    const incomplete: GeneratedQuestion = { ...STAGE1, testCode: null, referenceSolution: null };
    const { llm, calls } = makeLlm([incomplete, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([GREEN]);

    const result = await generateVerifiedQuestion(PARAMS, { llm, verify });

    expect(result.question.testCode).toBe(STAGE1.testCode);
    expect(verify).toHaveBeenCalledTimes(1);
    // calls[2] is the (default-fits) calibrate call; the repair call comes after it.
    expect(calls[3].user).toContain('missing required field');
  });

  it('reports missing fields AND disallowed imports in one repair round', async () => {
    const doubleTrouble: GeneratedQuestion = {
      ...STAGE1,
      referenceSolution: null,
      testCode: "import userEvent from '@testing-library/user-event';\n",
    };
    const { llm, calls } = makeLlm([doubleTrouble, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([GREEN]);

    await generateVerifiedQuestion(PARAMS, { llm, verify });

    // calls[2] is the (default-fits) calibrate call; the repair call comes after it.
    const repairMessage = calls[3].user;
    expect(repairMessage).toContain('missing required field');
    expect(repairMessage).toContain('@testing-library/user-event');
  });

  it('runs the critique pass and skips verification for design categories', async () => {
    const designStage1: GeneratedQuestion = {
      title: 'Notification Read-State Sync',
      slug: 'notification-read-state',
      description: 'Initial design brief.',
      signature: null,
      testCode: null,
      supportCode: null,
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: '## Capability Tested\n\nAmbiguity → invariants.',
      estimatedMinutes: null,
      competency: null,
      followUps: null,
    };
    const critique: EdgeAuditResult = {
      edgeCases: [{ name: 'requirements ambiguity', covered: false, action: 'update-question' }],
      description: 'Sharpened design brief with concrete numbers.',
      testCode: null,
      supportCode: null,
      referenceSolution: null,
      interviewerPacket: null,
    };
    const { llm, calls } = makeLlm([designStage1], [critique]);
    const verify = makeVerify([]);

    const result = await generateVerifiedQuestion(
      { ...PARAMS, category: 'design-fe' },
      { llm, verify },
    );

    expect(result.question.description).toBe('Sharpened design brief with concrete numbers.');
    expect(result.edgeCases).toEqual(critique.edgeCases);
    expect(verify).not.toHaveBeenCalled();
    // generate + edge-audit + calibrate (design categories run calibrate too).
    expect(calls).toHaveLength(3);
    // Design audits get the critique framing, not code artifacts.
    expect(calls[1].user).not.toContain('## Test File');
    // Calibrate (design path) states the static time budget, not code sections.
    expect(calls[2].purpose).toBe('calibrate');
    expect(calls[2].user).toContain('40 minutes');
    expect(calls[2].user).not.toContain('## Test File');
  });
});

describe('calibration stage (2.5: time & complexity)', () => {
  it('reworks a too-big verdict once, then accepts fits, carrying the calibrator estimate', async () => {
    const reworked: GeneratedQuestion = {
      ...STAGE1,
      title: 'Drifted Title',
      slug: 'drifted-slug',
      testCode: 'SHRUNK TESTS',
    };
    const { llm, calls } = makeLlm(
      [STAGE1, reworked],
      [AUDIT_NOOP],
      [
        { verdict: 'too-big', estimatedMinutes: 75, issues: 'drop the retry-with-backoff branch' },
        { verdict: 'fits', estimatedMinutes: 42, issues: null },
      ],
    );
    const verify = makeVerify([GREEN]);

    const result = await generateVerifiedQuestion(PARAMS, { llm, verify });

    // Identity pinned across the rework, same as the stage-3 repair loop.
    expect(result.question.title).toBe(STAGE1.title);
    expect(result.question.slug).toBe(STAGE1.slug);
    expect(result.question.testCode).toBe('SHRUNK TESTS');
    // The calibrator's own re-derived estimate wins, not the model's first guess.
    expect(result.question.estimatedMinutes).toBe(42);

    expect(calls[0].purpose).toBe('generate');
    expect(calls[1].purpose).toBe('edge-audit');
    expect(calls[2].purpose).toBe('calibrate');
    // The rework call reuses the generate purpose and carries the calibrator's issues.
    expect(calls[3].purpose).toBe('generate');
    expect(calls[3].user).toContain('drop the retry-with-backoff branch');
    expect(calls[3].user).toContain(PARAMS.userMessage);
    expect(calls[4].purpose).toBe('calibrate');
    expect(calls).toHaveLength(5);
  });

  it('proceeds after exhausting the rework budget on a non-fits verdict — never throws', async () => {
    const { llm } = makeLlm(
      [STAGE1, STAGE1],
      [AUDIT_NOOP],
      [
        { verdict: 'too-big', estimatedMinutes: 90, issues: 'still too large' },
        { verdict: 'too-big', estimatedMinutes: 80, issues: 'still too large' },
      ],
    );
    const verify = makeVerify([GREEN]);
    const { sink, recorded } = makeStepsSink();

    const result = await generateVerifiedQuestion(PARAMS, { llm, verify, steps: sink });

    // The last calibration round's estimate is carried through despite the non-fits verdict.
    expect(result.question.estimatedMinutes).toBe(80);
    const calibrateSteps = recorded.filter((r) => r.slug === 'calibrate');
    expect(calibrateSteps).toHaveLength(2);
    expect(calibrateSteps[1].status).toBe('done');
    expect(calibrateSteps[1].outcome).toContain('too-big');
    expect(calibrateSteps[1].outcome).toContain('budget exhausted');
  });
});

// ---------------------------------------------------------------------------
// Activity-log step recording (NEE-268) — via the structural steps sink.
// ---------------------------------------------------------------------------

interface RecordedStep {
  slug: string;
  label: string;
  kind: string;
  attempt?: number;
  prompt?: string;
  withholdPrompt?: boolean;
  status?: 'done' | 'error' | 'skipped';
  outcome?: string;
  partials: number;
}

function makeStepsSink() {
  const recorded: RecordedStep[] = [];
  const secrets: string[] = [];
  const sink: GenerationStepsSink = {
    step(spec) {
      const rec: RecordedStep = { ...spec, partials: 0 };
      recorded.push(rec);
      return {
        append() {},
        partial() {
          rec.partials += 1;
        },
        done(detail?: string) {
          rec.status = 'done';
          rec.outcome = detail;
        },
        fail(message: string) {
          rec.status = 'error';
          rec.outcome = message;
        },
        skip(reason?: string) {
          rec.status = 'skipped';
          rec.outcome = reason;
        },
      };
    },
    registerSecret(text: string) {
      secrets.push(text);
    },
  };
  return { sink, recorded, secrets };
}

describe('step recording (NEE-268)', () => {
  it('records the full taxonomy for a red-then-green run, with masked prompts and registered secrets', async () => {
    const { llm } = makeLlm([STAGE1, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([RED, GREEN]);
    const { sink, recorded, secrets } = makeStepsSink();

    await generateVerifiedQuestion(PARAMS, { llm, verify, steps: sink });

    expect(recorded.map((r) => [r.slug, r.status, r.outcome])).toEqual([
      ['generate', 'done', undefined],
      ['edge-audit', 'done', '1 edge case · 0 changes applied'],
      ['calibrate', 'done', 'fits'],
      ['static-check', 'done', 'ok'],
      // Red verify: closed vocabulary — the failing test NAMES, never report text.
      ['verify', 'error', 'autosaver › saves'],
      ['repair', 'done', undefined],
      ['static-check', 'done', 'ok'],
      ['verify', 'done', '3/3 passed vs reference · stub fails as required'],
    ]);

    // The generate prompt is the caller's topic brief, shown as-is.
    const generate = recorded[0];
    expect(generate.prompt).toBe(PARAMS.userMessage);

    // The audit prompt is the constructed masked twin — spoilers withheld.
    const audit = recorded[1];
    expect(audit.label).toBe('Auditing edge cases');
    expect(audit.prompt).toContain(WITHHELD_MARKER);
    expect(audit.prompt).not.toContain('return {} as never');

    // The calibrate prompt is likewise the constructed masked twin.
    const calibrate = recorded[2];
    expect(calibrate.label).toBe('Checking time & complexity');
    expect(calibrate.prompt).toContain(WITHHELD_MARKER);
    expect(calibrate.prompt).not.toContain('return {} as never');

    // Attempt labels carry the human-facing N/3.
    expect(recorded[4].label).toBe('Running tests (attempt 1/3)');
    expect(recorded[5].label).toBe('Fixing tests (attempt 2/3)');
    expect(recorded[5].attempt).toBe(2);
    expect(recorded[7].label).toBe('Running tests (attempt 2/3)');

    // The repair prompt is masked: no reference body, no assertion diffs.
    const repair = recorded[5];
    expect(repair.prompt).toContain(WITHHELD_MARKER);
    expect(repair.prompt).not.toContain('return {} as never');
    expect(repair.prompt).not.toContain('expected 2 to be 1');

    // Spoiler values AND the failure report registered as scrub literals.
    expect(secrets).toContain(STAGE1.referenceSolution);
    expect(secrets).toContain(STAGE1.interviewerPacket);
    expect(secrets).toContain(RED.failureReport);
  });

  it('marks the last red step with the fixed exhausted phrase (never report text) when verification is exhausted', async () => {
    const { llm } = makeLlm([STAGE1, STAGE1, STAGE1], [AUDIT_NOOP]);
    const verify = makeVerify([RED, RED, RED]);
    const { sink, recorded } = makeStepsSink();

    await expect(
      generateVerifiedQuestion(PARAMS, { llm, verify, steps: sink }),
    ).rejects.toBeInstanceOf(GenerationVerifyError);

    const verifies = recorded.filter((r) => r.slug === 'verify');
    expect(verifies.map((r) => [r.status, r.outcome])).toEqual([
      ['error', 'autosaver › saves'],
      ['error', 'autosaver › saves'],
      ['error', 'verification exhausted after 3 attempts'],
    ]);
  });

  it('records static-check failures with the closed detail vocabulary', async () => {
    const doubleTrouble: GeneratedQuestion = {
      ...STAGE1,
      referenceSolution: null,
      testCode: "import userEvent from '@testing-library/user-event';\n",
    };
    const { sink, recorded } = makeStepsSink();
    const { llm } = makeLlm([doubleTrouble, STAGE1], [AUDIT_NOOP]);

    await generateVerifiedQuestion(PARAMS, { llm, verify: makeVerify([GREEN]), steps: sink });

    const check = recorded.find((r) => r.slug === 'static-check')!;
    expect(check.status).toBe('error');
    expect(check.outcome).toBe(
      'missing: referenceSolution · imports outside allowlist: @testing-library/user-event',
    );
  });

  it('records a skipped sandbox step for design categories', async () => {
    const designStage1: GeneratedQuestion = {
      ...STAGE1,
      signature: null,
      testCode: null,
      referenceSolution: null,
    };
    const { sink, recorded } = makeStepsSink();
    const { llm } = makeLlm([designStage1], [AUDIT_NOOP]);

    await generateVerifiedQuestion(
      { ...PARAMS, category: 'design-fe' },
      { llm, verify: makeVerify([]), steps: sink },
    );

    expect(recorded.map((r) => [r.slug, r.status, r.outcome])).toEqual([
      ['generate', 'done', undefined],
      ['edge-audit', 'done', '1 edge case · 0 changes applied'],
      // Design categories run calibrate too — never skipped.
      ['calibrate', 'done', 'fits'],
      ['verify', 'skipped', 'not applicable to design questions'],
    ]);
    expect(recorded[1].label).toBe('Critiquing requirements');
  });

  it('records a skipped sandbox step for behavioral categories — no phantom verify stage, no repair loop off a null testCode (NEE-343)', async () => {
    const behavioralStage1: GeneratedQuestion = {
      ...STAGE1,
      signature: null,
      testCode: null,
      referenceSolution: null,
      competency: 'conflict',
      followUps: ['What would the other engineer say happened?'],
    };
    const { sink, recorded } = makeStepsSink();
    const { llm } = makeLlm([behavioralStage1], [AUDIT_NOOP]);

    const result = await generateVerifiedQuestion(
      { ...PARAMS, category: 'behavioral' },
      { llm, verify: makeVerify([]), steps: sink },
    );

    expect(recorded.map((r) => [r.slug, r.status, r.outcome])).toEqual([
      ['generate', 'done', undefined],
      ['edge-audit', 'done', '1 edge case · 0 changes applied'],
      // Behavioral is the one type that skips calibrate entirely.
      ['calibrate', 'skipped', 'not applicable to behavioral questions'],
      ['verify', 'skipped', 'not applicable to behavioral questions'],
    ]);
    expect(recorded[1].label).toBe('Critiquing the prompt');
    // No repair step ever recorded — a missing testCode never drives the
    // coding-only static-check/verify/repair loop for a no-test category.
    expect(recorded.some((r) => r.slug === 'repair')).toBe(false);
    expect(recorded.some((r) => r.slug === 'static-check')).toBe(false);
    expect(result.question.competency).toBe('conflict');
  });

  it('fails the llm step (and rethrows) when the call dies mid-stream', async () => {
    const { sink, recorded } = makeStepsSink();
    const chatObjectStream = vi.fn(async () => {
      throw new Error('provider 500 during generate');
    });

    await expect(
      generateVerifiedQuestion(PARAMS, {
        llm: { chatObjectStream: chatObjectStream as never },
        verify: makeVerify([]),
        steps: sink,
      }),
    ).rejects.toThrow('provider 500 during generate');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      slug: 'generate',
      status: 'error',
      outcome: 'provider 500 during generate',
    });
  });

  it('regenerate context (NEE-386): sends the revision prompt to the model, records the masked twin on the generate slug, and registers the prior spoilers', async () => {
    // Prior spoiler values DISTINCT from the fresh output's: the pipeline
    // unconditionally registers the FRESH question's spoilers right after
    // stage 1, so only strings absent from the fresh output can prove the
    // regenerate-specific prior-question registration exists at all.
    const priorQuestion: GeneratedQuestion = {
      ...STAGE1,
      title: 'Autosave Queue (prior)',
      slug: 'autosave-queue-prior',
      referenceSolution: 'PRIOR-ONLY reference solution body — absent from the fresh output\n',
      interviewerPacket: 'PRIOR-ONLY interviewer packet — absent from the fresh output',
    };
    const freshQuestion: GeneratedQuestion = {
      ...STAGE1,
      title: 'Autosave Queue v2',
      slug: 'autosave-queue-v2',
    };
    const { sink, recorded, secrets } = makeStepsSink();
    const { llm: baseLlm, calls } = makeLlm([freshQuestion], [AUDIT_NOOP]);
    // Snapshot the registered secrets AT generate-call time: registration
    // must happen BEFORE the model call — the scrubber exists for a provider
    // error that echoes the prompt, so it must already know the prior key
    // when the call fires.
    let secretsAtGenerateCall: string[] | null = null;
    const inner = baseLlm.chatObjectStream as unknown as (...args: unknown[]) => Promise<unknown>;
    const llm = {
      chatObjectStream: (async (...args: unknown[]) => {
        const opts = args[3] as { purpose?: string } | undefined;
        if (opts?.purpose === 'generate' && secretsAtGenerateCall === null) {
          secretsAtGenerateCall = [...secrets];
        }
        return inner(...args);
      }) as never,
    };

    const result = await generateVerifiedQuestion(
      {
        ...PARAMS,
        regenerate: { priorQuestion, feedback: 'Too easy — add an O(n) constraint.' },
      },
      { llm, verify: makeVerify([GREEN]), steps: sink },
    );

    // The model-bound call carries the revision framing plus the prior spoilers and the feedback.
    const generateCall = calls[0];
    expect(generateCall.purpose).toBe('generate');
    expect(generateCall.user).toContain('## Current Output');
    expect(generateCall.user).toContain('PRIOR-ONLY reference solution body');
    expect(generateCall.user).toContain('PRIOR-ONLY interviewer packet');
    expect(generateCall.user).toContain('## User Feedback');
    expect(generateCall.user).toContain('Too easy — add an O(n) constraint.');

    // The recorded step is the constructed masked twin, on the SAME 'generate' slug — no answer-key leak.
    const generateStep = recorded[0];
    expect(generateStep.slug).toBe('generate');
    expect(generateStep.prompt).toContain(WITHHELD_MARKER);
    expect(generateStep.prompt).not.toContain('PRIOR-ONLY');

    // The PRIOR question's exact spoiler strings are registered as scrub
    // secrets — and were already registered when the model call fired.
    expect(secrets).toContain(priorQuestion.referenceSolution);
    expect(secrets).toContain(priorQuestion.interviewerPacket);
    expect(secretsAtGenerateCall).toContain(priorQuestion.referenceSolution);
    expect(secretsAtGenerateCall).toContain(priorQuestion.interviewerPacket);

    // No identity pin at stage 1 — the fresh title/slug from the model wins.
    expect(result.question.title).toBe(freshQuestion.title);
    expect(result.question.slug).toBe(freshQuestion.slug);
  });

  it('regression pin (NEE-386): a non-regenerate run still records the plain topic brief verbatim', async () => {
    const { llm, calls } = makeLlm([STAGE1], [AUDIT_NOOP]);
    const { sink, recorded } = makeStepsSink();

    await generateVerifiedQuestion(PARAMS, { llm, verify: makeVerify([GREEN]), steps: sink });

    expect(calls[0].user).toBe(PARAMS.userMessage);
    expect(recorded[0].prompt).toBe(PARAMS.userMessage);
  });
});

describe('verifyFailureDetail (closed vocabulary)', () => {
  it('surfaces only the ✕ test names, joined and capped', () => {
    expect(verifyFailureDetail('✕ a\nexpected 1 to be 2\n\n✕ suite › b\nmore diff')).toBe(
      'a · suite › b',
    );
    const long = `✕ ${'n'.repeat(300)}\nboom`;
    const detail = verifyFailureDetail(long);
    expect(detail.length).toBe(201);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('maps the known synthetic reports to fixed phrases', () => {
    expect(verifyFailureDetail('verification run timed out after 120s — look for …')).toBe(
      'verification run timed out',
    );
    expect(verifyFailureDetail('stub verification run timed out after 120s — …')).toBe(
      'stub verification run timed out',
    );
    expect(
      verifyFailureDetail('every test passes against the unimplemented starter stub — …'),
    ).toBe('the suite is vacuous');
    expect(
      verifyFailureDetail('vitest produced no parseable JSON report (likely a syntax error)'),
    ).toBe('vitest produced no parseable report');
    expect(
      verifyFailureDetail('the stub verification run produced no parseable JSON report'),
    ).toBe('vitest produced no parseable report');
    expect(verifyFailureDetail('no tests ran — the suite failed to load or compile:\nframes')).toBe(
      'no tests ran — the suite failed to load or compile',
    );
    expect(verifyFailureDetail('the test file contains no tests — write real assertions')).toBe(
      'the test file contains no tests',
    );
    expect(verifyFailureDetail('no tests ran against the starter stub — the stub …')).toBe(
      'no tests ran against the starter stub',
    );
    expect(verifyFailureDetail('verification failed with no report')).toBe(
      'verification failed with no report',
    );
  });

  it('fails CLOSED on anything unrecognized — raw stderr never leaks', () => {
    expect(
      verifyFailureDetail(
        'SyntaxError: unexpected token in solution.ts\n  const SECRET_REFERENCE_BODY = 42;',
      ),
    ).toBe('verification failed');
  });
});

describe('audit user message assembly (NEE-275)', () => {
  // Exact-string (snapshot-class) assertions: the doubled `## Problem
  // Statement` wrapper and the redundant sibling `## Signature` were exactly
  // the kind of drift only a full-message assertion catches.

  const CODING_STAGE1: GeneratedQuestion = {
    ...STAGE1,
    description: [
      '## Problem Statement',
      '',
      'Build a debounced autosave queue for a config-driven form editor.',
      '',
      '## Signature',
      '',
      '```ts',
      'export function createAutosaver(save: (draft: string) => Promise<void>): Autosaver',
      '```',
      '',
      '## Examples',
      '',
      '1. Two rapid edits produce a single save.',
      '',
      '## Constraints',
      '',
      '- Coalesce edits within 500ms.',
      '',
      '## Hints',
      '',
      '- Think about an in-flight save finishing after a newer edit.',
    ].join('\n'),
    testCode: "it('saves', () => {});",
    referenceSolution: 'export function createAutosaver() {}',
  };

  it('embeds a coding question once, under ## Question, with no sibling ## Signature', async () => {
    const { llm, calls } = makeLlm([CODING_STAGE1], [AUDIT_NOOP]);
    await generateVerifiedQuestion(PARAMS, { llm, verify: makeVerify([GREEN]) });

    const auditCall = calls[1];
    expect(auditCall.purpose).toBe('edge-audit');
    expect(auditCall.user).toBe(`Audit this freshly generated medium js-ts interview question.

## Question

## Problem Statement

Build a debounced autosave queue for a config-driven form editor.

## Signature

\`\`\`ts
export function createAutosaver(save: (draft: string) => Promise<void>): Autosaver
\`\`\`

## Examples

1. Two rapid edits produce a single save.

## Constraints

- Coalesce edits within 500ms.

## Hints

- Think about an in-flight save finishing after a newer edit.

## Reference Solution

\`\`\`
export function createAutosaver() {}
\`\`\`

## Test File

\`\`\`
it('saves', () => {});
\`\`\`

## Interviewer Packet

## Capability Tested

Concurrency realities.`);
    // The acceptance criteria, stated directly: each heading exactly once.
    expect(auditCall.user.match(/^## Problem Statement$/gm)).toHaveLength(1);
    expect(auditCall.user.match(/^## Signature$/gm)).toHaveLength(1);
  });

  it('embeds a design question once, under ## Question, with no code sections', async () => {
    const designStage1: GeneratedQuestion = {
      title: 'Notification Read-State Sync',
      slug: 'notification-read-state',
      description: [
        '## Problem Statement',
        '',
        'Design read-state sync for a notifications inbox at 5M DAU.',
        '',
        '## Requirements',
        '',
        '- Read state converges across 3 devices within 5s.',
        '',
        '## Scope',
        '',
        '- Focus On: sync protocol. Out of Scope: notification delivery.',
        '',
        '## Evaluation Criteria',
        '',
        '- Names the offline-merge invariant.',
      ].join('\n'),
      signature: null,
      testCode: null,
      supportCode: null,
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: '## Capability Tested\n\nAmbiguity resolved into invariants.',
      estimatedMinutes: null,
      competency: null,
      followUps: null,
    };
    const { llm, calls } = makeLlm([designStage1], [AUDIT_NOOP]);
    await generateVerifiedQuestion({ ...PARAMS, category: 'design-fe' }, { llm, verify: makeVerify([]) });

    const auditCall = calls[1];
    expect(auditCall.purpose).toBe('edge-audit');
    expect(auditCall.user).toBe(`Audit this freshly generated medium design-fe interview question.

## Question

## Problem Statement

Design read-state sync for a notifications inbox at 5M DAU.

## Requirements

- Read state converges across 3 devices within 5s.

## Scope

- Focus On: sync protocol. Out of Scope: notification delivery.

## Evaluation Criteria

- Names the offline-merge invariant.

## Interviewer Packet

## Capability Tested

Ambiguity resolved into invariants.`);
    expect(auditCall.user.match(/^## Problem Statement$/gm)).toHaveLength(1);
    expect(auditCall.user).not.toContain('## Signature');
  });
});

describe('masked prompt construction (NEE-265)', () => {
  it('buildAuditUserMessage returns the full prompt plus a constructed spoiler-free twin', () => {
    const built = buildAuditUserMessage(PARAMS, STAGE1, false);
    // The model-bound prompt still carries the spoilers…
    expect(built.prompt).toContain('return {} as never');
    expect(built.prompt).toContain('Concurrency realities');
    // …while the masked twin withholds them but keeps the wire-safe parts.
    expect(built.maskedPrompt).not.toContain('return {} as never');
    expect(built.maskedPrompt).not.toContain('Concurrency realities');
    expect(built.maskedPrompt).toContain(`## Reference Solution\n\n${WITHHELD_MARKER}`);
    expect(built.maskedPrompt).toContain(`## Interviewer Packet\n\n${WITHHELD_MARKER}`);
    expect(built.maskedPrompt).toContain(STAGE1.description!);
    expect(built.maskedPrompt).toContain(STAGE1.testCode!);
  });

  it('buildAuditUserMessage (design) masks only the interviewer packet — no code sections exist', () => {
    const built = buildAuditUserMessage(
      { ...PARAMS, category: 'design-fe' },
      { ...STAGE1, signature: null, testCode: null, referenceSolution: null },
      true,
    );
    expect(built.maskedPrompt).not.toContain('## Reference Solution');
    expect(built.maskedPrompt).not.toContain('Concurrency realities');
    expect(built.maskedPrompt).toContain(`## Interviewer Packet\n\n${WITHHELD_MARKER}`);
  });

  it('buildRepairUserMessage masks the json fence values and the failure report', () => {
    const built = buildRepairUserMessage(STAGE1, RED.failureReport!);
    expect(built.prompt).toContain('return {} as never');
    expect(built.prompt).toContain('expected 2 to be 1');
    expect(built.maskedPrompt).not.toContain('return {} as never');
    expect(built.maskedPrompt).not.toContain('Concurrency realities');
    expect(built.maskedPrompt).not.toContain('expected 2 to be 1');
    // The fence survives as parseable JSON with spoiler values withheld and
    // wire-safe values intact.
    expect(built.maskedPrompt).toContain(`"referenceSolution": "${WITHHELD_MARKER}"`);
    expect(built.maskedPrompt).toContain(`"title": ${JSON.stringify(STAGE1.title)}`);
    expect(built.maskedPrompt).toContain(`## Verification Failure Report\n\n${WITHHELD_MARKER}`);
    expect(built.maskedPrompt).toContain('The problem statement is the source of truth');
  });

  it('maskPromptText (the second line of defence) also withholds the fenced spoilers', () => {
    // Structural agreement between construction and parsing: a caller who
    // forgets the constructed maskedPrompt and runs the parser instead still
    // never wires the fenced spoiler bodies.
    const audit = maskPromptText(buildAuditUserMessage(PARAMS, STAGE1, false).prompt);
    expect(audit).not.toContain('return {} as never');
    const repair = maskPromptText(buildRepairUserMessage(STAGE1, RED.failureReport!).prompt);
    expect(repair).not.toContain('return {} as never');
    expect(repair).not.toContain('Concurrency realities');
    expect(repair).not.toContain('expected 2 to be 1');
  });

  it('buildCalibrationUserMessage (coding) masks the reference solution but keeps tests and support code visible', () => {
    const withSupport: GeneratedQuestion = { ...STAGE1, supportCode: 'export const fixtures = {};' };
    const built = buildCalibrationUserMessage(PARAMS, withSupport, false);
    expect(built.prompt).toContain('return {} as never');
    expect(built.prompt).toContain('export const fixtures = {};');
    expect(built.maskedPrompt).not.toContain('return {} as never');
    expect(built.maskedPrompt).toContain(`## Reference Solution\n\n${WITHHELD_MARKER}`);
    expect(built.maskedPrompt).toContain('export const fixtures = {};');
    expect(built.maskedPrompt).toContain(STAGE1.testCode!);
    expect(built.maskedPrompt).toContain(`## Interviewer Packet\n\n${WITHHELD_MARKER}`);
  });

  it('buildCalibrationUserMessage (design) states the static time budget instead of code sections', () => {
    const built = buildCalibrationUserMessage(
      { ...PARAMS, category: 'design-fe', difficulty: 'medium' },
      { ...STAGE1, signature: null, testCode: null, referenceSolution: null },
      true,
    );
    expect(built.prompt).not.toContain('## Reference Solution');
    expect(built.prompt).not.toContain('## Test File');
    expect(built.prompt).toContain('40 minutes');
    expect(built.maskedPrompt).toContain('40 minutes');
  });

  it('buildCalibrationReworkUserMessage masks the current-output json fence and the calibration issues', () => {
    const calibration: CalibrationResult = {
      verdict: 'too-big',
      estimatedMinutes: 75,
      issues: 'drop the retry-with-backoff branch — it duplicates the base case',
    };
    const built = buildCalibrationReworkUserMessage(PARAMS, STAGE1, calibration);
    expect(built.prompt).toContain('return {} as never');
    expect(built.prompt).toContain('drop the retry-with-backoff branch');
    expect(built.maskedPrompt).not.toContain('return {} as never');
    expect(built.maskedPrompt).not.toContain('drop the retry-with-backoff branch');
    expect(built.maskedPrompt).toContain('too-big');
    expect(built.maskedPrompt).toContain(`"referenceSolution": "${WITHHELD_MARKER}"`);
  });

  it('buildRegenerateUserMessage embeds the topic brief, prior output, and feedback — masks spoilers, allows retitle/re-slug', () => {
    const priorQuestion: GeneratedQuestion = {
      ...STAGE1,
      followUps: ['What would you do differently under sustained load?'],
    };
    const built = buildRegenerateUserMessage(
      PARAMS,
      priorQuestion,
      'Too easy — needs an O(n) constraint.',
    );

    // The model-bound prompt carries the topic brief, the prior spoilers, and the feedback verbatim.
    expect(built.prompt).toContain(PARAMS.userMessage);
    expect(built.prompt).toContain('return {} as never');
    expect(built.prompt).toContain('Concurrency realities');
    expect(built.prompt).toContain('## User Feedback\n\nToo easy — needs an O(n) constraint.');

    // The masked twin withholds the answer-key fields but keeps wire-safe content and feedback visible.
    expect(built.maskedPrompt).toContain(PARAMS.userMessage);
    expect(built.maskedPrompt).not.toContain('return {} as never');
    expect(built.maskedPrompt).not.toContain('Concurrency realities');
    expect(built.maskedPrompt).not.toContain('What would you do differently under sustained load?');
    expect(built.maskedPrompt).toContain(`"referenceSolution": "${WITHHELD_MARKER}"`);
    expect(built.maskedPrompt).toContain(`"interviewerPacket": "${WITHHELD_MARKER}"`);
    expect(built.maskedPrompt).toContain(`"followUps": "${WITHHELD_MARKER}"`);
    expect(built.maskedPrompt).toContain(`"title": ${JSON.stringify(priorQuestion.title)}`);
    expect(built.maskedPrompt).toContain(priorQuestion.description!);
    // testCode is multi-line; JSON.stringify escapes its newlines, so a
    // single-line slice (rather than the raw multi-line field) is what
    // survives verbatim inside the fence.
    expect(built.maskedPrompt).toContain("it('saves', () => { expect(1).toBe(1); });");
    expect(built.maskedPrompt).toContain('Too easy — needs an O(n) constraint.');

    // Unlike rework/repair, no title/slug pin — a regenerated question may legitimately retitle.
    expect(built.prompt).not.toContain('Keep "title"');
    expect(built.maskedPrompt).not.toContain('Keep "title"');
  });
});

describe('generateVerifiedQuestion no-output-progress timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface StreamOpts {
    purpose?: string;
    abortSignal?: AbortSignal;
    maxOutputTokens?: number;
    onPartial?: (partial: Record<string, unknown>) => void;
    onStreamActivity?: () => void;
  }

  /** Rejects with the pipeline's abort reason the moment its signal fires. */
  function rejectOnAbort(opts: StreamOpts | undefined): Promise<never> {
    return new Promise((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason));
    });
  }

  it('aborts a stream that stays silent for the whole stall window', async () => {
    vi.useFakeTimers();
    const chatObjectStream = vi.fn((_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) =>
      rejectOnAbort(opts),
    );
    let settled = false;
    const outcome = generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: chatObjectStream as never },
      verify: makeVerify([]),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = (await outcome) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('generation looks stalled');
  });

  it('keeps a slow-but-flowing stream alive past the old 300s wall clock — partials re-arm the stall clock', async () => {
    vi.useFakeTimers();
    const partialReturns: unknown[] = [];
    const chatObjectStream = vi.fn((_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) => {
      // Audit and calibrate both resolve instantly so the fake-timer
      // choreography only drives the stage-1 generate call.
      if (opts?.purpose === 'edge-audit') return Promise.resolve(AUDIT_NOOP);
      if (opts?.purpose === 'calibrate') return Promise.resolve(DEFAULT_CALIBRATION);
      return new Promise((resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason));
        let fired = 0;
        const tick = setInterval(() => {
          fired += 1;
          partialReturns.push(opts?.onPartial?.({ title: 'partial' }));
          if (fired === 3) {
            clearInterval(tick);
            resolve(STAGE1);
          }
        }, 250_000);
      });
    });

    const outcome = generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: chatObjectStream as never },
      verify: makeVerify([GREEN]),
    });
    // Partials at 250s/500s/750s: every gap fits inside the 300s stall
    // window, but the call as a whole outlives the old 300s wall clock.
    await vi.advanceTimersByTimeAsync(750_000);

    const result = await outcome;
    expect(result.question.title).toBe(STAGE1.title);
    // The stall-reset callback must be synchronous (NEE-267): an async
    // callback's rejection would bypass chatObjectStream's throw-swallowing
    // guard — a returned Promise here would be the regression.
    expect(partialReturns.every((r) => r === undefined)).toBe(true);
  });

  it('keeps a zero-partial stream alive on raw activity alone — a buffering proxy delivers no partials (NEE-322)', async () => {
    vi.useFakeTimers();
    const activityReturns: unknown[] = [];
    const recordedPartials: Array<Record<string, unknown>> = [];
    // Recorder seam: raw-activity events must never reach step.partial —
    // only parsed partials carry an object to record.
    const steps: GenerationStepsSink = {
      step: () => ({
        append() {},
        partial(obj) {
          recordedPartials.push(obj);
        },
        done() {},
        fail() {},
        skip() {},
      }),
      registerSecret() {},
    };
    const chatObjectStream = vi.fn((_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) => {
      if (opts?.purpose === 'edge-audit') return Promise.resolve(AUDIT_NOOP);
      if (opts?.purpose === 'calibrate') return Promise.resolve(DEFAULT_CALIBRATION);
      return new Promise((resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason));
        let fired = 0;
        const tick = setInterval(() => {
          fired += 1;
          activityReturns.push(opts?.onStreamActivity?.());
          if (fired === 3) {
            clearInterval(tick);
            resolve(STAGE1);
          }
        }, 250_000);
      });
    });

    const outcome = generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: chatObjectStream as never },
      verify: makeVerify([GREEN]),
      steps,
    });
    // Raw chunks at 250s/500s/750s with ZERO partials — the whole object is
    // buffered until the end of the turn, yet every gap fits the stall
    // window, so the call must outlive the old 300s wall clock.
    await vi.advanceTimersByTimeAsync(750_000);

    const result = await outcome;
    expect(result.question.title).toBe(STAGE1.title);
    // Same synchronous-callback contract as onPartial (NEE-267).
    expect(activityReturns.every((r) => r === undefined)).toBe(true);
    expect(recordedPartials).toEqual([]);
  });

  it('aborts at the absolute ceiling even while partials and raw activity keep flowing', async () => {
    vi.useFakeTimers();
    const chatObjectStream = vi.fn(
      (_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason));
          // Never resolves — both liveness signals keep the stall clock
          // re-armed forever.
          setInterval(() => {
            opts?.onStreamActivity?.();
            opts?.onPartial?.({ title: 'still going' });
          }, 200_000);
        }),
    );

    const outcome = generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: chatObjectStream as never },
      verify: makeVerify([]),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(900_000);

    const err = (await outcome) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('ceiling');
  });
});

describe('findDisallowedImports', () => {
  it('flags packages outside the allowlist and dedupes', () => {
    const code = [
      "import userEvent from '@testing-library/user-event';",
      "import { render } from '@testing-library/react';",
      "import { JSDOM } from 'jsdom';",
      "const j = require('jsdom');",
      "import('lodash');",
    ].join('\n');
    expect(findDisallowedImports(code)).toEqual([
      '@testing-library/user-event',
      'jsdom',
      'lodash',
    ]);
  });

  it('allows subpaths of allowed packages and sandbox-relative imports', () => {
    const code = [
      "import { createRoot } from 'react-dom/client';",
      "import '@testing-library/jest-dom/vitest';",
      "import { add } from './solution';",
    ].join('\n');
    expect(findDisallowedImports(code)).toEqual([]);
  });

  it('rejects parent-relative imports that escape the sandbox', () => {
    expect(findDisallowedImports("import { x } from '../secrets';")).toEqual(['../secrets']);
  });

  it('catches multi-line (Prettier-style) imports of disallowed packages', () => {
    const code = "import {\n  render,\n  screen,\n  fireEvent,\n} from '@testing-library/user-event';\n";
    expect(findDisallowedImports(code)).toEqual(['@testing-library/user-event']);
    const escape = "import {\n  helper,\n} from '../shared/helper';\n";
    expect(findDisallowedImports(escape)).toEqual(['../shared/helper']);
  });

  it('ignores import-like text inside comments and template literals', () => {
    const code = [
      '/*',
      'Common mistake avoided here:',
      "import userEvent from '@testing-library/user-event';",
      '*/',
      "// import { JSDOM } from 'jsdom';",
      'const fixture = `',
      "import bad from 'lodash';",
      '`;',
      "import { render } from '@testing-library/react';",
    ].join('\n');
    expect(findDisallowedImports(code)).toEqual([]);
  });
});
