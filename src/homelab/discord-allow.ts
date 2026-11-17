/**
 * Discord sender allowlist (mhcp0001/homelab-infrastructure#850, #906 N-2).
 * DISCORD_ALLOWED_USER_IDS: comma-separated Discord user ids.
 * - unset or empty: everyone (upstream behaviour)
 * - set but with no valid id: nobody (fail closed: a typo must not open the bot to everyone)
 * The models are used under personal plans (OpenCode Go, Claude), so the homelab sets it.
 */
export function discordAllowedUsers(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = (env.DISCORD_ALLOWED_USER_IDS ?? '').trim();
  if (raw === '') return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)));
}

export function isDiscordSenderAllowed(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = discordAllowedUsers(env);
  return allowed === null || allowed.has(userId);
}
