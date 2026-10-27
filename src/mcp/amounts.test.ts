import { describe, expect, test } from 'vitest';
import { annotateAmounts, annotateToolText, formatYen, isMoneyField } from './amounts.js';

describe('Japanese readings of yen amounts', () => {
  test('formats the amounts checked in the #650 spike', () => {
    expect(formatYen(50684952000000)).toBe('50兆6,850億円');
    expect(formatYen(21796610000000)).toBe('21兆7,966億円');
    expect(formatYen(12007888000000)).toBe('12兆79億円');
    expect(formatYen(58005000000)).toBe('580億円');
    expect(formatYen(-414346000000)).toBe('-4,143億円');
    expect(formatYen(692006000000)).toBe('6,920億円');
    expect(formatYen(3000000000000)).toBe('3兆円');
  });

  test('money fields are told apart from per-share values, ratios and counts', () => {
    for (const name of ['revenue', 'operating_income', 'net_income', 'impairment_loss', 'cf_operating', 'total_assets', 'turnover']) {
      expect(isMoneyField(name)).toBe(true);
    }
    for (const name of ['eps', 'bps', 'dividend_per_share', 'equity_ratio_official', 'roe', 'float_shares', 'credit_score', 'effective_tax_rate', 'fiscal_year']) {
      expect(isMoneyField(name)).toBe(false);
    }
  });

  test('adds _jp siblings without touching the raw values', () => {
    const out = annotateAmounts({
      data: [{ fiscal_year: 2026, revenue: 21796610000000, eps: -106.06, operating_income: -414346000000, cash: 5000 }],
    }) as { data: Array<Record<string, unknown>> };
    expect(out.data[0]).toEqual({
      fiscal_year: 2026,
      revenue: 21796610000000,
      revenue_jp: '21兆7,966億円',
      eps: -106.06,
      operating_income: -414346000000,
      operating_income_jp: '-4,143億円',
      cash: 5000,
    });
  });

  test('tool text that is not JSON passes through', () => {
    expect(annotateToolText('Company not found: ZZZZ')).toBe('Company not found: ZZZZ');
    expect(JSON.parse(annotateToolText('{"data":{"net_income":3848098000000}}'))).toEqual({
      data: { net_income: 3848098000000, net_income_jp: '3兆8,481億円' },
    });
  });
});
