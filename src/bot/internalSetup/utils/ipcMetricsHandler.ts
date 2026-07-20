// IPC Metrics Handler - answers metrics requests from the Web-UI parent.
// Same {requestId, data} echo contract as ipcPanelHandler. When metrics are
// disabled it responds with an EMPTY snapshot (never silence) so the webui's
// sendIPCMessage cannot time out.

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

    const collector = getMetricsCollector();
    try {
      let response: any;
      switch (type) {
        case 'metrics:global': {
          const snapshot = collector.getGlobalSnapshot();
          annotateHeavyLoad(snapshot.leaderboard);
          response = { success: true, snapshot };
          break;
        }
        case 'metrics:guild': {
          const guildId = data?.guildId;
          if (!guildId || typeof guildId !== 'string') {
            response = { success: false, error: 'guildId is required' };
          } else {
            response = { success: true, snapshot: collector.getGuildSnapshot(guildId) };
          }
          break;
        }
        case 'metrics:leaderboard': {
          response = { success: true, leaderboard: annotateHeavyLoad(collector.getLeaderboard()) };
          break;
        }
        case 'metrics:reset': {
          collector.reset();
          response = { success: true };
          break;
        }
        default:
          response = { success: false, error: `Unknown metrics IPC type: ${type}` };
      }
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
