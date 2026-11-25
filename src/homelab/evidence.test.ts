import { describe, expect, test } from 'bun:test';
import { buildEvidence, CAPTURE_MAX_LINE_CHARS, CAPTURE_MAX_LINES, captureOutput, DEFAULT_EVIDENCE_MAX_RESULT_CHARS, EVIDENCE_SCHEMA, evidenceMaxResultCharsFromEnv } from './evidence.js';

const FINANCIALS = JSON.stringify({
  edinet_code: 'E02144',
  fiscal_year: 2025,
  revenue_jpy: 48036704000000,
  revenue_jpy_jp: '48兆367億円',
  operating_income_jpy_jp: '4兆7,955億円',
  operating_margin: 9.98,
});

function bundle(draft: string, maxResultChars = 1000) {
  return buildEvidence({
    question: 'トヨタの売上は？',
    provider: 'opencode-go',
    model: 'go:glm-5.3-flash',
    elapsedMs: 1234,
    draft,
    toolEnds: [{ tool: 'get_financials', args: { code: 'E02144' }, result: FINANCIALS, duration: 50 }],
    toolErrors: [{ tool: 'web_fetch', error: 'timeout' }],
    maxResultChars,
  });
}

describe('evidence bundle (#956)', () => {
  test('keeps the raw tool results and lists only the figures no tool returned', () => {
    const b = bundle('売上は48兆367億円、営業利益は4兆7,955億円（営業利益率9.98%）。純利益は3兆1,200億円。');
    expect(b.schema).toBe(EVIDENCE_SCHEMA);
    expect(b.tool_calls).toHaveLength(1);
    expect(b.tool_calls[0]).toMatchObject({ tool: 'get_financials', args: { code: 'E02144' }, result: FINANCIALS, truncated: false, ms: 50 });
    expect(b.tool_errors).toEqual([{ tool: 'web_fetch', error: 'timeout' }]);
    expect(b.check.unverified_numbers).toEqual(['3兆1,200億円']);
  });

  test('checks against the full result even when the copy in the bundle is cut', () => {
    const b = bundle('売上は48兆367億円。', 20);
    expect(b.tool_calls[0].truncated).toBe(true);
    expect(b.tool_calls[0].result).toHaveLength(20);
    expect(b.tool_calls[0].chars).toBe(FINANCIALS.length);
    expect(b.check.unverified_numbers).toEqual([]);
  });

  test('a draft with no tool calls has every figure unverified', () => {
    const b = buildEvidence({
      question: 'q', provider: 'p', model: 'm', elapsedMs: 1, draft: '売上は48兆367億円。',
      toolEnds: [], toolErrors: [], maxResultChars: 10,
    });
    expect(b.check.unverified_numbers).toEqual(['48兆367億円']);
  });

  test('result size limit from env', () => {
    expect(evidenceMaxResultCharsFromEnv(undefined)).toBe(DEFAULT_EVIDENCE_MAX_RESULT_CHARS);
    expect(evidenceMaxResultCharsFromEnv('abc')).toBe(DEFAULT_EVIDENCE_MAX_RESULT_CHARS);
    expect(evidenceMaxResultCharsFromEnv('0')).toBe(DEFAULT_EVIDENCE_MAX_RESULT_CHARS);
    expect(evidenceMaxResultCharsFromEnv('5000')).toBe(5000);
  });
});

describe('captureOutput (#956)', () => {
  test('routes console and stream writes into the buffer, and restore puts them back', () => {
    const before = { log: console.log, error: console.error, out: process.stdout.write, err: process.stderr.write };
    const cap = captureOutput((args) => args.map(String).join(' '));
    try {
      console.log('from', 'log');
      console.error('from error');
      console.warn('a\nb');
      process.stderr.write('raw stderr\n');
      let called = false;
      process.stdout.write('raw stdout', () => {
        called = true;
      });
      expect(called).toBe(true);
    } finally {
      cap.restore();
    }
    expect(cap.lines()).toEqual(['from log', 'from error', 'a', 'b', 'raw stderr', 'raw stdout']);
    expect(console.log).toBe(before.log);
    expect(console.error).toBe(before.error);
    expect(process.stdout.write).toBe(before.out);
    expect(process.stderr.write).toBe(before.err);
  });

  test('keeps only the last lines, each cut', () => {
    const cap = captureOutput((args) => args.map(String).join(' '));
    try {
      for (let i = 0; i < CAPTURE_MAX_LINES + 5; i++) console.log(`line ${i}`);
      console.log('x'.repeat(CAPTURE_MAX_LINE_CHARS + 10));
    } finally {
      cap.restore();
    }
    const lines = cap.lines();
    expect(lines).toHaveLength(CAPTURE_MAX_LINES);
    expect(lines[0]).toBe('line 6');
    expect(lines.at(-1)).toHaveLength(CAPTURE_MAX_LINE_CHARS);
  });

  test('captures the console methods Bun writes straight to the streams', () => {
    const cap = captureOutput((args) => args.map(String).join(' '));
    try {
      console.dir({ a: 1 });
      console.table([1]);
      console.count('n');
      console.trace('t');
      console.timeEnd('none');
      console.assert(true, 'not printed');
      console.assert(false, 'printed');
    } finally {
      cap.restore();
    }
    const lines = cap.lines();
    expect(lines).toContain('Assertion failed: printed');
    expect(lines.some((l) => l.includes('not printed'))).toBe(false);
    expect(lines.length).toBe(6);
  });

  test('the bundle carries the log', () => {
    const b = buildEvidence({ question: 'q', provider: 'p', model: 'm', elapsedMs: 1, draft: 'd', toolEnds: [], toolErrors: [], maxResultChars: 10, log: ['warn'] });
    expect(b.log).toEqual(['warn']);
  });
});
