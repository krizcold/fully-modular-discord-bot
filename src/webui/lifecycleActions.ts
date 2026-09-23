// Whole-side lifecycle actions shared by the browser fleet routes and the
// manager-facing surface (PLAN_REPLICATION 20.16), so one implementation backs
// both callers. Promote lives in promoteEngine; this is its counterpart.

import { BotManager } from './botManager';
import { clearRoleOverride, consentsToActiveMode, getNodeId, getNodeName, invalidateRoleOverrideCache, isBackupMaster, isStandalone, resolveEnvRole, resolveNodeRole, writeRoleOverride } from '../bot/internalSetup/fleet/nodeIdentity';
import { effectiveMasterUrls } from '../bot/internalSetup/fleet/fleetConfig';
import { isContainerPinned, loadCredentials, removeCredentials } from '../utils/envLoader';
import { freshMasterClaim, readSuperseded } from '../bot/internalSetup/fleet/stepDown';
import { readArmRecord } from '../bot/internalSetup/fleet/armRecord';
import { closeStandInLane } from '../bot/internalSetup/fleet/episodeRecord';
import { clearModeOverride, ModeOverride, readModeOverride, writeModeOverride } from '../bot/internalSetup/fleet/modeOverride';

export interface ModeOverrideResult {
  success: boolean;
  error?: string;
  override: ModeOverride | null;
}

/**
 * The emergency lever (B6-k): enable active mode locally for the outage. Refused
 * on a node that is not the designated backup master, and on one that does not
 * consent: the lever supplies the master's key only, never the node's own.
 */
export function setModeOverride(setBy: string): ModeOverrideResult {
  if (!isBackupMaster()) {
    return { success: false, error: 'This node is not the designated backup master (BOT_NODE_ROLE); only a backup master can stand in.', override: readModeOverride() };
  }
  if (!consentsToActiveMode()) {
    return { success: false, error: 'This node does not consent to active mode: set FLEET_BACKUP_MODE=active in its env (the manager\'s Backup Mode row) and restart it first; the lever supplies only the master\'s key.', override: readModeOverride() };
  }
  try {
    return { success: true, override: writeModeOverride(setBy) };
  } catch (err) {
    return { success: false, error: `The local enable could not be written: ${err instanceof Error ? err.message : String(err)}`, override: readModeOverride() };
  }
}

export function unsetModeOverride(): ModeOverrideResult {
  let failure: string | null = null;
  try {
    clearModeOverride();
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  // What the arm tick will read decides the answer, not the unlink's verdict.
  const left = readModeOverride();
  if (left) return { success: false, error: `The local enable could not be cleared and is still in effect${failure ? `: ${failure}` : '.'}`, override: left };
  if (failure) return { success: false, error: `The clear failed, but no local enable is readable any more: ${failure}`, override: null };
  return { success: true, override: null };
}

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
      // A follower hold runs the co-worker runtime under a master identity
      // (B6 map F28): the boot enters it from the master path alone, so the
      // hold IS that identity whatever the override file says now (a demote
      // whose restart failed has already written co-worker; a designated
      // backup's staged takeover may have been cleared by a Cancel). Demote
      // is the hold's exit.
      const identityRole = state.followerHold ? 'master' : state.role;
      const refusal = identityRole !== 'master' ? 'this node is not a master'
        : state.standalone === true ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
        : (!Array.isArray(state.masterUrls) || state.masterUrls.length === 0)
          ? 'no master candidates configured (set MASTER_URLS first, or the demoted node would idle)'
        : null;
      if (refusal) return { success: false, error: refusal };
      const successor = state.witness ? freshMasterClaim(state.witness, state.nodeId, Date.now()) : null;
      // A follower hold is a visible holder too: the node it follows is the
      // coordinator, and this node coordinates nobody, so its demote freezes
      // nothing.
      if (!successor && !state.followerHold && !state.superseded && !readSuperseded() && !confirm) {
        return {
          success: false,
          needsConfirm: true,
          error: 'No other master is visible from this node. Demoting now freezes the fleet: workers lose their coordinator within 45s and drop their sessions, and the bot shows offline until a backup is promoted; the true database stays on this machine, untouched. Safe order to retire this machine: demote, promote the backup while this database is still reachable (zero loss), then remove the machine. Promoting after the machine is gone takes the RPO path instead. Demote anyway (the fleet stays under maintenance until a backup is promoted)?',
        };
      }
      // A hold that has never known its holder: demoting spends this node's
      // master identity, and with it the FLEET_CONFIRM_TAKEOVER route the hold
      // banner names for a holder gone for good (only a master boot reads it).
      if (state.followerHold && state.followerHold.namesThisNode !== true && state.masterKnown !== true && !confirm) {
        return {
          success: false,
          needsConfirm: true,
          error: `This node holds as a follower but has not registered with the node it follows, so nothing is known of that node yet. Demoting spends this node's master identity: it rejoins as a co-worker once a master answers${state.followerHold.reason === 'behind' ? ', and the FLEET_CONFIRM_TAKEOVER route back onto this database closes with it (a master boot is what reads that confirm)' : ', and with it the failback that would promote this copy back; nothing on this database can be seized while it is a copy'}. Demote anyway?`,
        };
      }
    } else if (running
      && !(state && (state.takeoverHold || state.staleMasterPark || state.readOnlyStorePark || state.followerHold || state.emptyStoreHold || (state.standIn?.live && state.standIn.writeGate)))
      && !confirm) {
      // Genuine early boot with no known hold: seconds away from real state.
      // Any OTHER stall that never reaches initialization (a control store whose
      // provisioning cannot complete, say) is still escapable with an explicit
      // confirm - demote is the documented way out of a boot that cannot finish,
      // and refusing it outright leaves no way out at all.
      return {
        success: false,
        needsConfirm: true,
        error: 'The bot has not finished initializing, so its role cannot be read from the running process. If it has been stuck longer than a boot should take, demote it anyway: the next start comes up as a co-worker. Demote anyway?',
      };
    } else {
      // Guard-held boot or a downed child: parent-side prechecks. A child
      // reporting a master-path hold IS on the master path by construction,
      // whatever the override file resolves to now: a designated backup whose
      // only master identity was a staged takeover that a Cancel has since
      // cleared still needs the demote as the park's exit.
      const heldMasterBoot = !!(state && (state.takeoverHold || state.staleMasterPark || state.readOnlyStorePark || state.followerHold || state.emptyStoreHold));
      const refusal = !heldMasterBoot && resolveNodeRole() !== 'master' ? 'this node is not a master'
        : isStandalone() ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
        : effectiveMasterUrls().urls.length === 0 ? 'no master candidates configured (set MASTER_URLS or the fleet config first, or the demoted node would idle)'
        : null;
      if (refusal) return { success: false, error: refusal };
    }
    // Demote is one of F9's two ruled exits from standing in, so the lane's
    // record ends here too. Left live, a parked write step's Continue would
    // later restore the stand-in override over this demotion.
    const arm = readArmRecord();
    if (arm && arm.phase !== 'disarmed') {
      closeStandInLane(arm, getNodeId(), getNodeName(), null, 'demoted', `demoted by the operator (${setBy})`, `demoted by the operator (${setBy})`);
    }
    if (resolveEnvRole() === 'co-worker') {
      clearRoleOverride();
    } else {
      writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy });
    }
    console.warn(`[Fleet] DEMOTION staged (${setBy}); restarting the bot child as co-worker`);
    // Retried the way the promote engine restarts: the record and the override
    // are already written, and a child left running past a failed restart
    // would keep serving as a stand-in whose own record says the lane ended.
    let restart = await botManager.restart();
    for (let attempt = 0; !restart?.success && restart?.reason === 'operation_in_progress' && attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      restart = await botManager.restart();
    }
    return restart?.success
      ? { success: true }
      : { success: false, error: restart?.error ?? 'restart failed; the role change is staged and the next start boots as co-worker' };
  } catch (error) {
    console.error('[Fleet] Demotion failed:', error instanceof Error ? error.message : error);
    return { success: false, error: error instanceof Error ? error.message : 'demotion failed' };
  }
}

/**
 * Return this node to its configured role and store (the manager's hook after
 * the recovery channel's swap moved the primary by infrastructure means): the
 * role override goes, so BOT_NODE_ROLE rules the next boot, and the store forms
 * a follower's delivery or a promote persisted into /data/.env go wherever the
 * container environment pins their replacement, so the node boots on and
 * delivers the database that environment names rather than the one it last
 * followed. The local form is derived from the pinned URL at backend boot, so
 * it goes with the URL; a public or control-store form the environment does
 * not pin stays, being this node's only copy of it. Where the environment
 * pins no database URL every form stays, being this node's only store
 * configuration; the override is cleared all the same and the next delivery
 * replaces the forms. restart false leaves the child alone for a caller
 * about to stop it.
 */
export async function runRoleReset(botManager: BotManager, restart: boolean): Promise<{ success: boolean; formsCleared?: boolean; error?: string }> {
  try {
    // Seeds process.env from the file for keys compose left unset, which is
    // exactly what isContainerPinned tells apart from a genuine pin.
    loadCredentials();
    clearRoleOverride();
    invalidateRoleOverrideCache();
    // A container that pins no database URL has the persisted forms as its
    // only store configuration: they stay, and the next delivery replaces
    // them once the node follows a master again.
    const pinned = isContainerPinned('DATA_BACKEND_URL');
    if (pinned) {
      const keys = ['DATA_BACKEND_URL', 'DATA_BACKEND_LOCAL_URL']
        .concat(isContainerPinned('DATA_BACKEND_PUBLIC_URL') ? ['DATA_BACKEND_PUBLIC_URL'] : [])
        .concat(isContainerPinned('CONTROL_STORE_URL') ? ['CONTROL_STORE_URL'] : []);
      const cleared = removeCredentials(keys);
      if (!cleared.success) return { success: false, error: `the role override is cleared but the persisted store forms are not: ${cleared.error}` };
    }
    console.warn(`[Fleet] ROLE RESET (manager): the role override is cleared and the persisted store forms are ${pinned ? 'cleared; the next boot follows BOT_NODE_ROLE and the container environment' : 'kept (the container environment pins no database URL); the next boot follows BOT_NODE_ROLE'}${restart ? '; restarting the bot child' : ''}`);
    if (!restart) return { success: true, formsCleared: pinned };
    let result = await botManager.restart();
    for (let attempt = 0; !result?.success && result?.reason === 'operation_in_progress' && attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      result = await botManager.restart();
    }
    return result?.success
      ? { success: true, formsCleared: pinned }
      : { success: false, error: result?.error ?? 'restart failed; the reset is written and the next start applies it' };
  } catch (error) {
    console.error('[Fleet] Role reset failed:', error instanceof Error ? error.message : error);
    return { success: false, error: error instanceof Error ? error.message : 'role reset failed' };
  }
}
