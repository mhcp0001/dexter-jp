/**
 * Discord sender allowlist (mhcp0001/homelab-infrastructure#850, #906 N-2).
 * DISCORD_ALLOWED_USER_IDS: comma-separated Discord user ids. Unset or empty = everyone (upstream
 * behaviour). The models are used under personal plans (OpenCode Go, Claude), so the homelab sets it.
 */
export function discordAllowedUsers(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const ids = (env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  return ids.length > 0 ? new Set(ids) : null;
}

export function isDiscordSenderAllowed(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = discordAllowedUsers(env);
  return allowed === null || allowed.has(userId);
}
