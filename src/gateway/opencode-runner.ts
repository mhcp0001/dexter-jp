/**
 * DEXTER_BACKEND=opencode: hand each turn to an OpenCode agent instead of Dexter's own agent loop.
 *
 * OpenCode is the agent here. It calls the model itself and reaches Dexter's finance tools
 * through the MCP server in src/mcp/server.ts. This module only spawns `opencode run` and
 * pulls the answer out of its JSON events.
 *
 * Environment:
 *   DEXTER_OPENCODE_BIN             opencode executable (default: "opencode" on PATH)
 *   DEXTER_OPENCODE_DIR             working directory holding opencode.json (default: cwd)
 *   DEXTER_OPENCODE_AGENT           agent name in opencode.json (default: "dexter")
 *   DEXTER_OPENCODE_MODEL           provider/model passed as -m. Set it: in v2.0.32 the session
 *                                   model comes from the config root, not from the agent's model
 *   DEXTER_OPENCODE_TIMEOUT_MS      per-turn timeout (default: 600000)
 *   DEXTER_OPENCODE_MAX_CONCURRENT  turns running at once in this process (default: 1).
 *                                   Each turn costs roughly 600 MB (opencode + MCP server)
 *   OPENCODE_GO_API_KEY             passed through to OpenCode for the opencode-go provider
 *   DEXTER_ANSWER_CHECK_ROUNDS      rewrites asked for when the answer check finds figures no tool
 *                                   returned (default: 2, 0 = check off). See answer-check.ts
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildFixPrompt, checkAnswer, hasProblems, tablesToBullets, unverifiedFooter, type CheckResult } from './answer-check.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_DETAIL_CHARS = 300;
// The OpenCode process never needs the gateway's credentials; the MCP server reads .env itself.
// The one exception is the key OpenCode uses to call its own model provider.
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const PASSED_SECRET_ENV = new Set(['OPENCODE_GO_API_KEY']);
// Sent when a turn ends without text (the model announced tool calls, then stopped).
const CONTINUE_PROMPT = '続けてください';

/** A failure the user should hear about (quota, blocked model, timeout) rather than silence. */
export class OpencodeBackendError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'OpencodeBackendError';
    this.userMessage = userMessage;
  }
}

export function isOpencodeBackend(): boolean {
  return (process.env.DEXTER_BACKEND ?? 'native').trim().toLowerCase() === 'opencode';
}

/** OpenCode session IDs must start with "ses"; derive a stable one per gateway session key. */
export function toOpencodeSessionId(sessionKey: string): string {
  return `ses_dexter_${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`;
}

type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: { text?: string; tool?: string; state?: { status?: string; input?: unknown; output?: unknown; error?: unknown } };
  error?: { type?: string; message?: string };
};

export type OpencodeRunResult = {
  answer: string;
  sessionId?: string;
  tools: string[];
  /** Text of each tool call's input and output, for the answer check. */
  sources: string[];
  error?: { type: string; message: string };
};

/**
 * Parse `opencode run --format json` output (one JSON event per line).
 * The answer is the text of the last step that produced any; earlier steps are
 * narration around tool calls.
 */
export function parseOpencodeEvents(stdout: string): OpencodeRunResult {
  const result: OpencodeRunResult = { answer: '', tools: [], sources: [] };
  let stepTexts: string[] = [];

  for (const line of stdout.split('\n')) {
    let event: OpencodeEvent;
    try {
      event = JSON.parse(line) as OpencodeEvent;
    } catch {
      continue;
    }
    if (!result.sessionId && event.sessionID) {
      result.sessionId = event.sessionID;
    }
    if (event.type === 'step_start') {
      stepTexts = [];
    } else if (event.type === 'text' && event.part?.text) {
      stepTexts.push(event.part.text);
      result.answer = stepTexts.join('\n\n').trim();
    } else if (event.type === 'tool_use' && event.part?.tool) {
      result.tools.push(event.part.tool);
      const state = event.part.state;
      if (state) {
        if (state.input !== undefined) result.sources.push(JSON.stringify(state.input));
        if (state.output !== undefined) result.sources.push(typeof state.output === 'string' ? state.output : JSON.stringify(state.output));
        // a failed call's message is a source too: the answer may quote it ("429", the covered dates)
        if (state.error !== undefined) result.sources.push(typeof state.error === 'string' ? state.error : JSON.stringify(state.error));
      }
    } else if (event.type === 'error') {
      result.error = { type: event.error?.type ?? 'unknown', message: event.error?.message ?? '' };
    }
  }
  return result;
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS)}…` : oneLine;
}

/** User-facing explanation for an OpenCode error event. */
export function describeOpencodeError(error: { type: string; message: string }): string {
  const detail = clip(`${error.type}: ${error.message}`);
  if (error.type === 'provider.quota') {
    return `OpenCode の利用上限に達したため、回答できませんでした。時間をおいて試してください（${detail}）`;
  }
  if (error.type === 'provider.no-route') {
    return `OpenCode のモデルが使えなくなっています。提供の終了や一覧からの削除が考えられます（${detail}）`;
  }
  return `OpenCode でエラーが起き、回答できませんでした（${detail}）`;
}

export function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (!SECRET_ENV_NAME.test(name) || PASSED_SECRET_ENV.has(name))) {
      env[name] = value;
    }
  }
  // OpenCode resolves the project from PWD; a stale PWD makes it skip opencode.json.
  env.PWD = dir;
  return env;
}

type ProcessOutput = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runProcess(
  bin: string,
  args: string[],
  input: string,
  dir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also stops the MCP server it spawned.
    const child = spawn(bin, args, { cwd: dir, env: childEnv(dir), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    // `opencode run` reads the message from stdin until EOF. Leaving stdin open makes it wait forever.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const stop = () => {
      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          child.kill(sig);
        }
      };
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 5_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export type OpencodeRunRequest = {
  sessionKey: string;
  query: string;
  /** Start a fresh OpenCode session instead of continuing the one tied to sessionKey. */
  isolatedSession?: boolean;
  signal?: AbortSignal;
};

/**
 * Caps how many turns run at once. A released slot is handed straight to the next waiter,
 * so a caller arriving in between cannot push the count over the limit.
 */
export function createTurnLimiter(limit: () => number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (running < limit()) {
      running++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

const withTurnSlot = createTurnLimiter(() => Math.max(1, Number(process.env.DEXTER_OPENCODE_MAX_CONCURRENT) || 1));

// Turns in the same OpenCode session must not overlap.
const sessionTails = new Map<string, Promise<unknown>>();

export async function runOpencodeForMessage(req: OpencodeRunRequest): Promise<string> {
  if (req.isolatedSession) {
    return withTurnSlot(() => runOpencodeTurn(req));
  }
  const previous = sessionTails.get(req.sessionKey) ?? Promise.resolve();
  const turn = previous.catch(() => undefined).then(() => withTurnSlot(() => runOpencodeTurn(req)));
  sessionTails.set(req.sessionKey, turn);
  try {
    return await turn;
  } finally {
    if (sessionTails.get(req.sessionKey) === turn) {
      sessionTails.delete(req.sessionKey);
    }
  }
}

/**
 * True when a run ended without a usable answer: no text, or only a plan that names our tools
 * without having called any. The model did this when the first step could not see the MCP tools
 * (#650 spike); the wait-for-mcp plugin fixes the cause, and this retry stays as a backstop.
 */
export function needsRetry(result: Pick<OpencodeRunResult, 'answer' | 'tools'>): boolean {
  return !result.answer || (result.tools.length === 0 && /\bdexter_[a-z_]+/.test(result.answer));
}

async function runOpencodeTurn(req: OpencodeRunRequest): Promise<string> {
  const sessionId = req.isolatedSession ? undefined : toOpencodeSessionId(req.sessionKey);
  let result = await runAttempt(req, req.query, sessionId);
  const sources = [...result.sources];
  if (needsRetry(result)) {
    // Retry once: continue the same session, or ask an isolated question again from scratch.
    console.error(`[opencode] no answer, retrying once (${sessionId ? 'continue' : 'rerun'})`);
    result = sessionId ? await runAttempt(req, CONTINUE_PROMPT, sessionId) : await runAttempt(req, req.query);
    sources.push(...result.sources);
    if (needsRetry(result)) {
      throw new OpencodeBackendError(
        'opencode returned no text',
        'OpenCode が空の応答を返しました。モデルが答えを出さずに止まったか、遮断された可能性があります。もう一度試してください',
      );
    }
  }
  return checkAndFix(req, result.answer, sessionId ?? result.sessionId, sources);
}

// Tool outputs seen in each gateway session, so a follow-up answer can cite an earlier turn's values.
const sessionSources = new Map<string, string[]>();
const MAX_SESSION_SOURCE_CHARS = 2_000_000;

function rememberSources(sessionKey: string, sources: string[]): string[] {
  const all = [...(sessionSources.get(sessionKey) ?? []), ...sources];
  let total = all.reduce((n, s) => n + s.length, 0);
  while (all.length > 1 && total > MAX_SESSION_SOURCE_CHARS) total -= all.shift()!.length;
  sessionSources.set(sessionKey, all);
  return all;
}

function answerCheckRounds(): number {
  const n = Number(process.env.DEXTER_ANSWER_CHECK_ROUNDS ?? 2);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

function problemCount(r: CheckResult): number {
  return r.unverified.length + r.oddScripts.length + r.unknownWords.length;
}

function describeCheck(r: CheckResult): string {
  return `unverified=${r.unverified.join('|') || '-'} odd=${r.oddScripts.join('') || '-'} words=${r.unknownWords.join('|') || '-'}`;
}

/**
 * Check the answer against the tool outputs (#864). When figures no tool returned or words from other
 * languages show up, send the findings back to the same session and ask for a rewrite, up to
 * DEXTER_ANSWER_CHECK_ROUNDS times. A rewrite is kept only when it has fewer problems. Figures still
 * unverified at the end are listed under the answer, so the user never reads them as checked.
 */
async function checkAndFix(req: OpencodeRunRequest, answer: string, sessionId: string | undefined, turnSources: string[]): Promise<string> {
  const rounds = answerCheckRounds();
  if (rounds === 0) return tablesToBullets(answer);
  const sources = req.isolatedSession ? [...turnSources] : rememberSources(req.sessionKey, turnSources);
  let best = answer;
  let check = checkAnswer(best, sources);
  for (let round = 1; round <= rounds && hasProblems(check) && sessionId; round++) {
    console.error(`[answer-check] round=${round} ${describeCheck(check)}`);
    let fixed: OpencodeRunResult;
    try {
      fixed = await runAttempt(req, buildFixPrompt(check), sessionId);
    } catch (err) {
      console.error(`[answer-check] rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    sources.push(...fixed.sources);
    if (!req.isolatedSession) rememberSources(req.sessionKey, fixed.sources);
    if (!fixed.answer) break;
    const next = checkAnswer(fixed.answer, sources);
    if (problemCount(next) > problemCount(check)) break;
    best = fixed.answer;
    check = next;
  }
  console.error(`[answer-check] final ${describeCheck(check)}`);
  return tablesToBullets(best) + unverifiedFooter(check);
}

/** One `opencode run`. Returns the parsed events; throws on errors. */
async function runAttempt(req: OpencodeRunRequest, input: string, sessionId?: string): Promise<OpencodeRunResult> {
  const bin = process.env.DEXTER_OPENCODE_BIN || 'opencode';
  const dir = process.env.DEXTER_OPENCODE_DIR || process.cwd();
  const agent = process.env.DEXTER_OPENCODE_AGENT || 'dexter';
  const timeoutMs = Number(process.env.DEXTER_OPENCODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const args = ['run', '--standalone', '--agent', agent, '--format', 'json'];
  if (process.env.DEXTER_OPENCODE_MODEL) {
    args.push('-m', process.env.DEXTER_OPENCODE_MODEL);
  }
  if (sessionId) {
    args.push('--session', sessionId);
  }
  // The message goes on stdin, not argv. In v2.0.32 a message after "--" is recorded twice,
  // and an argument containing spaces is recorded wrapped in literal quotes.

  const startedAt = Date.now();
  let output: ProcessOutput;
  try {
    output = await runProcess(bin, args, input, dir, timeoutMs, req.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OpencodeBackendError(`failed to start ${bin}: ${message}`, `OpenCode を起動できませんでした（${clip(message)}）`);
  }

  const result = parseOpencodeEvents(output.stdout);
  // stderr, so oneshot's stdout carries only the answer.
  console.error(
    `[opencode] session=${result.sessionId ?? '-'} exit=${output.code} ${Date.now() - startedAt}ms tools=${result.tools.join(',') || '-'}`,
  );

  if (output.timedOut) {
    throw new OpencodeBackendError(
      `opencode run timed out after ${timeoutMs}ms`,
      `OpenCode が ${Math.round(timeoutMs / 1000)} 秒以内に答えを返しませんでした。問いを絞って試してください`,
    );
  }
  if (result.error) {
    throw new OpencodeBackendError(`opencode error ${result.error.type}: ${result.error.message}`, describeOpencodeError(result.error));
  }
  if (output.code !== 0) {
    const detail = clip(output.stderr || output.stdout || `exit ${output.code}`);
    throw new OpencodeBackendError(`opencode exited with ${output.code}: ${detail}`, `OpenCode が異常終了しました（${detail}）`);
  }
  return result;
}
