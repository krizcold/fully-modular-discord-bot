// IPC Fleet Handler - answers fleet state requests from the Web-UI parent.
// Same {requestId, data} echo contract as ipcMetricsHandler. getFleetState
// returns initialized:false while fleet is mid-init, so responses never
// block or crash the bot child.

import { getFleetState } from '../fleet/state';

/** Unsolicited push, carried by the metrics 5s sample tick (no own timer). */
export function pushFleetStatus(): void {
  if (!process.send) return;
  try {
    process.send({ type: 'fleet:status', data: getFleetState() });
  } catch { /* fleet push must never take the bot down */ }
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
