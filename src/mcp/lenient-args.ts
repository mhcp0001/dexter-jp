/**
 * Small models guess argument names (securities_code, ticker_or_code, name) and send numbers
 * as strings. Accept those slips at the MCP boundary instead of failing the call and paying
 * for another model step; the wrapped LangChain tool still validates the normalized input.
 */
import { z } from 'zod';

/** Names models use instead of the canonical one, in the order they are tried. */
export const ARGUMENT_ALIASES: Record<string, readonly string[]> = {
  ticker: ['securities_code', 'ticker_or_code', 'code', 'name', 'company', 'company_name'],
  query: ['name', 'company', 'company_name', 'ticker', 'securities_code'],
};

function unwrapOptional(field: z.ZodType): { inner: z.ZodType; optional: boolean } {
  return field instanceof z.ZodOptional
    ? { inner: field.unwrap() as z.ZodType, optional: true }
    : { inner: field, optional: false };
}

/**
 * Same fields as `schema`, but numbers are coerced from strings, aliased fields become optional
 * (their presence is checked after normalizing), and unknown keys are kept for normalizeArguments.
 */
export function lenientSchema(schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const { inner, optional } = unwrapOptional(field as z.ZodType);
    let lenient: z.ZodType = inner instanceof z.ZodNumber ? z.coerce.number() : inner;
    if (inner.description) lenient = lenient.describe(inner.description);
    shape[key] = optional || key in ARGUMENT_ALIASES ? lenient.optional() : lenient;
  }
  return z.object(shape).loose();
}

/** Required argument names of `schema`, e.g. ["ticker"]. */
export function requiredArguments(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !(field instanceof z.ZodOptional))
    .map(([key]) => key);
}

/** One line for the tool description, so the model sees the exact names up front. */
export function describeArguments(schema: z.ZodObject<z.ZodRawShape>): string {
  const required = new Set(requiredArguments(schema));
  const names = Object.keys(schema.shape).map((key) => (required.has(key) ? `${key} (required)` : key));
  return `Arguments: ${names.join(', ')}.`;
}

/**
 * Fill the tool's canonical argument names from their aliases and drop the aliases.
 * Returns the required names still missing, so the caller can answer with a clear error.
 */
export function normalizeArguments(
  args: Record<string, unknown>,
  schema: z.ZodObject<z.ZodRawShape>,
): { args: Record<string, unknown>; missing: string[] } {
  const out: Record<string, unknown> = { ...args };
  for (const canonical of Object.keys(schema.shape)) {
    const aliases = ARGUMENT_ALIASES[canonical];
    if (!aliases) continue;
    if (out[canonical] === undefined || out[canonical] === '') {
      const alias = aliases.find((name) => typeof out[name] === 'string' || typeof out[name] === 'number');
      if (alias) out[canonical] = String(out[alias]);
    }
    for (const alias of aliases) {
      if (!(alias in schema.shape)) delete out[alias];
    }
  }
  const missing = requiredArguments(schema).filter((name) => out[name] === undefined || out[name] === '');
  return { args: out, missing };
}
