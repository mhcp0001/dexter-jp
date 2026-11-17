import type { ChannelPlugin, ChannelStartContext } from '../types.js';
import type { InboundMessage } from '../../types.js';
import type { GatewayConfig } from '../../config.js';
import { logger } from '../../../utils/logger.js';
import { isDiscordSenderAllowed } from '../../../homelab/discord-allow.js';

type DiscordAccountConfig = {
  enabled: boolean;
};

// --- Per-user rate limiting ---
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = parseInt(process.env.DISCORD_RATE_LIMIT_PER_HOUR || '10', 10);
const userRequestTimestamps = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = userRequestTimestamps.get(userId) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  userRequestTimestamps.set(userId, recent);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  return false;
}

function getRemainingQuota(userId: string): number {
  const now = Date.now();
  const timestamps = userRequestTimestamps.get(userId) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  return Math.max(0, RATE_LIMIT_MAX - recent.length);
}

type DiscordPluginParams = {
  loadConfig: () => GatewayConfig;
  onMessage: (inbound: InboundMessage) => Promise<void>;
};

/**
 * Create a Discord channel plugin using discord.js Gateway (WebSocket).
 * Requires: DISCORD_BOT_TOKEN environment variable.
 */
export function createDiscordPlugin(params: DiscordPluginParams): ChannelPlugin<GatewayConfig, DiscordAccountConfig> {
  return {
    id: 'discord',
    config: {
      listAccountIds: () => {
        return process.env.DISCORD_BOT_TOKEN ? ['default'] : [];
      },
      resolveAccount: () => ({ enabled: true }),
      isEnabled: (account) => account.enabled,
      isConfigured: () => Boolean(process.env.DISCORD_BOT_TOKEN),
    },
    gateway: {
      startAccount: async (ctx: ChannelStartContext<DiscordAccountConfig>) => {
        const { Client, GatewayIntentBits, Partials } = await import('discord.js');

        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
          ],
          // Partials needed to receive DMs properly
          partials: [Partials.Channel, Partials.Message],
        });

        let botUserId: string | undefined;

        client.on('ready', () => {
          botUserId = client.user?.id;
          ctx.setStatus({ connected: true });
          logger.info(`[Discord] Connected as ${client.user?.tag}`);
        });

        client.on('messageCreate', async (message) => {
          if (ctx.abortSignal.aborted) return;
          // Skip bot messages
          if (message.author.bot) return;

          const isDm = !message.guild;
          // Check both user @mentions and role @mentions (Discord shows role mention when clicking bot name)
          const isMentioned = message.mentions.has(client.user!) ||
            message.mentions.roles.some(role => role.name === client.user?.username) ||
            message.content.includes(`<@${botUserId}>`) ||
            message.content.includes(`<@!${botUserId}>`);

          // In servers, only respond to @mentions; in DMs, always respond
          if (!isDm && !isMentioned) return;

          // Only the allowed senders (homelab#850). Others are ignored without a reply.
          if (!isDiscordSenderAllowed(message.author.id)) {
            logger.info(`[Discord] ignored a message from a sender not on DISCORD_ALLOWED_USER_IDS (${message.author.id})`);
            return;
          }

          // Strip bot mention and role mentions from message text
          let body = message.content;
          if (botUserId) {
            body = body.replace(new RegExp(`<@!?${botUserId}>\\s*`, 'g'), '').trim();
          }
          // Also strip role mentions that match the bot's name
          body = body.replace(/<@&\d+>\s*/g, '').trim();
          if (!body) return;

          // Ignore messages older than 30 seconds (stale from rev transition)
          const messageAge = Date.now() - message.createdTimestamp;
          if (messageAge > 30000) return;

          // Rate limiting
          if (isRateLimited(message.author.id)) {
            const remaining = getRemainingQuota(message.author.id);
            await message.reply(
              `⏳ レート制限中です。1時間あたり${RATE_LIMIT_MAX}回まで利用できます（残り${remaining}回）。しばらくお待ちください。\n` +
              `Rate limited. You can send up to ${RATE_LIMIT_MAX} messages per hour. Please wait.`
            );
            return;
          }

          const inbound: InboundMessage = {
            channel: 'discord',
            accountId: ctx.accountId,
            senderId: message.author.id,
            senderName: message.author.displayName || message.author.username,
            chatId: message.channelId,
            replyTo: message.channelId,
            chatType: isDm ? 'direct' : 'group',
            body,
            messageId: message.id,
            timestamp: message.createdTimestamp,
            groupSubject: message.guild?.name,
            selfId: botUserId,
            mentionedIds: isMentioned && botUserId
              ? [...new Set([...message.mentions.users.map(u => u.id), botUserId])]
              : message.mentions.users.map(u => u.id),
            sendComposing: async () => {
              await message.channel.sendTyping();
            },
            reply: async (text: string) => {
              const chunks = splitMessage(text, 2000);
              if (!isDm && message.channel.isTextBased() && 'threads' in message.channel) {
                // In servers, reply in a thread to keep the channel clean
                const thread = message.thread ?? await message.startThread({
                  name: `${message.author.displayName || message.author.username}の質問`,
                  autoArchiveDuration: 60,
                });
                for (const chunk of chunks) {
                  await thread.send(chunk);
                }
              } else {
                // In DMs, reply directly
                for (const chunk of chunks) {
                  await message.reply(chunk);
                }
              }
            },
            send: async (text: string) => {
              const chunks = splitMessage(text, 2000);
              for (const chunk of chunks) {
                await message.channel.send(chunk);
              }
            },
          };

          await params.onMessage(inbound);
        });

        await client.login(process.env.DISCORD_BOT_TOKEN!);

        // Keep alive until abort
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => {
            client.destroy();
            resolve();
          });
        });
      },
    },
  };
}

/** Split a message into chunks that fit Discord's 2000 char limit. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}
