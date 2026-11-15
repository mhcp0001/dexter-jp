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
 */
import { config as loadDotenv } from 'dotenv';
import { Agent } from './agent/agent.js';
import { AgentSdkAgent } from './agent/agent-sdk-agent.js';
import type { AgentEvent } from './agent/types.js';
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
    return agent.run(query);
  }
  const agent = await Agent.create({
    model,
    modelProvider: provider,
    maxIterations: Number(process.env.DEXTER_ONESHOT_MAX_ITERATIONS) || 15,
    channel: CHANNEL,
    memoryEnabled: false,
  });
  return agent.run(query);
}

const started = Date.now();
const tools: string[] = [];
let answer = null as string | null;

await runTurn(null, async () => {
  for await (const event of await stream()) {
    if (event.type === 'tool_start') tools.push(event.tool);
    if (event.type === 'done') answer = event.answer;
  }
});

console.error(`[oneshot] provider=${provider} model=${model} ${Date.now() - started}ms tools=${tools.join(',') || '-'}`);
if (answer === null || answer.trim() === '') {
  console.error('[oneshot] no answer');
  process.exit(1);
}
// The agents put a failed model call into the answer ("Error: …", the SDK's "API Error: …").
// Report it as a failure so a caller comparing models does not take it for an answer.
if (/^(API )?Error: /.test(answer.trim())) {
  console.error(`[oneshot] failed: ${answer.trim().slice(0, 500)}`);
  process.exit(1);
}
console.log(answer);
process.exit(0);
