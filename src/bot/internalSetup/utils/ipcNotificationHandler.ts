/**
 * IPC notification handler (bot side).
 *
 * The web-UI process can't DM users directly (no Discord client) but it
 * does drive most premium state changes (admin grants, paid checkout
 * completion via webhook). It dispatches notification requests via IPC
 * and this handler relays them to the bot-side `SubscriptionNotifier`.
 *
 * Message shape:
 *   { type: 'notification:dispatch', requestId, data: { guildId, kind, payload } }
 *
 * Owns the `notification:` prefix; coexists with the panel/reload/toggle
 * handlers (each looks at its own prefix and ignores the rest).
 */

import { getSubscriptionNotifier, NotificationType, NotificationPayload } from './subscriptionNotifier';

export function setupIPCNotificationHandler(): void {
  if (process.env.BOT_PROCESS_ROLE !== 'bot') {
    return;
  }
  if (typeof process.send !== 'function') {
    return;
  }

  process.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message;
    if (typeof type !== 'string') return;
    if (!type.startsWith('notification:')) return;
    if (typeof requestId !== 'string') return;

    try {
      switch (type) {
        case 'notification:dispatch': {
          const guildId = data?.guildId;
          const kind = data?.kind as NotificationType | undefined;
          const payload = (data?.payload || {}) as NotificationPayload;
          if (!guildId || !kind) {
            process.send!({ requestId, data: { success: false, error: 'guildId and kind are required' } });
            return;
          }
          await getSubscriptionNotifier().notify(guildId, kind, payload);
          process.send!({ requestId, data: { success: true } });
          return;
        }
        default:
          process.send!({ requestId, data: { success: false, error: `unknown type ${type}` } });
      }
    } catch (err: any) {
      console.error(`[IPCNotificationHandler] error handling ${type}:`, err);
      process.send!({ requestId, data: { success: false, error: err?.message || 'unknown error' } });
    }
  });
}
