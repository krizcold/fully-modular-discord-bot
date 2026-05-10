/**
 * Subscription Notifier - DM guild owner with channel fallback for every
 * premium-state change. Lives in the bot process (it owns the Discord
 * Client); the web-UI process reaches it via the `notification:dispatch`
 * IPC message handled in `ipcNotificationHandler.ts`.
 *
 * Skip-native: events the provider already notifies natively (Stripe
 * receipts, LS dunning, PayPal billing, Discord billing) should NOT call
 * `notify` for the corresponding type. The notifier itself doesn't know
 * about provider event sources, so callers in PremiumManager / webhook
 * handlers decide whether to fire each event.
 *
 * Best-effort delivery: DM first, then per-guild fallback channel, then
 * the guild's system channel. Each step that fails just falls through to
 * the next; if everything fails we log and move on (a missed notification
 * never blocks a state change).
 */

import { Client, TextBasedChannel } from 'discord.js';
import { getPremiumManager } from './premiumManager';

export type NotificationType =
  | 'manual.grant.added'
  | 'manual.grant.ended'
  | 'manual.grant.ending-soon'
  | 'manual.grant.revoked'
  | 'paid.sub.started'
  | 'paid.sub.paused-by-stacking'
  | 'paid.sub.resumed-from-queue'
  | 'paid.sub.cancelled-by-user'
  | 'paid.sub.renewal-failed'
  | 'paid.sub.expired'
  | 'tier.config-change-affecting-subscriber'
  | 'migration.scheduled'
  | 'migration.accepted'
  | 'migration.declined'
  | 'migration.silence-applied'
  | 'migration.applied';

export interface NotificationPayload {
  tierName?: string;
  endDate?: string | null;
  remainingDays?: number | null;
  providerName?: string;
  reason?: string;
  notes?: string;
  /** Free-form details merged into the message body. */
  details?: string;
}

let instance: SubscriptionNotifier | null = null;

export class SubscriptionNotifier {
  private client: Client | null = null;

  setClient(client: Client): void {
    this.client = client;
  }

  isReady(): boolean {
    return !!this.client;
  }

  async notify(guildId: string, type: NotificationType, payload: NotificationPayload): Promise<void> {
    if (!this.client) {
      console.warn(`[SubscriptionNotifier] notify(${type}, ${guildId}) called before client was set`);
      return;
    }
    const message = this.formatMessage(type, payload);
    if (!message) return;

    let guild;
    try {
      guild = await this.client.guilds.fetch(guildId).catch(() => null);
    } catch {
      guild = null;
    }
    if (!guild) {
      console.warn(`[SubscriptionNotifier] guild ${guildId} not reachable; cannot deliver ${type}`);
      return;
    }

    if (await this.tryDmOwner(guild, message)) return;

    const subs = getPremiumManager().getGuildSubscriptions(guildId);
    if (subs?.notificationsChannelId) {
      const ch = await this.client.channels.fetch(subs.notificationsChannelId).catch(() => null);
      if (ch && this.isWritableTextChannel(ch)) {
        if (await this.trySendChannel(ch, message)) return;
      }
    }

    if (guild.systemChannel && this.isWritableTextChannel(guild.systemChannel)) {
      if (await this.trySendChannel(guild.systemChannel, message)) return;
    }

    console.warn(`[SubscriptionNotifier] no delivery path for ${type} on guild ${guildId}; notification dropped`);
  }

  private async tryDmOwner(guild: any, message: string): Promise<boolean> {
    try {
      const owner = await guild.fetchOwner().catch(() => null);
      if (!owner) return false;
      await owner.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private async trySendChannel(channel: any, message: string): Promise<boolean> {
    try {
      await channel.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private isWritableTextChannel(channel: any): channel is TextBasedChannel {
    if (!channel) return false;
    if (typeof channel.send !== 'function') return false;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return false;
    return true;
  }

  private formatMessage(type: NotificationType, p: NotificationPayload): string {
    const tier = p.tierName || 'a tier';
    const provider = p.providerName ? ` (${p.providerName})` : '';
    const remaining = p.remainingDays != null ? ` ${p.remainingDays} day${p.remainingDays === 1 ? '' : 's'} remaining.` : '';
    const ends = p.endDate ? ` Ends ${new Date(p.endDate).toLocaleDateString()}.` : '';
    const notes = p.notes ? `\n> ${p.notes}` : '';
    const reason = p.reason ? `\nReason: ${p.reason}` : '';
    const details = p.details ? `\n${p.details}` : '';

    switch (type) {
      case 'manual.grant.added':
        return `**Premium granted:** Your server now has **${tier}**.${ends}${notes}`;
      case 'manual.grant.ending-soon':
        return `**Premium ending soon:** Your **${tier}** grant expires in 24 hours.${ends}`;
      case 'manual.grant.ended':
        return `**Premium ended:** Your **${tier}** grant has expired.${notes}`;
      case 'manual.grant.revoked':
        return `**Premium revoked:** Your **${tier}** grant was removed by an administrator.${reason}`;
      case 'paid.sub.started':
        return `**Subscription active:** **${tier}**${provider} is now active for your server.${ends}`;
      case 'paid.sub.paused-by-stacking':
        return `**Subscription paused:** Your **${tier}**${provider} subscription is queued behind a higher-tier plan and won't be billed until it resumes.${remaining}`;
      case 'paid.sub.resumed-from-queue':
        return `**Subscription resumed:** Your queued **${tier}**${provider} subscription is now active.${ends}`;
      case 'paid.sub.cancelled-by-user':
        return `**Subscription cancelled:** Your **${tier}**${provider} subscription will not auto-renew.${ends}`;
      case 'paid.sub.renewal-failed':
        return `**Renewal failed:** We couldn't charge for your **${tier}**${provider} subscription. Please update your payment method.${details}`;
      case 'paid.sub.expired':
        return `**Subscription expired:** Your **${tier}**${provider} subscription has ended.`;
      case 'tier.config-change-affecting-subscriber':
        return `**Subscription update:** The contents of your **${tier}** plan changed.${details}`;
      case 'migration.scheduled':
        return `**Plan change scheduled:** Your subscription will move to **${tier}** on ${p.endDate ? new Date(p.endDate).toLocaleDateString() : 'a future date'}. Open the subscription panel to **accept** or **decline**.${details}`;
      case 'migration.accepted':
        return `**Plan change accepted:** Confirmed - your subscription will move to **${tier}** on ${p.endDate ? new Date(p.endDate).toLocaleDateString() : 'the effective date'}.`;
      case 'migration.declined':
        return `**Plan change declined:** Your current subscription will not migrate. It will end at the next billing date and won't renew.`;
      case 'migration.silence-applied':
        return `**Plan change applied automatically:** You didn't respond before the deadline, so the host's default policy applied to your **${tier}** subscription.${details}`;
      case 'migration.applied':
        return `**Plan change complete:** Your subscription is now on **${tier}**${provider}.`;
      default:
        return '';
    }
  }
}

export function getSubscriptionNotifier(): SubscriptionNotifier {
  if (!instance) instance = new SubscriptionNotifier();
  return instance;
}
