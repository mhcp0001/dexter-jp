import { expect, test } from 'bun:test';
import { discordAllowedUsers, isDiscordSenderAllowed } from './discord-allow';

test('Discord sender allowlist (homelab#850)', () => {
  expect(discordAllowedUsers({})).toBeNull();
  expect(isDiscordSenderAllowed('1', {})).toBe(true);
  const env = { DISCORD_ALLOWED_USER_IDS: ' 422159910503972874 , 99, bad ' } as NodeJS.ProcessEnv;
  expect([...discordAllowedUsers(env)!].sort()).toEqual(['422159910503972874', '99']);
  expect(isDiscordSenderAllowed('422159910503972874', env)).toBe(true);
  expect(isDiscordSenderAllowed('1234', env)).toBe(false);
  // set but nothing valid: nobody
  expect(isDiscordSenderAllowed('422159910503972874', { DISCORD_ALLOWED_USER_IDS: 'owner' } as NodeJS.ProcessEnv)).toBe(false);
  expect(isDiscordSenderAllowed('1', { DISCORD_ALLOWED_USER_IDS: ' , ' } as NodeJS.ProcessEnv)).toBe(false);
});
