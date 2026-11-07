// IPC Fleet Handler - answers fleet state requests from the Web-UI parent.
// Same {requestId, data} echo contract as ipcMetricsHandler. getFleetState
// returns initialized:false while fleet is mid-init, so responses never
// block or crash the bot child.

import { getFleetState } from '../fleet/state';
import { getJsonReshard, getReshard } from '../fleet/shardBoot';

/** Unsolicited push, carried by the metrics 5s sample tick (no own timer). */
export function pushFleetStatus(): void {
  if (!process.send) return;
  try {
    process.send({ type: 'fleet:status', data: getFleetState() });
  } catch { /* fleet push must never take the bot down */ }
}

/** NB9 7, 15, 33 and 49: the web UI's answers about a standby go to this process's reshard driver. */
function handleReshardMessage(message: { type: string; requestId?: unknown }): void {
  void getReshard()?.onMessage(message).catch(error => console.error('[Shards] Could not handle the standby state the web UI sent:', error));
  const answer = getJsonReshard()?.onMessage(message) ?? null;
  if (message.type !== 'reshard:retire' || typeof message.requestId !== 'string' || !message.requestId) return;
  try {
    process.send!({ requestId: message.requestId, data: answer ?? { accepted: false } });
  } catch { /* the parent is gone */ }
}

export function setupFleetIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCFleetHandler] process.send not available - IPC handlers not registered');
    return;
  }

  console.log('[IPCFleetHandler] Setting up IPC handlers for fleet');

  process.on('message', (message: any) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId } = message;
    if (type === 'reshard:standby-state' || type === 'reshard:retire') {
      handleReshardMessage(message);
      return;
    }
    if (typeof type !== 'string' || !type.startsWith('fleet:') || !requestId) return;

    try {
      const response = type === 'fleet:state'
        ? { success: true, state: getFleetState() }
        : { success: false, error: `Unknown fleet IPC type: ${type}` };
      process.send!({ requestId, data: response });
    } catch (error) {
      console.error(`[IPCFleetHandler] Error handling ${type}:`, error);
      process.send!({
        requestId,
        data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  });
}
