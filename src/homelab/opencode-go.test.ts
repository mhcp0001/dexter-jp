import { describe, expect, test } from 'bun:test';
import { resolveProvider } from '../providers';
import { getFastModel } from '../model/llm';

describe('OpenCode Go provider (homelab#903)', () => {
  test('go: prefix routes to Go, even for vendor-looking names', () => {
    expect(resolveProvider('go:kimi-k3.1-pro').id).toBe('opencode-go');
    expect(resolveProvider('go:grok-4.7').id).toBe('opencode-go');
    expect(resolveProvider('go:gemini-4-argon').id).toBe('opencode-go');
    expect(resolveProvider('kimi-k3.1-pro').id).toBe('moonshot');
  });

  test('the fast model for summaries also stays on Go', () => {
    expect(getFastModel('opencode-go', 'go:x')).toBe('go:glm-5.3-flash');
  });
});
