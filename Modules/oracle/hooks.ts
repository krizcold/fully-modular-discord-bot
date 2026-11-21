import { globalModuleDataExists, updateGlobalModuleData } from '@internal/utils/dataManager';
import { MODULE } from './oracleSave';

/** The global doc NX3's test 2 rewrites through the web UI: /data/global/oracle/shared.json. */
export const SHARED_FILE = 'shared.json';

/** Creates the shared doc as {} when it is absent, and never rewrites one that exists. */
export function onReady(): void {
  try {
    if (globalModuleDataExists(SHARED_FILE, MODULE)) return;
    const result = updateGlobalModuleData<Record<string, unknown>>(SHARED_FILE, MODULE, {}, current => current);
    if (result.outcome !== 'saved') {
      const cause = result.outcome === 'refused' ? ` (${result.cause}${result.reason ? `: ${result.reason}` : ''})` : '';
      console.error(`[Oracle] global/${MODULE}/${SHARED_FILE} was not created: the write was ${result.outcome}${cause}.`);
    }
  } catch (error) {
    console.error(`[Oracle] global/${MODULE}/${SHARED_FILE} was not created:`, error);
  }
}
