// Restart recovery: validates the persisted plan against the freshly
// acquired term and the shardCount policy, and synthesizes node stubs when
// registry.json is missing or stale. Standalone never reads the store, so a
// zero-fleet-env boot stays byte-identical to today.

import type { ControlStore, PersistedNode, PersistedPlan, ReshardMarker } from './controlStore';
import { isReshardConfirmed } from './placement';

export interface RecoveryOptions {
  newTerm: number;
  resolvedShardCount: number;
  /** Discord's /gateway/bot recommendation from a SUCCESSFUL live fetch; null when unreachable (never advise off a fallback). */
  liveRecommendation: number | null;
  override: number | null;
  standalone: boolean;
}

export interface RecoveryResult {
  /** True on recovery boots (a valid prior plan existed); gates the hold-down window. */
  recovered: boolean;
  /** Present when a plan was adopted; a confirmed reshard adopts the empty new-count plan it just wrote. */
  plan?: PersistedPlan;
  /** One stub per plan assignment, from registry.json where available, synthesized otherwise. */
  nodes?: PersistedNode[];
  reshardApplied?: { from: number; to: number; source: 'override' };
  reshardAdvised?: { running: number; recommended: number };
  /** Override mismatch without FLEET_CONFIRM_RESHARD: the plan was adopted unchanged, the change awaits confirmation. */
  reshardNeedsConfirm?: { from: number; to: number };
  /**
   * Reshard pause: present while reshard-pending.json exists; the boot must
   * not assign any shard until resumed. Fields are null when the marker is
   * corrupt or malformed (the pause fails CLOSED; Resume still clears it).
   */
  reshardPaused?: { from: number | null; to: number | null; archivedAt: number | null };
}

export async function evaluateRecovery(store: ControlStore, opts: RecoveryOptions): Promise<RecoveryResult> {
  if (opts.standalone) return { recovered: false };

  // The pause marker drives the pause, not the env (edge 20): ANY boot that
  // finds it re-enters the pause, including virgin boots off a corrupt plan.
  // Fail CLOSED: an unreadable or malformed marker still pauses (unknown
  // fields surface as null); only a missing file means no pause.
  const marker = await store.loadReshardMarker();
  let paused: NonNullable<RecoveryResult['reshardPaused']> | null = null;
  if (marker === 'corrupt') {
    console.error('[Fleet] reshard-pending.json is unreadable; treating the boot as PAUSED (fail closed); Resume clears it');
    paused = { from: null, to: null, archivedAt: null };
  } else if (marker) {
    if (!Number.isInteger(marker.from) || !Number.isInteger(marker.to)) {
      console.error('[Fleet] reshard-pending.json is malformed; treating the boot as PAUSED (fail closed); Resume clears it');
    }
    paused = {
      from: Number.isInteger(marker.from) ? marker.from : null,
      to: Number.isInteger(marker.to) ? marker.to : null,
      archivedAt: Number.isFinite(marker.at) ? marker.at : null,
    };
  }

  const plan = await store.loadPlan();
  if (!plan) {
    const result: RecoveryResult = { recovered: false };
    if (paused) result.reshardPaused = paused;
    return result;
  }

  const invalid = validatePlan(plan, opts.newTerm);
  if (invalid) {
    console.error(`[Fleet] Persisted plan DISCARDED (${invalid}); starting virgin`);
    const result: RecoveryResult = { recovered: false };
    if (paused) result.reshardPaused = paused;
    return result;
  }

  if (opts.override !== null && opts.override !== plan.shardCount) {
    if (!isReshardConfirmed()) {
      // Unconfirmed count change: adopt the old count (zero downtime); an
      // unconfirmed change can never wipe or remap anything.
      const result = await adoptPlan(store, plan);
      result.reshardNeedsConfirm = { from: plan.shardCount, to: opts.override };
      if (paused) result.reshardPaused = paused;
      console.warn(`[Fleet] FLEET_SHARD_COUNT ${opts.override} != persisted ${plan.shardCount} without FLEET_CONFIRM_RESHARD; keeping ${plan.shardCount} shard(s); set FLEET_CONFIRM_RESHARD=1 and restart to apply`);
      return result;
    }
    const usableMarker = marker !== 'corrupt' && marker
      && Number.isInteger(marker.from) && Number.isInteger(marker.to)
      && Number.isFinite(marker.at) && typeof marker.archiveFile === 'string'
      ? marker
      : null;
    return confirmedReshard(store, plan, opts.override, opts.newTerm, usableMarker);
  }

  const result = await adoptPlan(store, plan);
  if (paused) result.reshardPaused = paused;
  if (opts.liveRecommendation !== null && opts.liveRecommendation !== plan.shardCount) {
    // DECISION-1: adopt the persisted shardCount even when Discord's live
    // recommendation differs; the guild -> shard formula binds ownership to
    // shard ids, so an advisory change must never re-scramble owned guilds.
    result.reshardAdvised = { running: plan.shardCount, recommended: opts.liveRecommendation };
    console.warn(`[Fleet] Discord now recommends ${opts.liveRecommendation} shard(s); fleet continues at ${plan.shardCount}; reshard requires setting FLEET_SHARD_COUNT`);
  }
  return result;
}

async function adoptPlan(store: ControlStore, plan: PersistedPlan): Promise<RecoveryResult> {
  const persisted = (await store.loadRegistry()).nodes;
  const byId = new Map(persisted.map(n => [n.nodeId, n]));
  const nodes: PersistedNode[] = plan.assignments.map(a =>
    byId.get(a.nodeId) ?? {
      nodeId: a.nodeId,
      nodeName: a.nodeId,
      appVersion: '',
      capabilities: { shardCapacity: 1, dataBackend: 'file' },
      lastSeenAt: 0,
    },
  );
  return { recovered: true, plan, nodes };
}

// Confirmed reshard: ownership records are NEVER discarded, only archived.
// Write order is load-bearing: archive -> MARKER -> empty plan. A crash after
// the marker leaves old plan + marker (the override still mismatches, so the
// next boot re-runs this path); plan-before-marker could leave an empty
// new-count plan with NO marker, silently cancelling the pause. When a valid
// marker already exists (crash re-run, or a mid-pause re-confirm to a
// different count), the current plan is NOT re-archived (it is empty or
// already archived) and the marker keeps its ORIGINAL from/at/archiveFile
// (only `to` changes), so the pause always references the archive holding
// the real ownership records.
async function confirmedReshard(
  store: ControlStore,
  plan: PersistedPlan,
  to: number,
  newTerm: number,
  existingMarker: ReshardMarker | null,
): Promise<RecoveryResult> {
  const now = Date.now();
  let from: number;
  let at: number;
  let archiveFile: string;
  if (existingMarker) {
    from = existingMarker.from;
    at = existingMarker.at;
    archiveFile = existingMarker.archiveFile;
  } else {
    from = plan.shardCount;
    at = now;
    const registry = (await store.loadRegistry()).nodes;
    archiveFile = await store.archivePlan({ plan, registry, archivedAt: at, from, to });
  }
  await store.saveReshardMarker({ from, to, at, archiveFile });
  const emptyPlan: PersistedPlan = { term: newTerm, epoch: plan.epoch, shardCount: to, assignments: [], updatedAt: now };
  await store.savePlan(emptyPlan);
  console.warn(`[Fleet] CONFIRMED RESHARD ${plan.shardCount} -> ${to}: ownership archived at ${archiveFile}; assignments PAUSED until resumed`);
  return {
    recovered: true,
    plan: emptyPlan,
    nodes: [],
    reshardApplied: { from: plan.shardCount, to, source: 'override' },
    reshardPaused: { from, to, archivedAt: at },
  };
}

function validatePlan(plan: PersistedPlan, newTerm: number): string | null {
  if (!Number.isInteger(plan.term) || plan.term < 0) return 'term is not an integer >= 0';
  if (!Number.isInteger(plan.epoch) || plan.epoch < 0) return 'epoch is not an integer >= 0';
  if (!Number.isInteger(plan.shardCount) || plan.shardCount < 1) return 'shardCount is not an integer >= 1';
  if (!Array.isArray(plan.assignments)) return 'assignments is not an array';
  if (plan.term >= newTerm) return `plan term ${plan.term} >= new term ${newTerm}, corrupted or cloned store`;
  const seen = new Set<number>();
  for (const assignment of plan.assignments) {
    if (typeof assignment?.nodeId !== 'string' || assignment.nodeId.length === 0) return 'assignment nodeId is empty';
    if (!Array.isArray(assignment.leases)) return 'assignment leases is not an array';
    for (const lease of assignment.leases) {
      if (typeof lease?.leaseId !== 'string' || lease.leaseId.length === 0) return 'lease leaseId is empty';
      if (!Number.isInteger(lease?.shardId) || lease.shardId < 0 || lease.shardId >= plan.shardCount) {
        return `lease shardId ${lease?.shardId} out of range [0, ${plan.shardCount})`;
      }
      if (seen.has(lease.shardId)) return `duplicate shardId ${lease.shardId} across assignments`;
      seen.add(lease.shardId);
    }
  }
  return null;
}
