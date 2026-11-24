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
    check: {
      unverified_numbers: check.unverified,
      odd_scripts: check.oddScripts,
      unknown_words: check.unknownWords,
    },
  };
}
