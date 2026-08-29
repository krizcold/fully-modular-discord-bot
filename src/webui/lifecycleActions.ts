// Whole-side lifecycle actions shared by the browser fleet routes and the
// manager-facing surface (PLAN_REPLICATION 20.16), so one implementation backs
// both callers. Promote lives in promoteEngine; this is its counterpart.

import { BotManager } from './botManager';
import {
  clearRoleOverride,
  invalidateRoleOverrideCache,
  isStandalone,
  resolveEnvRole,
  resolveNodeRole,
  writeRoleOverride,
} from '../bot/internalSetup/fleet/nodeIdentity';
import { effectiveMasterUrls } from '../bot/internalSetup/fleet/fleetConfig';
import { freshMasterClaim, readSuperseded } from '../bot/internalSetup/fleet/stepDown';

export interface DemoteResult {
  success: boolean;
  needsConfirm?: boolean;
  error?: string;
}

/**
 * Demote THIS master back to co-worker (deposed/overridden master cleanup, or a
 * deliberate "under maintenance" freeze). An env co-worker only needs its
 * override cleared; an env master gets a co-worker override and must have master
 * candidates configured to dial. With no other master visible (no fresh master
 * beacon, not superseded, not parked) the demote freezes the fleet, so it answers
 * needsConfirm with the ordering warning first (PLAN_REPLICATION 20.12a).
 *
 * MUST work in all three master states, not just a healthy one: (a) fully
 * initialized; (b) parked in the boot takeover guard or the stale-master fence
 * (initFleet never returns, so fleet state stays pre-init forever - the flagship
 * old-master-returns flow lives exactly there); (c) bot child down/crash-looping.
 * For (b) and (c) the child's state is unusable (the pre-init branch hardcodes
 * role/standalone), so the prechecks run from PARENT-side truth: the same env +
 * override file the child would boot from.
 */
export async function runDemote(
  botManager: BotManager,
  confirm: boolean,
  setBy: 'webui-demote' | 'manager-demote' = 'webui-demote',
): Promise<DemoteResult> {
  try {
    // The child rewrites role-override.json when it consumes one-shot takeover
    // flags; never trust this process's cached copy for a role decision.
    invalidateRoleOverrideCache();
    const running = botManager.isRunning();
    let state: any = null;
    if (running) {
      const result = await botManager.getFleetState();
      state = result?.success ? result.state : null;
    }
    if (state && state.initialized) {
      const refusal = state.role !== 'master' ? 'this node is not a master'
        : state.standalone === true ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
        : (!Array.isArray(state.masterUrls) || state.masterUrls.length === 0)
          ? 'no master candidates configured (set MASTER_URLS first, or the demoted node would idle)'
        : null;
      if (refusal) return { success: false, error: refusal };
      const successor = state.witness ? freshMasterClaim(state.witness, state.nodeId, Date.now()) : null;
      if (!successor && !state.superseded && !readSuperseded() && !confirm) {
        return {
          success: false,
          needsConfirm: true,
          error: 'No other master is visible from this node. Demoting now freezes the fleet: workers lose their coordinator within 45s and drop their sessions, and the bot shows offline until a backup is promoted; the true database stays on this machine, untouched. Safe order to retire this machine: demote, promote the backup while this database is still reachable (zero loss), then remove the machine. Promoting after the machine is gone takes the RPO path instead.',
        };
      }
    } else if (running
      && !(state && (state.takeoverHold || state.staleMasterPark || state.emptyStoreHold))
      && !confirm) {
      // Genuine early boot with no known hold: seconds away from real state.
      // Any OTHER stall that never reaches initialization (a control store whose
      // provisioning cannot complete, say) is still escapable with an explicit
      // confirm - demote is the documented way out of a boot that cannot finish,
      // and refusing it outright leaves no way out at all.
      return {
        success: false,
        needsConfirm: true,
        error: 'The bot has not finished initializing, so its role cannot be read from the running process. If it has been stuck longer than a boot should take, demote it anyway: the next start comes up as a co-worker.',
      };
    } else {
      // Guard-held boot or a downed child: parent-side prechecks.
      const refusal = resolveNodeRole() !== 'master' ? 'this node is not a master'
        : isStandalone() ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
        : effectiveMasterUrls().urls.length === 0 ? 'no master candidates configured (set MASTER_URLS or the fleet config first, or the demoted node would idle)'
        : null;
      if (refusal) return { success: false, error: refusal };
    }
    if (resolveEnvRole() === 'co-worker') {
      clearRoleOverride();
    } else {
      writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy });
    }
    console.warn(`[Fleet] DEMOTION staged (${setBy}); restarting the bot child as co-worker`);
    const restart = await botManager.restart();
    return restart?.success
      ? { success: true }
      : { success: false, error: restart?.error ?? 'restart failed; the role change is staged and the next start boots as co-worker' };
  } catch (error) {
    console.error('[Fleet] Demotion failed:', error instanceof Error ? error.message : error);
    return { success: false, error: error instanceof Error ? error.message : 'demotion failed' };
  }
}
