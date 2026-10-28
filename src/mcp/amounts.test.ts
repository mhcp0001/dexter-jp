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

  // Every field of 1e8 or more that the EDINET DB tools returned in the #650 spike logs on CT105.
  test('all yen fields seen in the spike get a reading, and share counts do not', () => {
    const yen = [
      'advances_received', 'allowance_for_doubtful_accounts', 'bonds_payable', 'capital_stock_gbiz', 'commercial_papers',
      'construction_in_progress', 'cross_shareholding_total_book_value', 'current_portion_bonds_payable',
      'current_portion_lt_loans', 'director_remuneration_total', 'forecast_dividend_total', 'investment_securities',
      'lease_obligations_cl', 'lease_obligations_ncl', 'long_term_loans', 'machinery_and_equipment',
      'net_defined_benefit_asset', 'net_defined_benefit_liability', 'non_controlling_interests', 'ppe', 'purchase_of_ppe',
      'sga', 'short_term_loans', 'short_term_securities', 'software', 'trade_payables', 'trade_receivables',
      'treasury_cancelled_amount', 'treasury_other_disposed_amount', 'treasury_stock',
      'buildings_and_structures', 'capex', 'capital_surplus', 'cash', 'cash_dividends_paid', 'cf_exchange_effect',
      'cf_financing', 'cf_investing', 'cf_operating', 'comprehensive_income', 'contract_liabilities', 'cost_of_sales',
      'current_assets', 'current_liabilities', 'deferred_tax_assets', 'deferred_tax_liabilities', 'depreciation',
      'dividends_total_announced', 'extraordinary_income', 'extraordinary_loss', 'gross_profit', 'ibd_current',
      'ibd_noncurrent', 'impairment_loss', 'income_taxes', 'intangible_assets', 'interest_expenses', 'interest_income',
      'inventories', 'investments_and_other_assets', 'land', 'net_assets', 'net_income', 'non_operating_expenses',
      'non_operating_income', 'noncurrent_assets', 'noncurrent_liabilities', 'operating_income', 'ordinary_income',
      'owners_equity', 'profit_before_tax', 'retained_earnings', 'revenue', 'revenue_non_consolidated', 'rnd_expenses',
      'shareholders_equity', 'total_assets', 'total_liabilities', 'turnover',
    ];
    const counts = [
      'cross_shareholding_total_shares_held', 'float_shares', 'shares_eligible', 'shares_issued',
      'shares_issued_fiscal_year_end', 'treasury_cancelled_count', 'treasury_end_period_holding_count',
      'treasury_shares_count', 'treasury_shares_count_kei', 'director_remuneration_headcount',
    ];
    expect(yen.filter((name) => !isMoneyField(name))).toEqual([]);
    expect(counts.filter((name) => isMoneyField(name))).toEqual([]);
  });

  test('the balance sheet items DeepSeek slipped on get readings', () => {
    const out = annotateAmounts({ bonds_payable: 2671312000000, long_term_loans: 2539845000000, shares_issued: 15794987460 });
    expect(out).toEqual({
      bonds_payable: 2671312000000,
      bonds_payable_jp: '2兆6,713億円',
      long_term_loans: 2539845000000,
      long_term_loans_jp: '2兆5,398億円',
      shares_issued: 15794987460,
    });
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
