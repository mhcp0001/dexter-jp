#!/usr/bin/env bun
/**
 * Print the names of the tools the agent would get, one per line, without calling a model
 * or any API (homelab#906 M-4). The deploy asserts on this list: with DEXTER_PUBLIC_GATEWAY=1,
 * no browser, file, cron, subagent or memory tools.
 */
import { getToolRegistry } from '../tools/registry.js';
import { getSetting } from '../utils/config.js';

const model = process.env.DEXTER_MODEL?.trim() || getSetting('modelId', 'go:glm-5.3-flash');
for (const t of getToolRegistry(model)) console.log(t.name);
process.exit(0);
