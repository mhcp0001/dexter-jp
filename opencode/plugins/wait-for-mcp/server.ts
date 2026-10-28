/**
 * OpenCode plugin: hold each prompt until Dexter's MCP tools are in OpenCode's tool registry.
 *
 * `opencode run --standalone` starts the MCP server together with the session and builds the
 * first model request before the server's tools are registered (anomalyco/opencode#51812, still
 * open in 2.0.32). The first step then sees no dexter_* tools, and the model guesses or stops.
 * Waiting in the prompt-admission hook makes every turn start with the tools in place. After
 * LIMIT_MS it gives up and lets the turn run with whatever is registered.
 *
 * Loaded through "plugins" in opencode.json(c); OpenCode runs it, not Dexter.
 */

type PluginContext = {
  session: { hook(name: 'prompt', handler: () => Promise<void>): Promise<unknown> };
  tool: { list(): Promise<ReadonlyArray<{ id: string }>> };
};

const TOOL_PREFIX = 'dexter_';
const LIMIT_MS = 15_000;
const POLL_MS = 100;

export default {
  id: 'dexter-wait-for-mcp',
  async setup(ctx: PluginContext) {
    await ctx.session.hook('prompt', async () => {
      const started = Date.now();
      while (Date.now() - started < LIMIT_MS) {
        const tools = await ctx.tool.list();
        if (tools.some((tool) => tool.id.startsWith(TOOL_PREFIX))) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      console.warn(`[dexter-wait-for-mcp] no ${TOOL_PREFIX}* tools after ${LIMIT_MS} ms; continuing without them`);
    });
  },
};
