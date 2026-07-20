import { describe, expect, it } from 'vitest';
import { parseVitestJson, stripAnsi } from './runner.js';

const fixture = JSON.stringify({
  numTotalTests: 5,
  numPassedTests: 2,
  numFailedTests: 1,
  numPendingTests: 2,
  testResults: [
    {
      name: '/ws/questions/js-ts/debounce/solution.test.ts',
      status: 'failed',
      assertionResults: [
        {
          title: 'delays invocation',
          ancestorTitles: ['debounce'],
          status: 'passed',
          duration: 12.5,
          failureMessages: [],
        },
        {
          title: 'flushes trailing call',
          ancestorTitles: ['debounce', 'trailing edge'],
          status: 'failed',
          duration: 8,
          failureMessages: [
            '\u001b[31mAssertionError\u001b[39m: expected \u001b[32m1\u001b[39m to be \u001b[31m2\u001b[39m',
            'second message',
          ],
        },
        {
          title: 'supports leading edge',
          ancestorTitles: ['debounce'],
          status: 'pending',
          failureMessages: [],
        },
        {
          title: 'cancels pending calls',
          ancestorTitles: [],
          status: 'todo',
          failureMessages: [],
        },
        {
          title: 'passes args through',
          ancestorTitles: [],
          status: 'passed',
          duration: 3,
          failureMessages: [],
        },
      ],
    },
  ],
});

describe('parseVitestJson', () => {
  it('maps summary counts from the report', () => {
    const parsed = parseVitestJson(fixture);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toMatchObject({
      total: 5,
      passed: 2,
      failed: 1,
      skipped: 2,
    });
  });

  it('maps per-case name, suite, status, and duration', () => {
    const results = parseVitestJson(fixture)!.results;
    expect(results).toHaveLength(5);

    expect(results[0]).toEqual({
      name: 'delays invocation',
      suite: 'debounce',
      status: 'passed',
      durationMs: 12.5,
      error: null,
    });
    expect(results[1].suite).toBe('debounce › trailing edge');
    expect(results[1].status).toBe('failed');
    expect(results[4]).toMatchObject({ suite: '', status: 'passed', durationMs: 3 });
  });

  it('maps pending and todo statuses to skipped', () => {
    const results = parseVitestJson(fixture)!.results;
    expect(results[2].status).toBe('skipped');
    expect(results[3].status).toBe('skipped');
    expect(results[2].durationMs).toBeNull();
  });

  it('strips ANSI from the first failure message', () => {
    const failing = parseVitestJson(fixture)!.results[1];
    expect(failing.error).toBe('AssertionError: expected 1 to be 2');
  });

  it('returns null for unparseable input', () => {
    expect(parseVitestJson('not json {')).toBeNull();
    expect(parseVitestJson('null')).toBeNull();
    expect(parseVitestJson('"a string"')).toBeNull();
  });

  it('returns null for JSON that is not a vitest report', () => {
    expect(parseVitestJson('{"foo": 1}')).toBeNull();
    expect(parseVitestJson('{"numTotalTests": "x", "testResults": []}')).toBeNull();
  });

  it('handles an empty report (no tests found)', () => {
    const parsed = parseVitestJson(
      JSON.stringify({
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(parsed!.results).toEqual([]);
  });
});

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\u001b[1m\u001b[31mfail\u001b[0m plain')).toBe('fail plain');
  });
});
