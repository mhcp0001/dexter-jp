/**
 * DEXTER_BACKEND=opencode: hand each turn to an OpenCode agent instead of Dexter's own agent loop.
 *
 * OpenCode is the agent here. It calls the model itself (OpenCode's free-tier models only work
 * from OpenCode) and reaches Dexter's finance tools through the MCP server in src/mcp/server.ts.
 * This module only spawns `opencode run` and pulls the answer out of its JSON events.
 *
 * Environment:
 *   DEXTER_OPENCODE_BIN         opencode executable (default: "opencode" on PATH)
 *   DEXTER_OPENCODE_DIR         working directory holding opencode.json (default: cwd)
 *   DEXTER_OPENCODE_AGENT       agent name in opencode.json (default: "dexter")
 *   DEXTER_OPENCODE_MODEL       optional provider/model override passed as -m
 *   DEXTER_OPENCODE_TIMEOUT_MS  per-turn timeout (default: 600000)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_DETAIL_CHARS = 300;
// The OpenCode process never needs the gateway's credentials; the MCP server reads .env itself.
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;

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
  part?: { text?: string; tool?: string };
  error?: { type?: string; message?: string };
};

export type OpencodeRunResult = {
  answer: string;
  sessionId?: string;
  tools: string[];
  error?: { type: string; message: string };
};

/**
 * Parse `opencode run --format json` output (one JSON event per line).
 * The answer is the text of the last step that produced any; earlier steps are
 * narration around tool calls.
 */
export function parseOpencodeEvents(stdout: string): OpencodeRunResult {
  const result: OpencodeRunResult = { answer: '', tools: [] };
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
    return `OpenCode の無料枠の利用上限に達したため、回答できませんでした。時間をおいて試してください（${detail}）`;
  }
  if (error.type === 'provider.no-route') {
    return `OpenCode のモデルが使えなくなっています。無料枠の終了や一覧からの削除が考えられます（${detail}）`;
  }
  return `OpenCode でエラーが起き、回答できませんでした（${detail}）`;
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENV_NAME.test(name)) {
      env[name] = value;
    }
  }
  // OpenCode resolves the project from PWD; a stale PWD makes it skip opencode.json.
  env.PWD = dir;
  return env;
}

type ProcessOutput = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runProcess(bin: string, args: string[], dir: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    // stdin must be closed: `opencode run` waits on an open stdin and never starts.
    // Its own process group, so a timeout also stops the MCP server it spawned.
    const child = spawn(bin, args, { cwd: dir, env: childEnv(dir), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

// Turns in the same OpenCode session must not overlap.
const sessionTails = new Map<string, Promise<unknown>>();

export async function runOpencodeForMessage(req: OpencodeRunRequest): Promise<string> {
  if (req.isolatedSession) {
    return runOpencodeTurn(req);
  }
  const previous = sessionTails.get(req.sessionKey) ?? Promise.resolve();
  const turn = previous.catch(() => undefined).then(() => runOpencodeTurn(req));
  sessionTails.set(req.sessionKey, turn);
  try {
    return await turn;
  } finally {
    if (sessionTails.get(req.sessionKey) === turn) {
      sessionTails.delete(req.sessionKey);
    }
  }
}

async function runOpencodeTurn(req: OpencodeRunRequest): Promise<string> {
  const bin = process.env.DEXTER_OPENCODE_BIN || 'opencode';
  const dir = process.env.DEXTER_OPENCODE_DIR || process.cwd();
  const agent = process.env.DEXTER_OPENCODE_AGENT || 'dexter';
  const timeoutMs = Number(process.env.DEXTER_OPENCODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const args = ['run', '--standalone', '--agent', agent, '--format', 'json'];
  if (process.env.DEXTER_OPENCODE_MODEL) {
    args.push('-m', process.env.DEXTER_OPENCODE_MODEL);
  }
  if (!req.isolatedSession) {
    args.push('--session', toOpencodeSessionId(req.sessionKey));
  }
  // "--" keeps a query that starts with "-" from being read as a flag.
  args.push('--', req.query);

  const startedAt = Date.now();
  let output: ProcessOutput;
  try {
    output = await runProcess(bin, args, dir, timeoutMs, req.signal);
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
  if (!result.answer) {
    throw new OpencodeBackendError('opencode returned no text', 'OpenCode が空の応答を返しました。無料枠のモデル側で遮断された可能性があります');
  }
  return result.answer;
}
