/**
 * Per-turn context for the homelab deployment (mhcp0001/homelab-infrastructure#903).
 *
 * One gateway process serves many conversations, so per-conversation values live in
 * AsyncLocalStorage rather than module globals:
 * - `goSession`: the stable `x-opencode-session` header OpenCode Go asks clients to send
 * - `edinetBudget` / `edinetUsed`: the EDINET DB request cap for one turn (100 a day on the free plan)
 *
 * A daily cap is kept in a file so the gateway, cron and every oneshot process share it (homelab#906 H-2).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

// Mixed into the session id so it cannot be matched from a known Discord channel id (homelab#906 L-2).
// Stable per host: /etc/machine-id, else a random value for this process.
const sessionSalt = (() => {
  try {
    const id = readFileSync('/etc/machine-id', 'utf8').trim();
    if (id) return id;
  } catch {
    // not Linux, or unreadable
  }
  return randomUUID();
})();

/** A stable, non-identifying session id derived from a gateway session key. */
export function goSessionFor(sessionKey: string): string {
  return `dexter_${createHash('sha256').update(sessionSalt).update('\0').update(sessionKey).digest('hex').slice(0, 24)}`;
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

export const DEFAULT_EDINET_DAILY_MAX = 80;

/** Requests allowed per day across all processes. DEXTER_EDINET_DAILY_MAX: positive integer, or 0 for no limit. */
export function edinetDailyMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.DEXTER_EDINET_DAILY_MAX?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return DEFAULT_EDINET_DAILY_MAX;
  const n = Number(raw);
  return n === 0 ? null : n;
}

/** The date in Japan (EDINET DB's day). */
export function jstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function dailyFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTER_EDINET_DAILY_FILE || '.dexter/edinet-daily.json';
}

/**
 * Count one request against today's cap in the shared file. Read-modify-write without a lock:
 * two processes racing can lose a count, which is acceptable for a soft guard under a hard 100.
 */
export function chargeEdinetDaily(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  const limit = edinetDailyMaxFromEnv(env);
  if (limit === null) return;
  const file = dailyFile(env);
  const today = jstDate(now);
  let used = 0;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { date?: string; used?: number };
    if (data.date === today && Number.isInteger(data.used)) used = data.used as number;
  } catch {
    // no file yet, or unreadable: start from zero
  }
  if (used >= limit) {
    throw new Error(`[EDINET DB API] daily budget reached (${limit} requests today). ` +
      'Answer with what is already known and say that EDINET DB could not be queried until tomorrow.');
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ date: today, used: used + 1 }));
  renameSync(tmp, file);
}

/**
 * Count one EDINET DB network request: today's cap always (also outside a turn), and the
 * current turn's cap when inside one. Throws when either is used up.
 */
export function chargeEdinetRequest(): void {
  const ctx = storage.getStore();
  if (ctx && ctx.edinetBudget !== null && ctx.edinetUsed >= ctx.edinetBudget) {
    throw new Error(edinetBudgetExceededMessage(ctx.edinetBudget));
  }
  chargeEdinetDaily();
  if (ctx) ctx.edinetUsed += 1;
}

/** Whether gateway sessions read and write memory. DEXTER_GATEWAY_MEMORY=0 turns it off (homelab#906 M-1). */
export function gatewayMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.DEXTER_GATEWAY_MEMORY ?? '').trim().toLowerCase());
}

export const GATEWAY_ERROR_ANSWER = '⚠️ エラーが起き、回答できませんでした。時間を空けて再度お試しください。';

/**
 * The agent turns an LLM failure into an answer starting with "Error: " and up to 300 characters of
 * the provider's message. In a group everyone sees it, so the chat gets a fixed sentence and the
 * detail goes to the journal (homelab#906 N-1, the same rule as #849 L-5).
 */
export function redactErrorAnswer(answer: string): string {
  if (!answer.startsWith('Error: ')) return answer;
  console.error(`[gateway] agent error answer: ${answer}`);
  return GATEWAY_ERROR_ANSWER;
}
