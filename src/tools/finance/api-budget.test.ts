import { afterEach, describe, expect, test } from 'vitest';
import { api, requestBudgetExceededMessage, setRequestBudget } from './api.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestBudget(null);
});

describe('EDINET DB request budget', () => {
  test('stops sending requests once the budget is used', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    setRequestBudget(2);
    await api.get('/companies/E00001', {});
    await api.get('/companies/E00002', {});
    await expect(api.get('/companies/E00003', {})).rejects.toThrow(requestBudgetExceededMessage(2));
    expect(calls).toBe(2);
  });

  test('no budget means no limit', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    setRequestBudget(null);
    for (let i = 0; i < 5; i += 1) await api.get(`/companies/E0000${i}`, {});
    expect(calls).toBe(5);
  });
});
