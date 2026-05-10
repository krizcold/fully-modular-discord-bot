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

import { getSubscriptionNotifier, NotificationType, NotificationPayload } from './subscriptionNotifier';

type IPCDispatcher = (guildId: string, kind: NotificationType, payload: NotificationPayload) => Promise<void>;

let ipcDispatcher: IPCDispatcher | null = null;

/**
 * Web-UI process calls this once at startup to register its IPC bridge so
 * future `dispatch` calls reach the bot. Bot process never registers.
 */
export function setNotificationIPCDispatcher(fn: IPCDispatcher): void {
  ipcDispatcher = fn;
}

/**
 * Send a notification. Returns immediately; delivery is fire-and-forget.
 * Wraps both the direct call (bot side) and the IPC call (web-UI side) in
 * try/catch so PremiumManager never sees a notification error.
 */
export async function dispatchPremiumNotification(
  guildId: string,
  kind: NotificationType,
  payload: NotificationPayload,
): Promise<void> {
  try {
    if (process.env.BOT_PROCESS_ROLE === 'bot') {
      await getSubscriptionNotifier().notify(guildId, kind, payload);
      return;
    }
    if (ipcDispatcher) {
      await ipcDispatcher(guildId, kind, payload);
      return;
    }
    // No bot process available (e.g. web-UI started before bot, or bot
    // crashed). Drop silently; admin will see the state change in the UI
    // and the user just doesn't get a DM.
  } catch (err) {
    console.warn(`[PremiumNotifications] dispatch failed for ${kind}:`, err);
  }
}
