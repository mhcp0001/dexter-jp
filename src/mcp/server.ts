#!/usr/bin/env bun
/**
 * Dexter's finance tools as an MCP server (stdio transport).
 *
 * Exposes the low-level EDINET DB / J-Quants / Tavily tools so an external agent
 * (OpenCode, see DEXTER_BACKEND=opencode) can call them with its own model.
 * The LLM-routed meta-tools (get_financials, read_filings, company_screener) are
 * deliberately not exposed: routing is left to the client's model, and this
 * server never calls an LLM itself.
 *
 * Usage: bun src/mcp/server.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getAnalysis,
  getCompanyInfo,
  getEarnings,
  getFinancials,
  getKeyRatios,
  getShareholders,
  getStockPrice,
  getTextBlocks,
  isJQuantsAvailable,
} from '../tools/finance/index.js';
import { api } from '../tools/finance/api.js';
import { AVAILABLE_METRICS, ScreenerConditionSchema, runScreener } from '../tools/finance/screen-companies.js';
import { tavilySearch } from '../tools/search/index.js';
import { formatToolResult } from '../tools/types.js';

// Run from the repo root so .env and .dexter/cache resolve exactly as they do for the gateway,
// whatever directory the MCP client starts us in.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '../..'));
config({ quiet: true });

const INSTRUCTIONS = `
Financial data for Japanese listed companies (EDINET DB, J-Quants).
- Tickers: 4-digit securities codes (7203), company names (トヨタ), or EDINET codes (E02144) all work.
- Monetary amounts from EDINET DB are in yen (not millions); e.g. revenue 50684952000000 is about 50.7 trillion yen.
- To compare several companies, call the same tool once per company.
- Cite the sourceUrls returned with each result.
`.trim();

async function toResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const out = await run();
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function registerTool(server: McpServer, tool: DynamicStructuredTool): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema as z.ZodObject<z.ZodRawShape> },
    async (args) => toResult(() => tool.invoke(args)),
  );
}

const server = new McpServer({ name: 'dexter', version: '0.1.0' }, { instructions: INSTRUCTIONS });

for (const tool of [getFinancials, getCompanyInfo, getKeyRatios, getAnalysis, getEarnings, getTextBlocks, getShareholders]) {
  registerTool(server, tool);
}

// resolveEdinetCode() keeps only the first hit; return the candidates so the model can disambiguate.
server.registerTool(
  'resolve_company',
  {
    description:
      'Searches Japanese listed companies by name or securities code and returns candidates with EDINET code, securities code, name, and industry. Use when a company name is ambiguous.',
    inputSchema: z.object({
      query: z.string().describe("Company name or securities code (e.g. 'ホンダ', '7267')"),
      limit: z.number().optional().describe('Maximum number of candidates (default: 5)'),
    }),
  },
  async ({ query, limit }) =>
    toResult(async () => {
      const { data, url } = await api.get('/search', { q: query, limit: limit ?? 5 });
      return formatToolResult(data.data ?? data, [url]);
    }),
);

server.registerTool(
  'screen_companies',
  {
    description: `Screens Japanese listed companies by financial metrics (AND of all conditions). Returns matching companies with the metric values used.\n\n${AVAILABLE_METRICS}`,
    inputSchema: ScreenerConditionSchema,
  },
  async (conditions) => toResult(() => runScreener(conditions)),
);

if (isJQuantsAvailable()) {
  registerTool(server, getStockPrice);
}

if (process.env.TAVILY_API_KEY) {
  registerTool(server, tavilySearch);
}

await server.connect(new StdioServerTransport());
