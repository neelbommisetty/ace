/**
 * The AI activity log recorder (NEE-268): the ONE place that writes
 * ai_runs/ai_steps rows and emits their SSE events.
 *
 * The invariant that makes the feature safe: nothing writes to ai_steps
 * except this file, and it applies the mask unconditionally — the db rows
 * only ever contain masked text. That property (rather than "we remembered
 * to redact in six places") is what guarantees no present or future
 * endpoint, backup, or `sqlite3 ace.db` session can leak an answer key.
 *
 * Recording is best-effort throughout: every db write is individually
 * try/caught (swallowing e.g. "database is closed" when a paid call resolves
 * after session teardown) — the log must never turn a paid LLM call into a
 * crash. Mirrors the onStageResult convention in generation.ts.
 */
import {
  CalibrationSchema,
  EdgeAuditSchema,
  GeneratedQuestionSchema,
} from '../lib/gen-pipeline.js';
import { maskPromptText, SecretScrubber, WIRE_SAFE_KEYS } from '../lib/spoilers.js';
import { nowIso } from './ids.js';
import type { Bus } from './sse.js';
import type { AceDb, AiRunKind, AiStepKind, AiStepRow } from './types.js';

/** Coalesce window for chunk emission/persistence (the CHUNK_FLUSH_MS pattern from reviews.ts). */
export const AI_CHUNK_FLUSH_MS = 120;
/**
 * Per-step SSE emission budget. The SDK re-emits the WHOLE object on every
 * delta, so an unbounded forward would be ~64KB × ~4000 deltas over SSE;
 * past the cap the stream stops and is marked truncated — the validated
 * final text still persists to the db (head/tail-capped there).
 */
export const AI_STEP_STREAM_CAP = 64 * 1024;

export interface AiChunkOp {
  key: string;
  op: 'append' | 'set';
  text: string;
}

/**
 * Turns a stream of whole-object partials into per-key text deltas.
 * JSON-streamed string fields grow monotonically, so a key's delta is
 * normally the new value's suffix. If a value ever stops being a prefix of
 * its successor (structural fixup, array reshape) fall back to a wholesale
 * `set` — correct, just less efficient. Non-string values are
 * JSON.stringify'd first.
 */
export class PartialDiffer {
  private readonly last = new Map<string, string>();

  diff(partial: Record<string, unknown>, safe: ReadonlySet<string>): AiChunkOp[] {
    const ops: AiChunkOp[] = [];
    for (const [key, value] of Object.entries(partial)) {
      // The safe filter runs BEFORE the differ, so spoiler keys can't be
      // persisted or emitted even by a downstream bug.
      if (!safe.has(key)) continue;
      if (value == null) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const prev = this.last.get(key);
      if (prev === text) continue;
      if (prev === undefined) {
        ops.push({ key, op: 'append', text });
      } else if (text.startsWith(prev)) {
        ops.push({ key, op: 'append', text: text.slice(prev.length) });
      } else {
        ops.push({ key, op: 'set', text });
      }
      this.last.set(key, text);
    }
    return ops;
  }
}

export interface AiStepHandle {
  /** Appends already-masked plain text to the step's response. */
  append(text: string): void;
  /** Records a streamed partial object: WIRE_SAFE_KEYS-filtered → diffed → appended. */
  partial(obj: Record<string, unknown>): void;
  done(detail?: string): void;
  /** maskPromptText() + registered-secret scrub — provider errors sometimes echo the prompt. */
  fail(message: string): void;
  skip(reason?: string): void;
}

export interface AiRunHandle {
  readonly runId: string;
  step(spec: {
    slug: string;
    label: string;
    kind: AiStepKind;
    attempt?: number;
    prompt?: string;
    withholdPrompt?: boolean;
  }): AiStepHandle;
  /** Literal-scrub backstop (spoilers.ts SecretScrubber): register each spoiler value as it materialises. */
  registerSecret(text: string): void;
  done(): void;
  fail(message: string): void;
}

export interface AiLog {
  startRun(spec: {
    kind: AiRunKind;
    refId: string | null;
    questionId: string | null;
    label: string;
  }): AiRunHandle;
}

const NULL_STEP: AiStepHandle = {
  append() {},
  partial() {},
  done() {},
  fail() {},
  skip() {},
};

const NULL_RUN: AiRunHandle = {
  runId: '',
  step: () => NULL_STEP,
  registerSecret() {},
  done() {},
  fail() {},
};

/** Zero-behaviour implementation — the default for every engine, and for tests. */
export const NULL_AI_LOG: AiLog = {
  startRun: () => NULL_RUN,
};

// Schema keys per llm step slug, for declaring withheldKeys on step start
// (schema keys minus WIRE_SAFE_KEYS[slug]) — the `█ withheld █` lines can
// then render while the stream is still filling. Non-llm slugs (and unknown
// ones) have no schema; their partials are still fail-closed-filtered.
const STEP_SCHEMA_KEYS: Record<string, readonly string[]> = {
  generate: Object.keys(GeneratedQuestionSchema.shape),
  repair: Object.keys(GeneratedQuestionSchema.shape),
  'edge-audit': Object.keys(EdgeAuditSchema.shape),
  calibrate: Object.keys(CalibrationSchema.shape),
  // Hardcoded rather than `Object.keys(ProbeResultSchema.shape)` — probes.ts
  // imports AiLog/NULL_AI_LOG from this file, so importing its schema back
  // here would be circular. The literal is the schema's one top-level key
  // and must be kept in sync with cli/server/probes.ts's ProbeResultSchema.
  probe: ['probes'],
};

const EMPTY_SET: ReadonlySet<string> = new Set();

export function createAiLog(opts: { db: AceDb; bus: Bus }): AiLog {
  const { db, bus } = opts;

  return {
    startRun(spec) {
      // Per-run literal-scrub backstop: catches the one case structural
      // masking can't — a provider error echoing prompt content verbatim.
      const scrubber = new SecretScrubber();

      let runId = '';
      try {
        const run = db.createAiRun({
          kind: spec.kind,
          refId: spec.refId,
          questionId: spec.questionId,
          label: spec.label,
        });
        runId = run.id;
        bus.emit('ai-run-started', { run });
      } catch {
        // best-effort — recording degrades to a no-op, the run itself proceeds
      }
      if (!runId) return NULL_RUN;

      let runEnded = false;
      /** Interrupters for steps still open — see finishRun. */
      const openSteps = new Set<() => void>();

      const finishRun = (status: 'done' | 'error', errorMessage: string | null): void => {
        if (runEnded) return;
        runEnded = true;
        // A step left 'running' under a terminal run would pulse forever in
        // Activity — close any straggler before the run flips.
        for (const interrupt of [...openSteps]) interrupt();
        let finishedAt = nowIso();
        try {
          finishedAt = db.finishAiRun(runId, { status, errorMessage }).finishedAt ?? finishedAt;
        } catch {
          // best-effort
        }
        bus.emit('ai-run-done', { runId, refId: spec.refId, status, errorMessage, finishedAt });
        // Retention runs after each terminal run — no timers (see AceDb).
        try {
          db.pruneAiRuns();
        } catch {
          // best-effort
        }
      };

      const makeStep = (stepSpec: Parameters<AiRunHandle['step']>[0]): AiStepHandle => {
        const safeKeys = WIRE_SAFE_KEYS[stepSpec.slug] ?? EMPTY_SET;
        const schemaKeys = STEP_SCHEMA_KEYS[stepSpec.slug];
        // The prompt is masked+scrubbed here UNCONDITIONALLY, even though
        // callers pass constructed masked prompts — the invariant lives in
        // this file, not in caller discipline.
        const promptText =
          stepSpec.withholdPrompt || stepSpec.prompt == null
            ? null
            : scrubber.scrub(maskPromptText(stepSpec.prompt));

        let stepRow: AiStepRow | null = null;
        try {
          stepRow = db.createAiStep({
            runId,
            kind: stepSpec.kind,
            slug: stepSpec.slug,
            label: stepSpec.label,
            attempt: stepSpec.attempt,
            promptText,
            promptWithheld: stepSpec.withholdPrompt ?? false,
            withheldKeys: schemaKeys ? schemaKeys.filter((k) => !safeKeys.has(k)) : null,
          });
        } catch {
          // best-effort
        }
        if (!stepRow) return NULL_STEP;
        const stepId = stepRow.id;
        {
          // Summary shape: never put the multi-KB prompt/response on the wire.
          const { promptText: _prompt, responseText: _response, ...step } = stepRow;
          bus.emit('ai-step-started', { runId, refId: spec.refId, step });
        }

        const differ = new PartialDiffer();
        /** Accumulated safe response fields; each db flush re-serialises the whole map. */
        const fields = new Map<string, string>();
        let rawText = '';
        let pendingOps: AiChunkOp[] = [];
        let flushTimer: NodeJS.Timeout | null = null;
        let dirty = false;
        let emittedChars = 0;
        let emitCapped = false;
        let ended = false;

        const enqueue = (ops: AiChunkOp[]): void => {
          if (emitCapped) return;
          for (const op of ops) {
            if (op.op === 'set') {
              // A set supersedes everything queued for its key.
              pendingOps = pendingOps.filter((p) => p.key !== op.key);
              pendingOps.push({ ...op });
              continue;
            }
            const last = pendingOps[pendingOps.length - 1];
            if (last && last.op === 'append' && last.key === op.key) last.text += op.text;
            else pendingOps.push({ ...op });
          }
        };

        const serializeResponse = (): string => {
          const parts: string[] = [];
          if (rawText) parts.push(rawText);
          if (fields.size > 0) parts.push(JSON.stringify(Object.fromEntries(fields), null, 2));
          return parts.join('\n');
        };

        const flush = (): void => {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          if (pendingOps.length > 0) {
            // Emission cap: trim the crossing op to the remaining budget,
            // mark the cut, and stop emitting for the rest of the step. The
            // db snapshot below is unaffected — the full text still persists.
            const ops: AiChunkOp[] = [];
            for (const op of pendingOps) {
              const budget = AI_STEP_STREAM_CAP - emittedChars;
              if (op.text.length <= budget) {
                emittedChars += op.text.length;
                ops.push({ ...op, text: scrubber.scrub(op.text) });
              } else {
                emitCapped = true;
                emittedChars = AI_STEP_STREAM_CAP;
                ops.push({
                  ...op,
                  text: `${scrubber.scrub(op.text.slice(0, budget))}… (stream truncated)`,
                });
                break;
              }
            }
            pendingOps = [];
            if (ops.length > 0) bus.emit('ai-step-chunk', { runId, refId: spec.refId, stepId, ops });
          }
          if (dirty) {
            dirty = false;
            try {
              db.appendAiStepResponse(stepId, scrubber.scrub(serializeResponse()));
            } catch {
              // best-effort
            }
          }
        };

        const finish = (
          status: 'done' | 'error' | 'skipped',
          detail: string | null,
          errorMessage: string | null,
        ): void => {
          if (ended) return;
          ended = true;
          openSteps.delete(interrupt);
          // Always flush on step end — the last window's ops must not be lost.
          flush();
          let finishedAt = nowIso();
          try {
            finishedAt =
              db.finishAiStep(stepId, { status, detail, errorMessage }).finishedAt ?? finishedAt;
          } catch {
            // best-effort
          }
          bus.emit('ai-step-done', {
            runId,
            refId: spec.refId,
            stepId,
            status,
            detail,
            errorMessage,
            finishedAt,
          });
        };

        const interrupt = (): void =>
          finish('error', null, 'step never completed — the run ended first');
        openSteps.add(interrupt);

        return {
          append(text) {
            if (ended || text.length === 0) return;
            rawText += text;
            dirty = true;
            enqueue([{ key: 'text', op: 'append', text }]);
            if (!flushTimer) flushTimer = setTimeout(flush, AI_CHUNK_FLUSH_MS);
          },
          partial(obj) {
            if (ended) return;
            const ops = differ.diff(obj, safeKeys);
            if (ops.length === 0) return;
            for (const op of ops) {
              fields.set(
                op.key,
                op.op === 'append' ? (fields.get(op.key) ?? '') + op.text : op.text,
              );
            }
            dirty = true;
            enqueue(ops);
            if (!flushTimer) flushTimer = setTimeout(flush, AI_CHUNK_FLUSH_MS);
          },
          done(detail) {
            finish('done', detail != null ? scrubber.scrub(detail) : null, null);
          },
          fail(message) {
            finish('error', null, scrubber.scrub(maskPromptText(message)));
          },
          skip(reason) {
            finish('skipped', reason != null ? scrubber.scrub(reason) : null, null);
          },
        };
      };

      return {
        runId,
        step(stepSpec) {
          if (runEnded) return NULL_STEP;
          return makeStep(stepSpec);
        },
        registerSecret(text) {
          scrubber.register(text);
        },
        done() {
          finishRun('done', null);
        },
        fail(message) {
          finishRun('error', scrubber.scrub(maskPromptText(message)));
        },
      };
    },
  };
}
