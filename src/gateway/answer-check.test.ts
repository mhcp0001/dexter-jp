import { describe, expect, test } from 'vitest';
import { buildFixPrompt, checkAnswer, extractClaims, tablesToBullets, unverifiedFooter } from './answer-check.js';

// Tool outputs shaped like the 2026-11-10 Discord turn (mhcp0001/homelab-infrastructure#864)
const EDINET = JSON.stringify({
  data: {
    latest_earnings: {
      revenue_jpy: 5614028000000, revenue_jpy_jp: '5兆6,140億円', revenue_change: 17.3,
      operating_income_jpy: 643260000000, operating_income_jpy_jp: '6,433億円', operating_income_change: 26.6,
      net_income_jpy: 445299000000, net_income_jpy_jp: '4,453億円', net_income_change: -9.8,
      forecast_revenue_jpy_jp: '12兆円', forecast_eps: 206.41,
    },
  },
});
const YAHOO_FX = '- [トップ](https://finance.yahoo.co.jp)\n- 米ドル/円 チャート 為替レート一覧';
const YAHOO_6501 = '日立製作所 6501 終値 4,702 前日比 +160(+3.52%) 年初来高値 6,039 年初来安値 4,301 PTS 4,835 出来高 11,800';
const TOYOTA = JSON.stringify({ revenue_jp: '50兆6,850億円', operating_income_jp: '3兆7,662億円' });

describe('answer check', () => {
  test('flags the FX rate and the net income that no tool returned (#864)', () => {
    const answer = [
      '日立の終値は4,702円、夜間PTSは4,835円（出来高11,800株）。',
      'USD/JPY: 157.95円（bid/ask 157.95/157.97、11/10 7:19 JST）',
      '上期の売上収益 5兆6,140億円（+17.3%）、調整後営業利益 6,432億円、親会社株主利益 4,166億円（-11.9%）。',
    ].join('\n');
    const r = checkAnswer(answer, [EDINET, YAHOO_FX, YAHOO_6501]);
    expect(r.unverified).toEqual(['157.95円', '157.95', '157.97', '4,166億円', '11.9%']);
  });

  test('accepts values copied from tool outputs, raw yen or truncated', () => {
    const r = checkAnswer('売上収益は5兆6,140億円、営業利益は6,432億円、純利益は4,453億円（9.8%減）、EPSは206.41円。', [EDINET]);
    expect(r.unverified).toEqual([]);
  });

  test('accepts figures computed from other figures written in the answer', () => {
    const answer = 'トヨタの売上高は50兆6,850億円、営業利益は3兆7,662億円で、営業利益率は7.4%。';
    expect(checkAnswer(answer, [TOYOTA]).unverified).toEqual([]);
    const per = '終値4,702円、予想EPS 206.41円で、予想PERは22.8倍。';
    expect(checkAnswer(per, [EDINET, YAHOO_6501]).unverified).toEqual([]);
  });

  test('skips dates, times, years, URLs and small counts', () => {
    const claims = extractClaims('2026年3月期、11/9の終値、10月28日に発表、7:19時点、3社、Q2、https://example.com/a/12345');
    expect(claims).toEqual([]);
  });

  test('flags words from other languages and simplified-only characters', () => {
    const r = checkAnswer('JS排队PTSは、 dễ dàng 円売り。incluyen Unternehmens の整理。', [YAHOO_6501]);
    expect(r.oddScripts).toEqual(expect.arrayContaining(['队', 'ễ', 'à']));
    expect(r.unknownWords).toEqual(['incluyen', 'Unternehmens']);
  });

  test('math signs are not other scripts', () => {
    expect(checkAnswer('5,514÷206.41＝26.7倍、80億円×1.94', ['5,514 206.41']).oddScripts).toEqual([]);
  });

  test('allows English words that the sources contain', () => {
    expect(checkAnswer('Lumadaの受注が伸びた。EDINETの値。', ['Lumada HMAX']).unknownWords).toEqual([]);
  });

  test('fix prompt and footer name the figures', () => {
    const r = { unverified: ['157.95円'], oddScripts: ['队'], unknownWords: ['Vycomax'] };
    expect(buildFixPrompt(r)).toContain('157.95円');
    expect(buildFixPrompt(r)).toContain('Vycomax');
    expect(unverifiedFooter(r)).toContain('157.95円');
    expect(unverifiedFooter({ unverified: [], oddScripts: [], unknownWords: [] })).toBe('');
  });

  test('turns markdown tables into bullets', () => {
    const md = ['比較', '| 銘柄 | 終値 | PTS |', '|---|---|---|', '| 2282 日本ハム | 1,947.5 | 1,963.7 |', '| 6326 クボタ | 2,470 | 2,509 |', '以上'].join('\n');
    expect(tablesToBullets(md)).toBe(['比較', '- 2282 日本ハム — 終値: 1,947.5 / PTS: 1,963.7', '- 6326 クボタ — 終値: 2,470 / PTS: 2,509', '以上'].join('\n'));
  });
});

describe('derived figures', () => {
  test('an invented rate does not pass as a product or ratio of other figures', () => {
    const answer = '終値4,702円、PTS 4,835円、出来高11,800株、EPS 206.41円。ドル円は157.95円。';
    expect(checkAnswer(answer, [EDINET, YAHOO_6501]).unverified).toEqual(['157.95円']);
  });

  test('differences and growth computed from written figures pass', () => {
    const answer = '終値4,702円は前日4,542円から160円高、上昇率は3.5%。';
    expect(checkAnswer(answer, ['4,702 4,542']).unverified).toEqual([]);
  });
});

describe('ratios and percentage points (2026-11-11 Discord turn)', () => {
  const FIN = JSON.stringify({ data: [
    { fiscal_year: 2026, revenue: 50684952000000, revenue_jp: '50兆6,850億円', operating_income: 3766216000000, operating_income_jp: '3兆7,662億円', equity_ratio: 36.2, roe: 3.6 },
    { fiscal_year: 2025, revenue: 48036704000000, revenue_jp: '48兆367億円', operating_income: 4795586000000, operating_income_jp: '4兆7,956億円' },
  ] });

  test('a decimal ratio written next to its inputs passes', () => {
    const answer = '営業利益率は 3兆7,662億円 ÷ 50兆6,850億円 ＝ 約0.0743 ＝ 7.4%。';
    expect(checkAnswer(answer, [FIN]).unverified).toEqual([]);
  });

  test('a wrong pt difference is caught even when the number appears elsewhere in the tool output', () => {
    const answer = '利益率は前年10.0%（4兆7,956億円 ÷ 48兆367億円）から今期7.4%（3兆7,662億円 ÷ 50兆6,850億円）へ、3.6pt低下。';
    expect(checkAnswer(answer, [FIN]).unverified).toEqual(['3.6pt']);
    expect(checkAnswer(answer.replace('3.6pt', '2.6pt'), [FIN]).unverified).toEqual([]);
  });

  test('a percentage is matched only against percentages in the sources', () => {
    expect(checkAnswer('自己資本比率は36.2%。', [FIN]).unverified).toEqual([]);
    expect(checkAnswer('利益率は52.0%。', ['出来高 52.0 万株']).unverified).toEqual(['52.0%']);
  });
});

describe('inputs on the same line', () => {
  const SRC = '売上高 50兆6,850億円 21兆7,966億円 12兆79億円 営業利益 3兆7,662億円 4,143億円 580億円';
  test('a computation needs its inputs on its own line; a checked figure may be repeated', () => {
    const answer = [
      '- トヨタ: 3兆7,662億円 ÷ 50兆6,850億円 ＝ 7.4%',
      '- ホンダ: 4,143億円 ÷ 21兆7,966億円 ＝ 1.9%',
      'トヨタは7.4%、ホンダは1.9%。売上はホンダの2.3倍。',
    ].join('\n');
    expect(checkAnswer(answer, [SRC]).unverified).toEqual(['2.3倍']);
  });

  test('raw yen may be written in millions', () => {
    expect(checkAnswer('元データ: 3,766,216 ÷ 50,684,952', ['{"operating_income":3766216000000,"revenue":50684952000000}']).unverified).toEqual([]);
  });
});
