#!/usr/bin/env bun
import { config } from "dotenv";
config({ quiet: true });

import { Agent } from "./agent/index.js";
import { getSetting } from "./utils/config.js";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: bun src/oneshot.ts <query>");
  process.exit(1);
}

const provider = getSetting("provider", "anthropic");
const modelId = getSetting("modelId", "claude-sonnet-4-5");

const agent = await Agent.create({
  model: modelId,
  modelProvider: provider,
  maxIterations: 15,
  channel: "cli",
});

for await (const event of agent.run(query)) {
  if (event.type === "tool_start") {
    process.stderr.write(`[tool: ${event.tool}] `);
  }
  if (event.type === "tool_end") {
    process.stderr.write("done\n");
  }
  if (event.type === "done") {
    console.log(event.answer);
    process.exit(0);
  }
}
