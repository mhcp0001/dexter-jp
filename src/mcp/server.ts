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
import { annotateAmounts, annotateToolText } from './amounts.js';
import { describeArguments, lenientSchema, normalizeArguments } from './lenient-args.js';

// Run from the repo root so .env and .dexter/cache resolve exactly as they do for the gateway,
// whatever directory the MCP client starts us in.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '../..'));
config({ quiet: true });

const INSTRUCTIONS = `
Financial data for Japanese listed companies (EDINET DB, J-Quants).
- Company tools take the argument "ticker": a 4-digit securities code (7203), a company name (トヨタ), or an EDINET code (E02144). Securities codes are the most reliable.
- Monetary amounts from EDINET DB are in yen (not millions); e.g. revenue 50684952000000 is about 50.7 trillion yen.
- Large amounts come with a sibling field ending in _jp (revenue_jp: "50兆6,850億円"). Quote those instead of converting yen yourself.
- To compare several companies, call the same tool once per company.
- Cite the sourceUrls returned with each result.
`.trim();

async function toResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const out = await run();
    const text = typeof out === 'string' ? annotateToolText(out) : JSON.stringify(annotateAmounts(out));
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

/**
 * Register a tool whose arguments are checked leniently (see lenient-args.ts): the advertised
 * schema keeps the canonical names, and common aliases and numeric strings are accepted.
 */
function register(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
  run: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  const argumentsLine = describeArguments(schema);
  server.registerTool(
    name,
    { description: `${description}

${argumentsLine}`, inputSchema: lenientSchema(schema) },
    async (raw) => {
      const { args, missing } = normalizeArguments(raw as Record<string, unknown>, schema);
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}. ${argumentsLine}` }],
          isError: true,
        };
      }
      return toResult(() => run(args));
    },
  );
}

function registerTool(server: McpServer, tool: DynamicStructuredTool): void {
  const schema = tool.schema as z.ZodObject<z.ZodRawShape>;
  register(server, tool.name, tool.description, schema, (args) => tool.invoke(args));
}

const server = new McpServer({ name: 'dexter', version: '0.1.0' }, { instructions: INSTRUCTIONS });

for (const tool of [getFinancials, getCompanyInfo, getKeyRatios, getAnalysis, getEarnings, getTextBlocks, getShareholders]) {
  registerTool(server, tool);
}

// resolveEdinetCode() keeps only the first hit; return the candidates so the model can disambiguate.
const ResolveCompanySchema = z.object({
  query: z.string().describe("Company name or securities code (e.g. '本田技研工業', '7267')"),
  limit: z.number().optional().describe('Maximum number of candidates (default: 5)'),
});
register(
  server,
  'resolve_company',
  'Searches Japanese listed companies by name or securities code and returns candidates with EDINET code, securities code, name, and industry. Use when a company name is ambiguous. Short or katakana names may not match (ホンダ does not; 本田技研工業 and 7267 do).',
  ResolveCompanySchema,
  async (args) => {
    const { query, limit } = ResolveCompanySchema.parse(args);
    const { data, url } = await api.get('/search', { q: query, limit: limit ?? 5 });
    return formatToolResult(data.data ?? data, [url]);
  },
);

register(
  server,
  'screen_companies',
  `Screens Japanese listed companies by financial metrics (AND of all conditions). Returns matching companies with the metric values used.

${AVAILABLE_METRICS}`,
  ScreenerConditionSchema,
  (args) => runScreener(ScreenerConditionSchema.parse(args)),
);

if (isJQuantsAvailable()) {
  registerTool(server, getStockPrice);
}

if (process.env.TAVILY_API_KEY) {
  registerTool(server, tavilySearch);
}

await server.connect(new StdioServerTransport());
