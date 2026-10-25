import { afterEach, describe, expect, test } from 'vitest';
import {
  describeOpencodeError,
  isOpencodeBackend,
  parseOpencodeEvents,
  toOpencodeSessionId,
} from './opencode-runner.js';

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

describe('opencode runner', () => {
  const originalBackend = process.env.DEXTER_BACKEND;
  afterEach(() => {
    if (originalBackend === undefined) delete process.env.DEXTER_BACKEND;
    else process.env.DEXTER_BACKEND = originalBackend;
  });

  test('backend defaults to native', () => {
    delete process.env.DEXTER_BACKEND;
    expect(isOpencodeBackend()).toBe(false);
    process.env.DEXTER_BACKEND = ' OpenCode ';
    expect(isOpencodeBackend()).toBe(true);
    process.env.DEXTER_BACKEND = 'native';
    expect(isOpencodeBackend()).toBe(false);
  });

  test('session IDs are stable, distinct, and start with "ses"', () => {
    const a = toOpencodeSessionId('agent:default:discord:default:group:123');
    expect(a).toMatch(/^ses_dexter_[0-9a-f]{24}$/);
    expect(toOpencodeSessionId('agent:default:discord:default:group:123')).toBe(a);
    expect(toOpencodeSessionId('agent:default:discord:default:group:456')).not.toBe(a);
  });

  test('answer is the text of the last step, after tool calls', () => {
    const out = lines(
      { type: 'step_start', sessionID: 'ses_x' },
      { type: 'text', sessionID: 'ses_x', part: { text: '調べます。' } },
      { type: 'tool_use', sessionID: 'ses_x', part: { tool: 'dexter_get_financial_statements' } },
      { type: 'step_finish', sessionID: 'ses_x' },
      { type: 'step_start', sessionID: 'ses_x' },
      { type: 'text', sessionID: 'ses_x', part: { text: '売上高は 48 兆円です。' } },
      { type: 'step_finish', sessionID: 'ses_x' },
    );
    const result = parseOpencodeEvents(`${out}\nnot json\n`);
    expect(result.answer).toBe('売上高は 48 兆円です。');
    expect(result.sessionId).toBe('ses_x');
    expect(result.tools).toEqual(['dexter_get_financial_statements']);
    expect(result.error).toBeUndefined();
  });

  test('error events are surfaced with a reason the user can read', () => {
    const out = lines({
      type: 'error',
      sessionID: 'ses_y',
      error: { type: 'provider.quota', message: 'Free usage limit reached.', status: 429 },
    });
    const result = parseOpencodeEvents(out);
    expect(result.error).toEqual({ type: 'provider.quota', message: 'Free usage limit reached.' });
    expect(describeOpencodeError(result.error!)).toContain('利用上限');
    expect(describeOpencodeError({ type: 'provider.no-route', message: 'Model unavailable' })).toContain('使えなく');
    expect(describeOpencodeError({ type: 'unknown', message: 'x'.repeat(1000) }).length).toBeLessThan(400);
  });
});
