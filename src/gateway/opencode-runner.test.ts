import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  childEnv,
  createTurnLimiter,
  describeOpencodeError,
  isOpencodeBackend,
  needsRetry,
  OpencodeBackendError,
  parseOpencodeEvents,
  runOpencodeForMessage,
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

  test('only the OpenCode Go key reaches the child process', () => {
    const saved = { ...process.env };
    try {
      process.env.OPENCODE_GO_API_KEY = 'go-key';
      process.env.DISCORD_BOT_TOKEN = 'discord-token';
      process.env.EDINETDB_API_KEY = 'edinet-key';
      const env = childEnv('/srv/work');
      expect(env.OPENCODE_GO_API_KEY).toBe('go-key');
      expect(env).not.toHaveProperty('DISCORD_BOT_TOKEN');
      expect(env).not.toHaveProperty('EDINETDB_API_KEY');
      expect(env.PWD).toBe('/srv/work');
    } finally {
      process.env = saved;
    }
  });

  test('an empty answer or a plan that names our tools without calling them is retried', () => {
    expect(needsRetry({ answer: '', tools: [] })).toBe(true);
    // What GLM-5.3-Flash wrote before stopping in the #650 spike
    const plan = 'Need to fetch financial statements for Toyota (7203). Use dexter_get_financial_statements with small year window.';
    expect(needsRetry({ answer: plan, tools: [] })).toBe(true);
    expect(needsRetry({ answer: plan, tools: ['dexter_get_financial_statements'] })).toBe(false);
    expect(needsRetry({ answer: '2です。', tools: [] })).toBe(false);
  });

  test('the turn limiter never runs more than its limit at once', async () => {
    for (const limit of [1, 2]) {
      const withSlot = createTurnLimiter(() => limit);
      let running = 0;
      let peak = 0;
      const task = () =>
        withSlot(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running--;
        });
      await Promise.all([task(), task(), task(), task()]);
      expect(peak).toBe(limit);
    }
  });
});

// A stand-in for `opencode run`: records argv and stdin per call, answers with empty turns first.
describe.skipIf(process.platform === 'win32')('opencode runner against a fake opencode', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function fakeOpencode(emptyTurns: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
    const bin = join(dir, 'opencode');
    writeFileSync(
      bin,
      `#!/bin/bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/count"
printf '%s\n' "$@" > "${dir}/args-$n"; cat > "${dir}/stdin-$n"
echo '{"type":"step_start","sessionID":"ses_fake"}'
if [ $n -gt ${emptyTurns} ]; then echo '{"type":"text","sessionID":"ses_fake","part":{"text":"answer '$n'"}}'; fi
`,
    );
    chmodSync(bin, 0o755);
    process.env.DEXTER_OPENCODE_BIN = bin;
    process.env.DEXTER_OPENCODE_DIR = dir;
    return dir;
  }

  test('the message goes on stdin, and an empty session turn is continued once', async () => {
    const dir = fakeOpencode(1);
    const query = '-5% 下落した "銘柄"';
    const answer = await runOpencodeForMessage({ sessionKey: 'agent:default:discord:default:group:1', query });
    expect(answer).toBe('answer 2');
    expect(readFileSync(join(dir, 'stdin-1'), 'utf8')).toBe(query);
    expect(readFileSync(join(dir, 'args-1'), 'utf8')).not.toContain(query);
    expect(readFileSync(join(dir, 'stdin-2'), 'utf8')).toBe('続けてください');
    const sessionId = toOpencodeSessionId('agent:default:discord:default:group:1');
    expect(readFileSync(join(dir, 'args-2'), 'utf8').split('\n')).toContain(sessionId);
  });

  test('an empty isolated turn is asked again from scratch', async () => {
    const dir = fakeOpencode(1);
    const answer = await runOpencodeForMessage({ sessionKey: 'oneshot', query: 'トヨタの売上高', isolatedSession: true });
    expect(answer).toBe('answer 2');
    expect(readFileSync(join(dir, 'stdin-2'), 'utf8')).toBe('トヨタの売上高');
    expect(readFileSync(join(dir, 'args-2'), 'utf8')).not.toContain('--session');
  });

  test('two empty turns end in the readable error', async () => {
    fakeOpencode(2);
    const run = runOpencodeForMessage({ sessionKey: 'oneshot', query: 'q', isolatedSession: true });
    await expect(run).rejects.toBeInstanceOf(OpencodeBackendError);
    await expect(run).rejects.toMatchObject({ userMessage: expect.stringContaining('空の応答') });
  });
});
