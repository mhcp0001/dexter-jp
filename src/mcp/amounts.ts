/**
 * EDINET DB returns money in yen (50684952000000). Models slip by a factor of ten when they turn
 * 14-digit numbers into 兆/億 (GLM-5.3-Flash wrote 2兆1,797億円 for 21,796,610,000,000 in the #650
 * spike). Add a ready-made Japanese reading next to each large amount so the model copies it
 * instead of converting. The raw yen values stay as they are.
 */

const SUFFIX = '_jp';

// Field names that hold an amount of money (yen). Per-share values, ratios, counts and scores are
// excluded even when their names contain one of these words.
const MONEY_NAME = /(revenue|sales|income|profit|loss|assets|liabilities|equity|cash|cf_|_cf|capex|depreciation|expenses|debt|ibd_|inventories|goodwill|dividends_total|dividends_paid|surplus|earnings|land|buildings|turnover)/;
const NOT_MONEY_NAME = /(per_share|eps|bps|ratio|rate|margin|yield|shares|count|score|pct|percent|growth|cagr|days|years|headcount|_id$)/;
const MIN_YEN = 1e8;

export function isMoneyField(name: string): boolean {
  return MONEY_NAME.test(name) && !NOT_MONEY_NAME.test(name);
}

/** 50684952000000 → "50兆6,850億円"; 58005000000 → "580億円"; -414346000000 → "-4,143億円". */
export function formatYen(yen: number): string {
  const sign = yen < 0 ? '-' : '';
  const oku = Math.round(Math.abs(yen) / 1e8);
  const cho = Math.floor(oku / 10_000);
  const rest = oku % 10_000;
  if (cho === 0) return `${sign}${rest.toLocaleString('en-US')}億円`;
  return rest === 0 ? `${sign}${cho.toLocaleString('en-US')}兆円` : `${sign}${cho.toLocaleString('en-US')}兆${rest.toLocaleString('en-US')}億円`;
}

/** Copy of `value` where every large money field `x` gains a sibling `x_jp` with its Japanese reading. */
export function annotateAmounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateAmounts);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = annotateAmounts(child);
    if (typeof child === 'number' && Math.abs(child) >= MIN_YEN && isMoneyField(key) && !key.endsWith(SUFFIX)) {
      out[`${key}${SUFFIX}`] = formatYen(child);
    }
  }
  return out;
}

/** Annotate a tool result string (JSON from formatToolResult); other text passes through. */
export function annotateToolText(text: string): string {
  try {
    return JSON.stringify(annotateAmounts(JSON.parse(text)));
  } catch {
    return text;
  }
}
