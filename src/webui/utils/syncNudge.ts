// Fire-and-forget sync bump from webui write sites. The bot child's fleet
// layer no-ops it on co-workers and standalone; the master's 15s backstop
// covers any site that is not instrumented.

import type { BotManager } from '../botManager';

let manager: BotManager | null = null;

export function initSyncNudge(botManager: BotManager): void {
  manager = botManager;
}

export function nudgeSync(scope: string): void {
  manager?.notifySyncMutation(scope);
}
