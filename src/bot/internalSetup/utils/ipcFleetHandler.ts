// IPC Fleet Handler - answers fleet state requests from the Web-UI parent.
// Same {requestId, data} echo contract as ipcMetricsHandler. getFleetState
// returns initialized:false while fleet is mid-init, so responses never
// block or crash the bot child.

import { getFleetState } from '../fleet/state';
import {
  fleetAssignShard,
  fleetDeclareLost,
  fleetDrainNode,
  fleetMigrateAbort,
  fleetMigratePrecheck,
  fleetMigrateResume,
  fleetMigrateStart,
  fleetMigrationsList,
  fleetResumeAssignments,
  fleetSyncBump,
  fleetDevCorruptLease,
} from '../fleet/bootstrap';
import type { StartPayload } from '../fleet/migration/migrationCoordinator';

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

  process.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId } = message;
    if (typeof type !== 'string' || !type.startsWith('fleet:')) return;
    // Fire-and-forget nudge from webui write sites; no reply expected.
    if (type === 'fleet:sync:bump') {
      fleetSyncBump(String(message.data?.scope ?? ''));
      return;
    }
    if (!requestId) return;

    try {
      let response: any;
      switch (type) {
        case 'fleet:state': {
          response = { success: true, state: getFleetState() };
          break;
        }
        case 'fleet:assign': {
          const shardId = Number(message.data?.shardId);
          const nodeId = String(message.data?.nodeId ?? '');
          const result = await fleetAssignShard(shardId, nodeId);
          response = result.success ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:resumeAssignments': {
          const result = await fleetResumeAssignments();
          response = result.success ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:declareLost': {
          const nodeId = String(message.data?.nodeId ?? '');
          const result = await fleetDeclareLost(nodeId);
          response = result.success ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:drain': {
          const nodeId = String(message.data?.nodeId ?? '');
          const result = await fleetDrainNode(nodeId);
          response = result.success ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:migrate:start': {
          const result = await fleetMigrateStart(message.data as StartPayload);
          response = result.ok ? { success: true, migrationId: result.migrationId } : { success: false, error: result.error };
          break;
        }
        case 'fleet:migrate:abort': {
          const result = await fleetMigrateAbort(String(message.data?.migrationId ?? ''));
          response = result.ok ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:migrate:resume': {
          const result = await fleetMigrateResume(String(message.data?.migrationId ?? ''));
          response = result.ok ? { success: true } : { success: false, error: result.error };
          break;
        }
        case 'fleet:migrate:precheck': {
          const result = await fleetMigratePrecheck(message.data as StartPayload);
          response = result.ok ? { success: true, precheck: result } : { success: false, error: result.error };
          break;
        }
        case 'fleet:migrations': {
          response = { success: true, migrations: fleetMigrationsList() };
          break;
        }
        case 'fleet:dev:corruptLease': {
          const shardId = Number(message.data?.shardId);
          const result = fleetDevCorruptLease(shardId);
          response = result.ok ? { success: true } : { success: false, error: result.error };
          break;
        }
        default:
          response = { success: false, error: `Unknown fleet IPC type: ${type}` };
      }
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
