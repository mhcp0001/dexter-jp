import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { describeArguments, lenientSchema, normalizeArguments, requiredArguments } from './lenient-args.js';

const FinancialsSchema = z.object({
  ticker: z.string().describe('Securities code'),
  period: z.enum(['annual', 'quarterly']).optional(),
  years: z.number().optional().describe('Number of fiscal years'),
});
const ResolveSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

describe('lenient MCP arguments', () => {
  test('the advertised schema keeps canonical names and number types', () => {
    const json = z.toJSONSchema(lenientSchema(FinancialsSchema), { io: 'input' }) as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(Object.keys(json.properties)).toEqual(['ticker', 'period', 'years']);
    expect(json.properties.years.type).toBe('number');
    expect(json.properties.ticker.description).toBe('Securities code');
  });

  test('aliases and numeric strings pass validation and normalize to canonical arguments', () => {
    // Argument shapes GLM-5.3-Flash actually sent in the #650 spike
    for (const raw of [
      { securities_code: '7203', years: '2' },
      { ticker_or_code: '7203', period: 'annual', years: 2 },
    ]) {
      const parsed = lenientSchema(FinancialsSchema).parse(raw);
      const { args, missing } = normalizeArguments(parsed, FinancialsSchema);
      expect(missing).toEqual([]);
      expect(args.ticker).toBe('7203');
      expect(args.years).toBe(2);
      expect(args).not.toHaveProperty('securities_code');
      expect(args).not.toHaveProperty('ticker_or_code');
      expect(FinancialsSchema.parse(args)).toMatchObject({ ticker: '7203', years: 2 });
    }
  });

  test('a canonical argument wins over an alias', () => {
    const { args } = normalizeArguments({ ticker: '7203', name: 'ホンダ' }, FinancialsSchema);
    expect(args).toEqual({ ticker: '7203' });
  });

  test('resolve_company accepts a name for its query', () => {
    const { args, missing } = normalizeArguments({ name: 'トヨタ自動車' }, ResolveSchema);
    expect(missing).toEqual([]);
    expect(args).toEqual({ query: 'トヨタ自動車' });
  });

  test('missing required arguments are reported by their canonical names', () => {
    expect(normalizeArguments({ years: 2 }, FinancialsSchema).missing).toEqual(['ticker']);
    expect(requiredArguments(FinancialsSchema)).toEqual(['ticker']);
  });

  test('the description line names the arguments', () => {
    expect(describeArguments(FinancialsSchema)).toBe('Arguments: ticker (required), period, years.');
  });
});
