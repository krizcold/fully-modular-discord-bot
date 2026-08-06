/**
 * Access-log channel (bot child side). When security.accessLog is enabled with a
 * channel id, posts a message the first time a new web-UI session or a guild OAuth
 * login is seen, with dev-only Shut-down-bot / Shut-down-web-UI buttons that signal
 * the web-UI parent. Independent of the console CLIs; inert unless configured.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, MessageFlags } from 'discord.js';
import { getConfigProperty } from './configManager';

const BTN_SHUTDOWN_BOT = 'seclog:shutdown-bot';
const BTN_STOP_WEBUI = 'seclog:stop-webui';

interface AccessLogInfo {
  uiKind?: 'admin' | 'guild';
  ip?: string;
  userAgent?: string;
  when?: number;
  user?: { id: string; username?: string };
}

function isDev(userId: string): boolean {
  const devs = getConfigProperty<(string | number)[]>('DEVS') || [];
  return Array.isArray(devs) && devs.some((d) => String(d) === String(userId));
}

async function postAccessLog(client: Client, info: AccessLogInfo): Promise<void> {
  if (getConfigProperty<boolean>('security.accessLog.enabled') !== true) return;
  const channelId = (getConfigProperty<string>('security.accessLog.channelId') || '').trim();
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return;

  const embed = new EmbedBuilder()
    .setTitle('New web-UI access')
    .setColor(0xfaa61a)
    .addFields(
      { name: 'Surface', value: info.uiKind === 'guild' ? 'Guild OAuth login' : 'Admin web-UI', inline: true },
      { name: 'IP', value: info.ip || 'unknown', inline: true },
      { name: 'When', value: info.when ? `<t:${Math.floor(info.when / 1000)}:F>` : 'now', inline: true },
      { name: 'Browser', value: (info.userAgent || 'unknown').slice(0, 300) },
    );
  if (info.user) embed.addFields({ name: 'Discord user', value: `${info.user.username || 'unknown'} (${info.user.id})` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BTN_SHUTDOWN_BOT).setStyle(ButtonStyle.Danger).setLabel('Shut down bot'),
    new ButtonBuilder().setCustomId(BTN_STOP_WEBUI).setStyle(ButtonStyle.Secondary).setLabel('Shut down web-UI'),
  );

  await (channel as { send: (opts: unknown) => Promise<unknown> }).send({ embeds: [embed], components: [row] }).catch((err: unknown) => {
    console.warn('[AccessLog] Failed to post access-log message:', err instanceof Error ? err.message : err);
  });
}

export function setupAccessLogChannel(client: Client): void {
  if (process.send) {
    process.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const m = message as { type?: string; data?: AccessLogInfo };
      if (m.type !== 'security:access-log') return;
      void postAccessLog(client, m.data || {});
    });
  }

  // Dev-only buttons: signal the web-UI parent to stop the bot or the web-UI listener.
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== BTN_SHUTDOWN_BOT && interaction.customId !== BTN_STOP_WEBUI) return;
    if (!isDev(interaction.user.id)) {
      await interaction.reply({ content: 'Only developers can use this control.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    if (interaction.customId === BTN_SHUTDOWN_BOT) {
      await interaction.reply({ content: 'Shutting down the bot...', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      process.send?.({ type: 'control:shutdown-bot' });
    } else {
      await interaction
        .reply({ content: 'Stopping the web-UI listener. Restart it with `/webui start`.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      process.send?.({ type: 'control:stop-webui' });
    }
  });
}
