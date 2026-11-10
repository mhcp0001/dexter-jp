/**
 * Answer check for the opencode backend (mhcp0001/homelab-infrastructure#864).
 *
 * A small model (GLM-5.3-Flash) copies tool values well but sometimes fills in a value no tool
 * returned (an FX rate from a page that came back without prices), swaps values between two
 * sources, or drifts into words from other languages. This module checks an answer against the
 * text of the tool outputs of the same conversation:
 *
 *   - every number must appear in a tool output, or be computable from two other numbers written
 *     in the answer (ratio, percentage, growth, difference, sum, product), as the prompt asks
 *   - no characters from other scripts (Hangul, Cyrillic, Vietnamese letters, simplified-only
 *     Chinese) and, in a Japanese answer, no long Latin words that no tool output contains
 *
 * The runner sends the findings back to the model to rewrite the answer, and flags what is left.
 * Markdown tables are turned into bullet lists, since Discord shows them as raw `|` characters.
 */

export type Claim = { raw: string; value: number; tol: number; kind: 'plain' | 'percent' | 'times' | 'amount' };

export type CheckResult = {
  unverified: string[];
  oddScripts: string[];
  unknownWords: string[];
};

const UNIT: Record<string, number> = { 兆: 1e12, 億: 1e8, 万: 1e4 };

// Spans that hold numbers but are not figures to verify: URLs, dates, times, fiscal periods.
const B = '(?<![\\d.,])'; // not in the middle of a number
const E = '(?![\\d.,]\\d)';
const NOT_FIGURES = [
  /https?:\/\/\S+/g,
  new RegExp(`${B}\\d{4}-\\d{1,2}-\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?`, 'g'),
  new RegExp(`${B}\\d{4}/\\d{1,2}/\\d{1,2}${E}`, 'g'),
  new RegExp(`${B}\\d{4}年(?:\\d{1,2}月(?:\\d{1,2}日)?)?(?:期|度)?`, 'g'),
  new RegExp(`${B}\\d{1,2}月\\d{1,2}日`, 'g'),
  new RegExp(`${B}\\d{1,2}月(?:期|末|上旬|中旬|下旬)?`, 'g'),
  new RegExp(`${B}\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?${E}`, 'g'),
  new RegExp(`${B}\\d{1,2}:\\d{2}(?::\\d{2})?${E}`, 'g'),
  /第\d四半期|Q[1-4]|[1-4]Q|H[12]|FY\d{2,4}/g,
  new RegExp(`${B}\\d{1,2}日`, 'g'),
];

// A number, optionally a compound Japanese amount (5兆6,140億), then an optional unit.
const NUMBER = /(\d[\d,]*(?:\.\d+)?)(?:\s*(兆)(?:\s*(\d[\d,]*(?:\.\d+)?)\s*(億))?|\s*(億|万))?\s*(%|％|倍|円|株|ドル)?/g;

function toNumber(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/** Size of one unit in the last written digit (6,433億 → 1e8, 21.3兆 → 1e11, 157.95 → 0.01). */
function lastDigitUnit(text: string, scale: number): number {
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  return scale * 10 ** -decimals;
}

function parseAt(match: RegExpExecArray): Claim | null {
  const [raw, first, cho, second, , single, suffix] = match;
  if (cho) {
    const value = toNumber(first) * UNIT.兆 + (second ? toNumber(second) * UNIT.億 : 0);
    const tol = second ? lastDigitUnit(second, UNIT.億) : lastDigitUnit(first, UNIT.兆);
    return { raw: raw.trim(), value, tol, kind: 'amount' };
  }
  if (single) {
    const scale = UNIT[single];
    return { raw: raw.trim(), value: toNumber(first) * scale, tol: lastDigitUnit(first, scale), kind: 'amount' };
  }
  const value = toNumber(first);
  if (!Number.isFinite(value)) return null;
  const tol = lastDigitUnit(first, 1);
  const kind = suffix === '%' || suffix === '％' ? 'percent' : suffix === '倍' ? 'times' : 'plain';
  return { raw: raw.trim(), value, tol, kind };
}

function blankOut(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const p of patterns) out = out.replace(p, (m) => ' '.repeat(m.length));
  return out;
}

/** Figures written in an answer that need a source. Small counts, years and dates are skipped. */
export function extractClaims(answer: string): Claim[] {
  const text = blankOut(answer, NOT_FIGURES);
  const claims: Claim[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const c = parseAt(m as RegExpExecArray);
    if (!c) continue;
    const digits = m[1].replace(/,/g, '');
    const isSmallCount = c.kind === 'plain' && !digits.includes('.') && Math.abs(c.value) < 100;
    const isYear = c.kind === 'plain' && /^(19|20)\d{2}$/.test(digits);
    if (isSmallCount || isYear) continue;
    claims.push(c);
  }
  return claims;
}

/** Every number in the tool outputs, with the scaled forms an answer may use. */
export function sourceValues(sources: string[]): number[] {
  const values = new Set<number>();
  for (const text of sources) {
    for (const m of text.matchAll(NUMBER)) {
      const c = parseAt(m as RegExpExecArray);
      if (!c) continue;
      values.add(c.value);
      if (c.kind !== 'amount') {
        // 0.1012 → 10.12 (%); also negative values written without the sign (▲4,143億円)
        if (Math.abs(c.value) < 1) values.add(c.value * 100);
      }
    }
  }
  return [...values];
}

function hasNear(values: number[], target: number, tol: number): boolean {
  // compared by magnitude: answers write ▲ / − / 減 instead of a sign
  const t = Math.abs(target);
  return values.some((v) => Math.abs(Math.abs(v) - t) <= tol);
}

/**
 * Whether c can be computed from two other figures in the answer. Only the computations an analyst
 * writes are allowed, by kind, so that an invented number rarely matches by chance:
 *   %   : a / b × 100, growth (a / b − 1) × 100        倍 : a / b
 *   amounts and plain figures: a − b, a + b of the same kind (difference of two prices, sum of two companies)
 */
function derivable(c: Claim, inputs: Claim[]): boolean {
  const target = Math.abs(c.value);
  const rounding = c.kind === 'percent' || c.kind === 'times' ? Math.max(c.tol, target * 0.005) : c.tol * 1.5;
  for (const a of inputs) {
    for (const b of inputs) {
      if (a === b) continue;
      const x = Math.abs(a.value);
      const y = Math.abs(b.value);
      let candidates: number[] = [];
      if (c.kind === 'percent' && y !== 0) candidates = [(x / y) * 100, (x / y - 1) * 100, (1 - x / y) * 100];
      else if (c.kind === 'times' && y !== 0) candidates = [x / y];
      else if ((c.kind === 'amount' || c.kind === 'plain') && a.kind === c.kind && b.kind === c.kind) candidates = [x - y, x + y];
      if (candidates.some((v) => Math.abs(Math.abs(v) - target) <= rounding)) return true;
    }
  }
  return false;
}

// Latin-1 letters only: × (U+00D7) and ÷ (U+00F7) are math signs an answer may use
const ODD_SCRIPT = /[\u0400-\u04FF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0E00-\u0E7F\u0600-\u06FF\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF]/u;
// Simplified-only forms that a Japanese answer never uses (隊→队, 時→时, 業→业 ...)
const SIMPLIFIED_ONLY = /[们这说时对为发经过还进队见让关头东车马长门问间线务产业]/u;
const KNOWN_WORDS = new Set(['edinet', 'quants', 'yahoo', 'tdnet', 'discord', 'opencode', 'tavily', 'ebitda', 'ebita', 'nikkei']);

/** Check an answer against the tool outputs of its conversation. */
export function checkAnswer(answer: string, sources: string[]): CheckResult {
  const claims = extractClaims(answer);
  const values = sourceValues(sources);
  const sourced = claims.filter((c) => hasNear(values, c.value, c.tol));
  // two passes: a figure computed from sourced figures may feed another computation
  const verified = new Set<Claim>(sourced);
  for (let pass = 0; pass < 2; pass++) {
    for (const c of claims) {
      if (!verified.has(c) && derivable(c, [...verified])) verified.add(c);
    }
  }
  const unverified = [...new Set(claims.filter((c) => !verified.has(c)).map((c) => c.raw))];

  const oddScripts = [...new Set([...answer].filter((ch) => ODD_SCRIPT.test(ch) || SIMPLIFIED_ONLY.test(ch)))];

  const japanese = /[぀-ヿ]/u.test(answer);
  const haystack = sources.join('\n').toLowerCase();
  const prose = blankOut(answer, [/https?:\/\/\S+/g, /\[[^\]]*\]\([^)]*\)/g]);
  const unknownWords = japanese
    ? [...new Set(prose.match(/[A-Za-z][A-Za-z-]{4,}/g) ?? [])].filter(
        (w) => !KNOWN_WORDS.has(w.toLowerCase().replace(/^j-/, '')) && !haystack.includes(w.toLowerCase()),
      )
    : [];

  return { unverified, oddScripts, unknownWords };
}

export function hasProblems(r: CheckResult): boolean {
  return r.unverified.length > 0 || r.oddScripts.length > 0 || r.unknownWords.length > 0;
}

/** The message sent back to the model when the check finds problems. */
export function buildFixPrompt(r: CheckResult): string {
  const lines = ['あなたの答えを道具の出力と照合したところ、次の問題が見つかりました。'];
  if (r.unverified.length > 0) {
    lines.push(
      `- 道具の出力に見当たらない数値: ${r.unverified.join('、')}`,
      '  （計算した値なら、計算に使った数値を同じ文に書いてください。道具で取れなかった値なら「取れませんでした」と書いてください）',
    );
  }
  if (r.oddScripts.length > 0 || r.unknownWords.length > 0) {
    lines.push(`- 日本語として崩れている語、または他の言語の語: ${[...r.oddScripts, ...r.unknownWords].join('、')}`);
  }
  lines.push(
    '答え全体を書き直してください。数値は道具の出力にある値と、それから計算した値だけを使ってください。',
    '必要なら道具を呼び直してかまいません。表は使わず、箇条書きにしてください。書き直した答えだけを出してください。',
  );
  return lines.join('\n');
}

/** Footer added when figures remain unverified after the rewrites. */
export function unverifiedFooter(r: CheckResult): string {
  return r.unverified.length > 0 ? `\n\n⚠️ 次の数値は、道具の出力と照合できませんでした: ${r.unverified.join('、')}` : '';
}

/** Turn markdown tables into bullet lists ("- 見出し1: 値1 / 見出し2: 値2"). */
export function tablesToBullets(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const header = cells(lines[i]);
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        const row = cells(lines[i]);
        const [first, ...rest] = row;
        const pairs = rest.map((v, k) => `${header[k + 1] ?? ''}: ${v}`.trim()).filter((p) => !/^:?\s*$/.test(p));
        out.push(`- ${first}${pairs.length ? ` — ${pairs.join(' / ')}` : ''}`);
        i++;
      }
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}
