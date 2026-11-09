import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveEdinetCode } from './resolver.js';
import { api as edinetApi } from './api.js';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * J-Quants V2 API client for stock price data.
 * Optional — only works when JQUANTS_API_KEY is set.
 *
 * V2 auth: API key via x-api-key header (no token refresh needed, no expiry).
 * Free plan: daily OHLC for all TSE-listed stocks (data may have a delay).
 */

const JQUANTS_BASE = 'https://api.jquants.com/v2';

function getJQuantsApiKey(): string {
  return process.env.JQUANTS_API_KEY || '';
}

/**
 * Call J-Quants V2 API.
 */
async function jquantsGet(
  endpoint: string,
  params: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const apiKey = getJQuantsApiKey();
  if (!apiKey) {
    throw new Error('JQUANTS_API_KEY not set');
  }

  const url = new URL(`${JQUANTS_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    // Keep the body: on the free plan, a range outside the subscription comes back as 400 with
    // the covered dates in the message, which the model needs to explain the gap.
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const detail = `${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`;
    logger.error(`[J-Quants] API error: ${detail}`);
    throw new Error(`J-Quants API error: ${detail}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Resolve ticker to J-Quants code format (5 digits, e.g. "72030").
 * J-Quants uses 5-digit codes; EDINET/TSE uses 4-digit.
 */
async function resolveJQuantsCode(ticker: string): Promise<string> {
  // If already 5 digits, use as-is
  if (/^\d{5}$/.test(ticker)) return ticker;

  // If 4 digits, append "0" (standard J-Quants format)
  if (/^\d{4}$/.test(ticker)) return ticker + '0';

  // Otherwise resolve through EDINET DB to get sec_code
  const edinetCode = await resolveEdinetCode(ticker);
  const { data: response } = await edinetApi.get(`/companies/${edinetCode}`, {});
  const company = (response.data || response) as Record<string, unknown>;
  const secCode = (company.sec_code || company.secCode) as string | undefined;
  if (!secCode) throw new Error(`No securities code found for ${ticker}`);
  // sec_code from EDINET is 4 digits; J-Quants needs 5
  return secCode.replace(/\D/g, '').slice(0, 4) + '0';
}

// ============================================================================
// Tools
// ============================================================================

export const STOCK_PRICE_DESCRIPTION = `
Fetches current and historical stock prices for Japanese equities from J-Quants (Tokyo Stock Exchange official data). Includes OHLC, volume, and split-adjusted prices.

**Requires:** JQUANTS_API_KEY environment variable.

## When to Use

- Current stock price (latest close, volume)
- Historical OHLC price data over a date range
- Price trend analysis and charting data

## When NOT to Use

- Company financials or ratios (use get_financials)
- Securities report content (use read_filings)
- Company screening (use company_screener)

## Notes

- Free plan data may have a delay (not real-time)
- V2 API: response fields are abbreviated (O=Open, H=High, L=Low, C=Close, Vo=Volume)
- Adjusted prices (AdjO/AdjH/AdjL/AdjC) account for stock splits
`.trim();

const StockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203' for Toyota), company name (e.g. 'トヨタ'), or EDINET code."
    ),
  from: z
    .string()
    .optional()
    .describe('Start date (YYYY-MM-DD or YYYYMMDD). If omitted, returns latest available data.'),
  to: z
    .string()
    .optional()
    .describe('End date (YYYY-MM-DD or YYYYMMDD). If omitted, defaults to latest available.'),
});

export const getStockPrice = new DynamicStructuredTool({
  name: 'get_stock_price',
  description: `Fetches stock price data for a Japanese equity from J-Quants (TSE official data). Returns OHLC, volume, and split-adjusted prices. Specify date range for historical data, or omit for the latest available price.`,
  schema: StockPriceInputSchema,
  func: async (input) => {
    const code = await resolveJQuantsCode(input.ticker);

    const params: Record<string, string | undefined> = {
      code,
      from: input.from,
      to: input.to,
    };

    const response = await jquantsGet('/equities/bars/daily', params);
    const bars = response.data as Array<Record<string, unknown>> | undefined;

    if (!bars || bars.length === 0) {
      return formatToolResult({ error: `No price data found for ${input.ticker}` }, []);
    }

    // For single-day / latest queries, return just the most recent
    if (!input.from && !input.to) {
      const latest = bars[bars.length - 1];
      return formatToolResult({
        code: latest.Code,
        date: latest.Date,
        open: latest.AdjO,
        high: latest.AdjH,
        low: latest.AdjL,
        close: latest.AdjC,
        volume: latest.AdjVo,
        turnover: latest.Va,
      }, []);
    }

    // For date ranges, return compact array with adjusted prices
    const compact = bars.map((q) => ({
      date: q.Date,
      open: q.AdjO,
      high: q.AdjH,
      low: q.AdjL,
      close: q.AdjC,
      volume: q.AdjVo,
    }));

    return formatToolResult(compact, []);
  },
});

/**
 * Check if J-Quants is available (JQUANTS_API_KEY is set).
 */
export function isJQuantsAvailable(): boolean {
  return Boolean(process.env.JQUANTS_API_KEY);
}
