import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chargeEdinetDaily,
  chargeEdinetRequest,
  edinetDailyMaxFromEnv,
  gatewayMemoryEnabled,
  GATEWAY_ERROR_ANSWER,
  redactErrorAnswer,
  jstDate,
  currentGoSession,
  DEFAULT_EDINET_MAX_CALLS,
  edinetBudgetFromEnv,
  goSessionFor,
  runTurn,
} from './turn-context';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dexter-tc-'));
  process.env.DEXTER_EDINET_DAILY_FILE = join(dir, 'daily.json');
  process.env.DEXTER_EDINET_DAILY_MAX = '0';
});
afterAll(() => {
  delete process.env.DEXTER_EDINET_DAILY_FILE;
  delete process.env.DEXTER_EDINET_DAILY_MAX;
  rmSync(dir, { recursive: true, force: true });
});

describe('daily EDINET cap and gateway memory (homelab#906)', () => {
  test('daily cap counts across calls, resets on a new JST day', () => {
    const env = { DEXTER_EDINET_DAILY_MAX: '2', DEXTER_EDINET_DAILY_FILE: join(dir, 'cap.json') } as NodeJS.ProcessEnv;
    const day1 = new Date('2026-11-16T03:00:00Z');
    chargeEdinetDaily(env, day1);
    chargeEdinetDaily(env, day1);
    expect(() => chargeEdinetDaily(env, day1)).toThrow(/daily budget reached \(2/);
    // 15:30 UTC is already the next day in Japan
    chargeEdinetDaily(env, new Date('2026-11-16T15:30:00Z'));
  });

  test('daily cap settings', () => {
    expect(edinetDailyMaxFromEnv({})).toBe(80);
    expect(edinetDailyMaxFromEnv({ DEXTER_EDINET_DAILY_MAX: '0' })).toBeNull();
    expect(jstDate(new Date('2026-11-16T14:59:00Z'))).toBe('2026-11-16');
    expect(jstDate(new Date('2026-11-16T15:00:00Z'))).toBe('2026-11-17');
  });

  test('error answers from the agent are replaced by a fixed sentence', () => {
    expect(redactErrorAnswer('Error: 500 upstream said acct_123')).toBe(GATEWAY_ERROR_ANSWER);
    expect(redactErrorAnswer('トヨタの営業利益は…')).toBe('トヨタの営業利益は…');
  });

  test('gateway memory switch', () => {
    expect(gatewayMemoryEnabled({})).toBe(true);
    expect(gatewayMemoryEnabled({ DEXTER_GATEWAY_MEMORY: '0' })).toBe(false);
  });
});

describe('turn context (homelab#903)', () => {
  test('EDINET budget from env', () => {
    expect(edinetBudgetFromEnv({})).toBe(DEFAULT_EDINET_MAX_CALLS);
    expect(edinetBudgetFromEnv({ DEXTER_EDINET_MAX_CALLS: '3' })).toBe(3);
    expect(edinetBudgetFromEnv({ DEXTER_EDINET_MAX_CALLS: '0' })).toBeNull();
    expect(edinetBudgetFromEnv({ DEXTER_EDINET_MAX_CALLS: 'x' })).toBe(DEFAULT_EDINET_MAX_CALLS);
  });

  test('each turn gets its own budget, and the budget stops further requests', async () => {
    process.env.DEXTER_EDINET_MAX_CALLS = '2';
    try {
      await runTurn('a', async () => {
        chargeEdinetRequest();
        chargeEdinetRequest();
        expect(() => chargeEdinetRequest()).toThrow(/budget for this turn reached \(2/);
      });
      // a new turn starts from zero, even while another one is running
      await Promise.all([
        runTurn('b', async () => { chargeEdinetRequest(); chargeEdinetRequest(); }),
        runTurn('c', async () => { chargeEdinetRequest(); chargeEdinetRequest(); }),
      ]);
    } finally {
      delete process.env.DEXTER_EDINET_MAX_CALLS;
    }
  });

  test('outside a turn there is no limit', () => {
    for (let i = 0; i < 50; i++) chargeEdinetRequest();
  });

  test('Go session: stable per session key, not the key itself, separate per turn', async () => {
    expect(goSessionFor('discord:123')).toBe(goSessionFor('discord:123'));
    expect(goSessionFor('discord:123')).not.toContain('123');
    const inA = await runTurn('discord:123', async () => currentGoSession());
    expect(inA).toBe(goSessionFor('discord:123'));
    const anon1 = await runTurn(null, async () => currentGoSession());
    const anon2 = await runTurn(null, async () => currentGoSession());
    expect(anon1).not.toBe(anon2);
    expect(currentGoSession()).toMatch(/^dexter_/);
  });
});
