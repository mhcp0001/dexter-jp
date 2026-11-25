/**
 * Evidence bundle for the oneshot (mhcp0001/homelab-infrastructure#956, experiment).
 *
 * A cheap model gathers the data (which tools, which arguments, the dead ends); a stronger reader
 * (Claude, in the Vault session) reads the raw tool results, checks the draft against them and
 * writes the conclusion. So the bundle carries the raw results next to the draft, and lists the
 * figures in the draft that no tool output supports. The draft is never a source of figures.
 *
 * The check runs on the full results; only the copy in the bundle is cut to maxResultChars.
 */
import { checkAnswer } from './answer-check.js';

export const EVIDENCE_SCHEMA = 'dexter-evidence/v1';
export const DEFAULT_EVIDENCE_MAX_RESULT_CHARS = 30_000;

export type EvidenceToolCall = {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  /** Length of the full result; result is cut when truncated is true. */
  chars: number;
  truncated: boolean;
  ms: number;
};

export type EvidenceToolError = { tool: string; error: string };

export type EvidenceBundle = {
  schema: typeof EVIDENCE_SCHEMA;
  question: string;
  provider: string;
  model: string;
  elapsed_ms: number;
  /** Unverified prose by the gathering model. Take figures from tool_calls, not from here. */
  draft: string;
  tool_calls: EvidenceToolCall[];
  tool_errors: EvidenceToolError[];
  /** What the agent and the libraries printed during the run (stderr and stray stdout), last lines only. */
  log: string[];
  check: {
    /** Figures in the draft that appear in no tool output and are not computed from figures that do. */
    unverified_numbers: string[];
    odd_scripts: string[];
    unknown_words: string[];
  };
};

export type RecordedToolEnd = { tool: string; args: Record<string, unknown>; result: string; duration: number };

export function evidenceMaxResultCharsFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EVIDENCE_MAX_RESULT_CHARS;
}

export function buildEvidence(input: {
  question: string;
  provider: string;
  model: string;
  elapsedMs: number;
  draft: string;
  toolEnds: RecordedToolEnd[];
  toolErrors: EvidenceToolError[];
  maxResultChars: number;
  log?: string[];
}): EvidenceBundle {
  const check = checkAnswer(
    input.draft,
    input.toolEnds.map((t) => t.result),
  );
  return {
    schema: EVIDENCE_SCHEMA,
    question: input.question,
    provider: input.provider,
    model: input.model,
    elapsed_ms: input.elapsedMs,
    draft: input.draft,
    tool_calls: input.toolEnds.map((t) => {
      const truncated = t.result.length > input.maxResultChars;
      return {
        tool: t.tool,
        args: t.args,
        result: truncated ? t.result.slice(0, input.maxResultChars) : t.result,
        chars: t.result.length,
        truncated,
        ms: t.duration,
      };
    }),
    tool_errors: input.toolErrors,
    log: input.log ?? [],
    check: {
      unverified_numbers: check.unverified,
      odd_scripts: check.oddScripts,
      unknown_words: check.unknownWords,
    },
  };
}

export const CAPTURE_MAX_LINES = 100;
export const CAPTURE_MAX_LINE_CHARS = 500;

type Captured = { lines(): string[]; restore(): void };

/**
 * Route console.* and process.stdout / process.stderr writes into a buffer, so that in evidence mode
 * the bundle is the only output (#956). Keeps the last CAPTURE_MAX_LINES lines, each cut to
 * CAPTURE_MAX_LINE_CHARS. restore() puts the originals back.
 */
export function captureOutput(format: (args: unknown[]) => string): Captured {
  const buffer: string[] = [];
  const push = (text: string) => {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      buffer.push(line.slice(0, CAPTURE_MAX_LINE_CHARS));
      if (buffer.length > CAPTURE_MAX_LINES) buffer.shift();
    }
  };
  // Bun writes every one of these straight to stdout or stderr (dir, table, count, trace, timeEnd, assert ...)
  const methods = [
    'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table',
    'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd', 'assert',
  ] as const;
  const savedConsole = methods.map((m) => console[m]);
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  for (const m of methods) {
    (console as unknown as Record<string, (...args: unknown[]) => void>)[m] = (...args: unknown[]) => {
      if (m === 'assert') {
        if (args[0]) return;
        push(`Assertion failed: ${format(args.slice(1))}`);
        return;
      }
      if (args.length > 0) push(format(args));
    };
  }
  const writer = ((chunk: unknown, ...rest: unknown[]) => {
    push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = writer;
  process.stderr.write = writer;
  return {
    lines: () => [...buffer],
    restore: () => {
      methods.forEach((m, i) => {
        (console as unknown as Record<string, unknown>)[m] = savedConsole[i];
      });
      process.stdout.write = savedOut;
      process.stderr.write = savedErr;
    },
  };
}
