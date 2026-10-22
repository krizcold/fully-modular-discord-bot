// IPC Metrics Handler - answers metrics requests from the Web-UI parent.
// Same {requestId, data} echo contract as ipcPanelHandler. When metrics are
// disabled it responds with an EMPTY snapshot (never silence) so the webui's
// sendIPCMessage cannot time out. Registered before the fleet boot, it answers
// 'not ready' until the client is up (markMetricsReady).

import { getMetricsCollector } from './metrics/metricsCollector';
import { getModuleRegistry } from './moduleRegistry';

function annotateHeavyLoad(leaderboard: any): any {
  if (!leaderboard || !Array.isArray(leaderboard.modules)) return leaderboard;
  let registry: any = null;
  try {
    registry = getModuleRegistry();
  } catch { /* registry unavailable; skip badges */ }
  if (!registry) return leaderboard;
  for (const row of leaderboard.modules) {
    row.heavyLoad = registry.getModule(row.module)?.manifest?.heavyLoad === true;
  }
  return leaderboard;
}

let ready = false;

export function markMetricsReady(): void {
  ready = true;
}

export function answerMetricsRequest(type: string, data: any): any {
  if (!ready) return { success: false, error: 'metrics are not available until the fleet boot completes' };
  const collector = getMetricsCollector();
  switch (type) {
    case 'metrics:global': {
      const snapshot = collector.getGlobalSnapshot();
      annotateHeavyLoad(snapshot.leaderboard);
      return { success: true, snapshot };
    }
    case 'metrics:guild': {
      const guildId = data?.guildId;
      if (!guildId || typeof guildId !== 'string') return { success: false, error: 'guildId is required' };
      return { success: true, snapshot: collector.getGuildSnapshot(guildId) };
    }
    case 'metrics:leaderboard':
      return { success: true, leaderboard: annotateHeavyLoad(collector.getLeaderboard()) };
    case 'metrics:reset':
      collector.reset();
      return { success: true };
    default:
      return { success: false, error: `Unknown metrics IPC type: ${type}` };
  }
}

export function setupMetricsIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCMetricsHandler] process.send not available - IPC handlers not registered');
    return;
  }

  console.log('[IPCMetricsHandler] Setting up IPC handlers for metrics');

  process.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message;
    if (typeof type !== 'string' || !type.startsWith('metrics:') || !requestId) return;

    try {
      const response = answerMetricsRequest(type, data);
      process.send!({ requestId, data: response });
    } catch (error) {
      console.error(`[IPCMetricsHandler] Error handling ${type}:`, error);
      process.send!({
        requestId,
        data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  });
}
