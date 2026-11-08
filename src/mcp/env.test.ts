import { describe, expect, test } from 'vitest';
import { DEFAULT_EDINET_MAX_CALLS, dropUnusedSecrets, edinetBudgetFromEnv } from './env.js';

describe('MCP server environment', () => {
  test('keeps only the data-source keys among secrets', () => {
    const env: NodeJS.ProcessEnv = {
      EDINETDB_API_KEY: 'e',
      JQUANTS_API_KEY: 'j',
      TAVILY_API_KEY: 't',
      DISCORD_BOT_TOKEN: 'd',
      SLACK_APP_TOKEN: 's',
      ANTHROPIC_API_KEY: 'a',
      OPENCODE_GO_API_KEY: 'o',
      DEXTER_BACKEND: 'opencode',
      PATH: '/usr/bin',
    };
    const removed = dropUnusedSecrets(env).sort();
    expect(removed).toEqual(['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'OPENCODE_GO_API_KEY', 'SLACK_APP_TOKEN']);
    expect(Object.keys(env).sort()).toEqual(['DEXTER_BACKEND', 'EDINETDB_API_KEY', 'JQUANTS_API_KEY', 'PATH', 'TAVILY_API_KEY']);
  });

  test('reads the EDINET budget', () => {
    expect(edinetBudgetFromEnv({})).toBe(DEFAULT_EDINET_MAX_CALLS);
    expect(edinetBudgetFromEnv({ DEXTER_MCP_EDINET_MAX_CALLS: '8' })).toBe(8);
    expect(edinetBudgetFromEnv({ DEXTER_MCP_EDINET_MAX_CALLS: ' 8 ' })).toBe(8);
    expect(edinetBudgetFromEnv({ DEXTER_MCP_EDINET_MAX_CALLS: '0' })).toBeNull();
    expect(edinetBudgetFromEnv({ DEXTER_MCP_EDINET_MAX_CALLS: '-1' })).toBe(DEFAULT_EDINET_MAX_CALLS);
    expect(edinetBudgetFromEnv({ DEXTER_MCP_EDINET_MAX_CALLS: 'ten' })).toBe(DEFAULT_EDINET_MAX_CALLS);
  });
});
