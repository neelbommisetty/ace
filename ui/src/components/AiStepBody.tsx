import { useEffect, useRef, useState } from 'react';
import type { AiStepRow, AiStepSummary } from '../types';
import type { StepFetchState } from './AiStepRow';

/**
 * Client-side mirror of ai-log.ts's serializeResponse(): plain streamed text
 * first, then the safe structured fields as pretty JSON.
 */
function serializeLive(live: Map<string, string>): string {
  const parts: string[] = [];
  const text = live.get('text');
  if (text) parts.push(text);
  const fields = [...live].filter(([key]) => key !== 'text');
  if (fields.length > 0) parts.push(JSON.stringify(Object.fromEntries(fields), null, 2));
  return parts.join('\n');
}

/**
 * The response text to show. The lazily fetched row is authoritative only
 * once it's a terminal snapshot — one fetched mid-stream is ≤1s stale and
 * never catches up (the fetch happens once), so live SSE text wins over it.
 */
function resolveResponse(
  full: AiStepRow | null,
  state: StepFetchState,
  live: Map<string, string> | null,
): string | null {
  if (full != null && full.status !== 'running' && full.responseText != null) {
    return full.responseText;
  }
  if (live != null && live.size > 0) return serializeLive(live);
  if (full != null) return full.responseText;
  if (state === 'missing') return 'This step is gone from the log (pruned).';
  if (state === 'error') return 'Failed to load this step.';
  return null;
}

function Withheld({ text }: { text: string }) {
  // Deliberately inert: no click handler, no reveal affordance — the withheld
  // content is hidden so the question stays solvable.
  return (
    <span className="withheld" title="hidden so the question stays solvable">
      {text}
    </span>
  );
}

/** Prompt/Response tabs over the step's text (the pane-tabs markup from TestConsole). */
export function AiStepBody({
  step,
  full,
  state,
  live,
}: {
  step: AiStepSummary;
  full: AiStepRow | null;
  state: StepFetchState;
  live: Map<string, string> | null;
}) {
  const [tab, setTab] = useState<'prompt' | 'response'>('response');
  const preRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  const running = step.status === 'running';
  const response = resolveResponse(full, state, live);

  // Follow the stream unless the user scrolled up — the AiPanel idiom (a
  // ref, not state), NOT TestConsole's unconditional scroll.
  useEffect(() => {
    const el = preRef.current;
    if (!el || !running || tab !== 'response') return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [response, running, tab]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="ai-step-body">
      <div className="pane-tabs">
        <button
          className={`pane-tab ${tab === 'prompt' ? 'active' : ''}`}
          onClick={() => setTab('prompt')}
        >
          Prompt
        </button>
        <button
          className={`pane-tab ${tab === 'response' ? 'active' : ''}`}
          onClick={() => setTab('response')}
        >
          Response
        </button>
      </div>
      {tab === 'prompt' ? (
        <pre className="ai-step-pre">
          {step.promptWithheld ? (
            <Withheld text="█ withheld █" />
          ) : state === 'loaded' ? (
            (full?.promptText ?? '(no prompt recorded)')
          ) : state === 'missing' ? (
            'This step is gone from the log (pruned).'
          ) : state === 'error' ? (
            'Failed to load this step.'
          ) : (
            'Loading…'
          )}
        </pre>
      ) : (
        <pre className="ai-step-pre" ref={preRef} onScroll={onScroll}>
          {response ?? (running ? 'waiting for output…' : state === 'loaded' ? '(no response recorded)' : 'Loading…')}
          {step.withheldKeys != null &&
            step.withheldKeys.map((key) => (
              <span key={key}>
                {'\n'}
                <Withheld text={`"${key}": █ withheld █`} />
              </span>
            ))}
        </pre>
      )}
    </div>
  );
}
