/**
 * Per-turn context for the homelab deployment (mhcp0001/homelab-infrastructure#903).
 *
 * One gateway process serves many conversations, so per-conversation values live in
 * AsyncLocalStorage rather than module globals:
 * - `goSession`: the stable `x-opencode-session` header OpenCode Go asks clients to send
 * - `edinetBudget` / `edinetUsed`: the EDINET DB request cap for one turn (100 a day on the free plan)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

export type TurnContext = {
  goSession: string;
  edinetBudget: number | null;
  edinetUsed: number;
};

const storage = new AsyncLocalStorage<TurnContext>();
const processSession = `dexter_${randomUUID()}`;

export const DEFAULT_EDINET_MAX_CALLS = 15;

/**
 * EDINET DB requests allowed in one turn.
 * DEXTER_EDINET_MAX_CALLS: a positive integer, or 0 for no limit. Anything else uses the default.
 */
export function edinetBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.DEXTER_EDINET_MAX_CALLS?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return DEFAULT_EDINET_MAX_CALLS;
  const n = Number(raw);
  return n === 0 ? null : n;
}

/** A stable, non-identifying session id derived from a gateway session key. */
export function goSessionFor(sessionKey: string): string {
  return `dexter_${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`;
}

/** Run one turn with its own Go session header and a fresh EDINET budget. */
export function runTurn<T>(sessionKey: string | null, fn: () => Promise<T>): Promise<T> {
  const ctx: TurnContext = {
    goSession: sessionKey ? goSessionFor(sessionKey) : `dexter_${randomUUID()}`,
    edinetBudget: edinetBudgetFromEnv(),
    edinetUsed: 0,
  };
  return storage.run(ctx, fn);
}

export function currentGoSession(): string {
  return storage.getStore()?.goSession ?? processSession;
}

export function edinetBudgetExceededMessage(limit: number): string {
  return `[EDINET DB API] request budget for this turn reached (${limit} requests). ` +
    'Answer with the figures already retrieved and say which ones could not be fetched.';
}

/**
 * Count one EDINET DB network request against the current turn.
 * Outside a turn (CLI) there is no limit. Throws when the turn's budget is used up.
 */
export function chargeEdinetRequest(): void {
  const ctx = storage.getStore();
  if (!ctx || ctx.edinetBudget === null) return;
  if (ctx.edinetUsed >= ctx.edinetBudget) {
    throw new Error(edinetBudgetExceededMessage(ctx.edinetBudget));
  }
  ctx.edinetUsed += 1;
}
