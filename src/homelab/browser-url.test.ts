import { expect, test } from 'bun:test';
import { isWebUrl } from '../tools/browser/browser';

test('browser opens only http and https (homelab#906 C-1)', () => {
  expect(isWebUrl('https://example.com/a')).toBe(true);
  expect(isWebUrl('http://example.com')).toBe(true);
  for (const bad of ['file:///opt/dexter-jp/.env', 'FILE:///etc/passwd', 'data:text/html,x', 'chrome://version', 'view-source:https://x.com', 'javascript:alert(1)', '/opt/dexter-jp/.env', '']) {
    expect(isWebUrl(bad)).toBe(false);
  }
});
