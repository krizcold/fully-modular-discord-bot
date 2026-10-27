/**
 * Premium notifications dispatch wrapper.
 *
 * PremiumManager runs in both the bot process and the forked web-UI process
 * (each has its own in-memory state, synced via mtime-checked file reload).
 * Notifications need the Discord client which only the bot has, so this
 * thin wrapper routes by process role:
 *
 *   - Bot process: calls SubscriptionNotifier directly.
 *   - Web-UI process: hands the request to a registered IPC dispatcher
 *     (BotManager.dispatchNotification). The web-UI registers its
 *     dispatcher at startup; PremiumManager just calls `dispatch(...)`
 *     and forgets which side it's on.
 *
 * Best-effort: failures are swallowed and logged. A missed notification
 * must never block the state change that triggered it.
 */

import { getSubscriptionNotifier, NotificationType, NotificationPayload, NotifyOutcome } from './subscriptionNotifier';

type IPCDispatcher = (guildId: string, kind: NotificationType, payload: NotificationPayload) => Promise<NotifyOutcome>;

let ipcDispatcher: IPCDispatcher | null = null;

/**
 * Web-UI process calls this once at startup to register its IPC bridge so
 * future `dispatch` calls reach the bot. Bot process never registers.
 */
export function setNotificationIPCDispatcher(fn: IPCDispatcher): void {
  ipcDispatcher = fn;
}

/**
 * Send a notification and resolve with what really happened to it. Never
 * throws, so PremiumManager never sees a notification error.
 */
export async function dispatchPremiumNotification(
  guildId: string,
  kind: NotificationType,
  payload: NotificationPayload,
): Promise<NotifyOutcome> {
  try {
    if (process.env.BOT_PROCESS_ROLE === 'bot') {
      return await getSubscriptionNotifier().notify(guildId, kind, payload);
    }
    if (ipcDispatcher) {
      return await ipcDispatcher(guildId, kind, payload);
    }
    console.warn(`[PremiumNotifications] ${kind} for guild ${guildId} dropped: no bot process to deliver it`);
    return { delivered: false, cause: 'no bot process to deliver it' };
  } catch (err) {
    console.warn(`[PremiumNotifications] dispatch failed for ${kind}:`, err);
    return { delivered: false, cause: err instanceof Error ? err.message : String(err) };
  }
}
