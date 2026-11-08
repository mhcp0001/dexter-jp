/**
 * Environment handling for the MCP server (mhcp0001/homelab-infrastructure#848, #849).
 *
 * The server loads the gateway's .env, which also holds secrets it never uses (Discord and Slack
 * tokens, LLM API keys). It keeps only the data-source keys its tools need.
 */

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const NEEDED_SECRETS = new Set(['EDINETDB_API_KEY', 'JQUANTS_API_KEY', 'TAVILY_API_KEY']);

/** Remove secret-looking variables the MCP tools do not use. Returns the removed names. */
export function dropUnusedSecrets(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (SECRET_NAME.test(name) && !NEEDED_SECRETS.has(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

export const DEFAULT_EDINET_MAX_CALLS = 15;

/**
 * EDINET DB requests allowed in one MCP server process (one OpenCode turn).
 * DEXTER_MCP_EDINET_MAX_CALLS: a positive integer, or 0 for no limit. Anything else uses the default.
 */
export function edinetBudgetFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env.DEXTER_MCP_EDINET_MAX_CALLS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_EDINET_MAX_CALLS;
  if (!/^\d+$/.test(raw)) return DEFAULT_EDINET_MAX_CALLS;
  const n = Number(raw);
  return n === 0 ? null : n;
}
