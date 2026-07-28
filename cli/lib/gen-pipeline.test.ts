import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyResult } from './gen-verify.js';
import {
  buildAuditUserMessage,
  buildRepairUserMessage,
  findDisallowedImports,
  generateVerifiedQuestion,
  GenerationVerifyError,
  type EdgeAuditResult,
  type GeneratedQuestion,
  type GenerationPhase,
} from './gen-pipeline.js';
import { maskPromptText, WITHHELD_MARKER } from './spoilers.js';

const STAGE1: GeneratedQuestion = {
  title: 'Autosave Queue',
  slug: 'autosave-queue',
  description: 'Build a debounced autosave queue for a config-driven form editor.',
  signature: 'export function createAutosaver(save: (draft: string) => Promise<void>): Autosaver',
  testCode:
    "import { describe, expect, it } from 'vitest';\nimport { createAutosaver } from './solution';\n\ndescribe('autosaver', () => {\n  it('saves', () => { expect(1).toBe(1); });\n});\n",
  solutionCode: null,
  referenceSolution: 'export function createAutosaver() {\n  return {} as never;\n}\n',
  interviewerPacket: '## Capability Tested\n\nConcurrency realities.',
};

const AUDIT_NOOP: EdgeAuditResult = {
  edgeCases: [{ name: 'boundary timing', covered: true, action: 'none' }],
  description: null,
  testCode: null,
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

/**
 * chatObjectStream fake dispatching on opts.purpose: 'generate' calls pop
 * from `generates` (initial call first, then repairs); 'edge-audit' pops
 * from `audits`. Captures every call for message assertions. The pipeline is
 * streaming-only now (NEE-264), so the fake exposes only chatObjectStream.
 */
function makeLlm(generates: GeneratedQuestion[], audits: EdgeAuditResult[]) {
  const calls: CapturedCall[] = [];
  const genQueue = [...generates];
  const auditQueue = [...audits];
  const chatObjectStream = vi.fn(async (_provider, messages, _schema, opts) => {
    calls.push({
      purpose: opts?.purpose,
      system: messages[0]?.content ?? '',
      user: messages[1]?.content ?? '',
    });
    if (opts?.purpose === 'edge-audit') return auditQueue.shift();
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
      ['verifying', 1],
      ['repairing', 2],
      ['verifying', 2],
    ]);
    // The repair call reuses the generate purpose and carries the report.
    const repairCall = calls[2];
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
    const repairCall = calls[2];
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
    expect(calls[2].user).toContain('missing required field');
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

    const repairMessage = calls[2].user;
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
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: '## Capability Tested\n\nAmbiguity → invariants.',
    };
    const critique: EdgeAuditResult = {
      edgeCases: [{ name: 'requirements ambiguity', covered: false, action: 'update-question' }],
      description: 'Sharpened design brief with concrete numbers.',
      testCode: null,
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
    expect(calls).toHaveLength(2);
    // Design audits get the critique framing, not code artifacts.
    expect(calls[1].user).not.toContain('## Test File');
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
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: '## Capability Tested\n\nAmbiguity resolved into invariants.',
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
    expect(err.message).toContain('stalled');
  });

  it('keeps a slow-but-flowing stream alive past the old 300s wall clock — partials re-arm the stall clock', async () => {
    vi.useFakeTimers();
    const partialReturns: unknown[] = [];
    const chatObjectStream = vi.fn((_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) => {
      // Audit resolves instantly so the fake-timer choreography only drives
      // the stage-1 generate call.
      if (opts?.purpose === 'edge-audit') return Promise.resolve(AUDIT_NOOP);
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

  it('aborts at the absolute ceiling even while partials keep flowing', async () => {
    vi.useFakeTimers();
    const chatObjectStream = vi.fn(
      (_p: unknown, _m: unknown, _s: unknown, opts?: StreamOpts) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason));
          // Never resolves — partials keep the stall clock re-armed forever.
          setInterval(() => opts?.onPartial?.({ title: 'still going' }), 200_000);
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
