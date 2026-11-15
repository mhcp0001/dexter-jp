import { describe, expect, test } from 'bun:test';
import {
  chargeEdinetRequest,
  currentGoSession,
  DEFAULT_EDINET_MAX_CALLS,
  edinetBudgetFromEnv,
  goSessionFor,
  runTurn,
} from './turn-context';

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
