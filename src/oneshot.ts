#!/usr/bin/env bun
/**
 * Answer one question and print the answer on stdout (mhcp0001/homelab-infrastructure#903).
 * Used over SSH by the owner and by the Vault session to compare models on the same task.
 *
 *   bun src/oneshot.ts "<question>"
 *   DEXTER_MODEL=go:kimi-k3.1-pro bun src/oneshot.ts "<question>"
 *   DEXTER_PROVIDER=claude-agent-sdk DEXTER_MODEL=claude-opus-5-5 bun src/oneshot.ts "<question>"
 *
 * Model: DEXTER_MODEL, else .dexter/settings.json modelId. Provider: DEXTER_PROVIDER, else
 * settings provider. The Claude Agent SDK path reads its credential from .env.claude
 * (DEXTER_CLAUDE_ENV_FILE). Progress goes to stderr, the answer alone to stdout. No session history,
 * no memory, and no interactive tools (bash, ask_user_question): the channel is not "cli".
 *
 * DEXTER_ONESHOT_EVIDENCE=1 prints an evidence bundle (JSON, src/homelab/evidence.ts) instead of the
 * answer: the draft, the raw tool results, and the figures in the draft that no tool returned (#956).
 * In that mode stdout carries exactly one JSON document and stderr stays empty: what the agent and
 * the libraries print goes into the bundle's "log", and a failure is a JSON document with "error"
 * (exit 1). Over SSH, stdout and stderr arrive on two channels with no order between them, so a
 * stderr line printed before the JSON once landed inside it.
 */
import { config as loadDotenv } from 'dotenv';
import { inspect } from 'node:util';
import { Agent } from './agent/agent.js';
import { AgentSdkAgent } from './agent/agent-sdk-agent.js';
import type { AgentEvent } from './agent/types.js';
import { buildEvidence, captureOutput, EVIDENCE_SCHEMA, evidenceMaxResultCharsFromEnv, type EvidenceToolError, type RecordedToolEnd } from './homelab/evidence.js';
import { runTurn } from './homelab/turn-context.js';
import { getSetting } from './utils/config.js';

const CHANNEL = 'oneshot';

function isEnvFlagEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: bun src/oneshot.ts <question>');
  process.exit(2);
}

const evidenceMode = isEnvFlagEnabled(process.env.DEXTER_ONESHOT_EVIDENCE);
// In evidence mode the draft is read by a checker, not by a person: ask for figures only from tools,
// and for an explicit gap instead of a guess when a tool did not return the item (#956).
const EVIDENCE_INSTRUCTION = [
  '',
  '',
  '---',
  '答えの書き方: 数値は道具の出力にある値と、それから計算した値だけを使い、計算したときは使った数値を同じ行に書くこと。',
  '道具で取れなかった項目は、推測で埋めず「取れませんでした」と書くこと。項目の一覧が与えられているなら、項目ごとに答えること。',
].join('\n');
const agentQuery = evidenceMode ? query + EVIDENCE_INSTRUCTION : query;

// Taken before the capture below replaces it, so the bundle is the only thing on the real stdout.
const writeStdout = process.stdout.write.bind(process.stdout);
const capture = evidenceMode ? captureOutput((args) => args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')) : null;

// Resolves on the write callback or on a stream error (EPIPE when the SSH peer is gone).
async function emit(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.once('error', () => resolve());
    writeStdout(`${text}\n`, () => resolve());
  });
}

const EXIT_FALLBACK_MS = 5000;

/** Mark the run finished, with a last-resort exit in case the final write never completes. */
function finish(code: number): void {
  finished = true;
  setTimeout(() => process.exit(code), EXIT_FALLBACK_MS).unref();
}

// Set by the first of success, failure or signal; whatever comes later writes nothing. The capture
// is never undone in evidence mode (emit writes through the original stdout), so late output from the
// agent or a library still goes into the buffer instead of onto stdout / stderr.
let finished = false;

/** Report a failure: a JSON document in evidence mode, a stderr line otherwise. */
async function fail(message: string): Promise<void> {
  if (finished) return;
  finish(1);
  if (capture) {
    await emit(JSON.stringify({ schema: EVIDENCE_SCHEMA, error: message, log: capture.lines() }));
  } else {
    console.error(`[oneshot] ${message}`);
  }
  process.exit(1);
}

/** Stop the script here after fail(): fail() exits, or another ending is already being written. */
async function failAndStop(message: string): Promise<never> {
  await fail(message);
  return new Promise<never>(() => {});
}

const provider = process.env.DEXTER_PROVIDER?.trim() || getSetting('provider', 'opencode-go');
const model = process.env.DEXTER_MODEL?.trim() || getSetting('modelId', 'go:glm-5.3-flash');

async function stream(): Promise<AsyncGenerator<AgentEvent>> {
  if (provider === 'claude-agent-sdk') {
    // The Claude credential lives in its own file, read only here: the gateway never gets it, and
    // the agent's file tools cannot read it (.env.* is on upstream's secret-path list). homelab#903
    loadDotenv({ path: process.env.DEXTER_CLAUDE_ENV_FILE || '.env.claude', quiet: true });
    const budgetRaw = process.env.DEXTER_AGENT_SDK_MAX_BUDGET_USD;
    const agent = await AgentSdkAgent.create({
      model,
      channel: CHANNEL,
      maxBudgetUsd: budgetRaw && Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : undefined,
      allowMetered: isEnvFlagEnabled(process.env.DEXTER_AGENT_SDK_ALLOW_METERED),
    });
    return agent.run(agentQuery);
  }
  const agent = await Agent.create({
    model,
    modelProvider: provider,
    maxIterations: Number(process.env.DEXTER_ONESHOT_MAX_ITERATIONS) || 15,
    channel: CHANNEL,
    memoryEnabled: false,
  });
  return agent.run(agentQuery);
}

// `timeout` (and a closed SSH session) stop the run with a signal: still leave one JSON document.
if (capture) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void fail(`terminated by ${signal}`));
  // Without these, Bun prints the stack on stderr and exits with no JSON.
  process.on('uncaughtException', (err) => void fail(`uncaught: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)));
  process.on('unhandledRejection', (err) => void fail(`unhandled rejection: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)));
}

const started = Date.now();
const tools: string[] = [];
const toolEnds: RecordedToolEnd[] = [];
const toolErrors: EvidenceToolError[] = [];
let answer = null as string | null;

try {
  await runTurn(null, async () => {
    for await (const event of await stream()) {
      if (event.type === 'tool_start') tools.push(event.tool);
      if (event.type === 'tool_end') toolEnds.push({ tool: event.tool, args: event.args, result: event.result, duration: event.duration });
      if (event.type === 'tool_error') toolErrors.push({ tool: event.tool, error: event.error });
      if (event.type === 'done') answer = event.answer;
    }
  });
} catch (err) {
  await failAndStop(`agent error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
}

console.error(`[oneshot] provider=${provider} model=${model} ${Date.now() - started}ms tools=${tools.join(',') || '-'}`);
if (answer === null || answer.trim() === '') {
  await failAndStop('no answer');
}
// The agents put a failed model call into the answer ("Error: …", the SDK's "API Error: …").
// Report it as a failure so a caller comparing models does not take it for an answer.
if (/^(API )?Error: /.test(answer!.trim())) {
  await failAndStop(`failed: ${answer!.trim().slice(0, 500)}`);
}
if (finished) {
  // a signal arrived while the agent finished; its JSON is being written
  await new Promise<never>(() => {});
}
finish(0);
if (capture) {
  const bundle = buildEvidence({
    question: query,
    provider,
    model,
    elapsedMs: Date.now() - started,
    draft: answer!,
    toolEnds,
    toolErrors,
    maxResultChars: evidenceMaxResultCharsFromEnv(process.env.DEXTER_EVIDENCE_MAX_RESULT_CHARS),
    log: capture.lines(),
  });
  await emit(JSON.stringify(bundle, null, 2));
} else {
  await emit(answer!);
}
process.exit(0);
