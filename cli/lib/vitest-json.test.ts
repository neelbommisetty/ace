import { describe, expect, it } from 'vitest';
import { parseVitestJson } from './vitest-json.js';

const ESC = '';

describe('parseVitestJson — collection failure vs. genuinely-empty suite (NEE-332)', () => {
  it('flags a compile/collection failure: success:false, numTotalTests:0, per-file message', () => {
    const raw = JSON.stringify({
      success: false,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          assertionResults: [],
          status: 'failed',
          message: `${ESC}[31mSyntaxError${ESC}[39m: Unexpected token (solution.ts:12:3)\n    at transform`,
        },
      ],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(parsed!.results).toEqual([]);
    expect(parsed!.compileError).toBe(
      'SyntaxError: Unexpected token (solution.ts:12:3)\n    at transform',
    );
  });

  it('joins messages across multiple failed files and strips ANSI from each', () => {
    const raw = JSON.stringify({
      success: false,
      numTotalTests: 0,
      testResults: [
        { assertionResults: [], message: `${ESC}[31mfirst error${ESC}[39m` },
        { assertionResults: [], message: `${ESC}[31msecond error${ESC}[39m` },
      ],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed!.compileError).toBe('first error\n\nsecond error');
  });

  it('falls back to a generic message when success:false but no per-file message exists', () => {
    const raw = JSON.stringify({
      success: false,
      numTotalTests: 0,
      testResults: [{ assertionResults: [] }],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed!.compileError).toBe('vitest reported a collection failure');
  });

  it('is NOT a compile error when success:true and numTotalTests:0 — genuinely no tests', () => {
    const raw = JSON.stringify({
      success: true,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      testResults: [],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.compileError).toBeNull();
    expect(parsed!.summary).toMatchObject({ total: 0, passed: 0, failed: 0 });
  });

  it('defaults success to true when the field is absent (older/synthetic reports)', () => {
    const raw = JSON.stringify({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      testResults: [],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed!.compileError).toBeNull();
  });

  it('is not a compile error when success:false but tests were actually collected', () => {
    // Some tests genuinely failed — total > 0 — which is a normal red run,
    // not a collection failure, even though the report's success is false.
    const raw = JSON.stringify({
      success: false,
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          assertionResults: [
            { title: 'a', status: 'passed', duration: 1, failureMessages: [] },
            { title: 'b', status: 'failed', duration: 1, failureMessages: ['boom'] },
          ],
        },
      ],
    });
    const parsed = parseVitestJson(raw);
    expect(parsed!.compileError).toBeNull();
    expect(parsed!.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });
});
