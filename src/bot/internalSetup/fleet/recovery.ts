// Restart recovery: validates the persisted plan against the freshly
// acquired term and the shardCount policy, and synthesizes node stubs when
// registry.json is missing or stale. Standalone never reads the store, so a
// zero-fleet-env boot stays byte-identical to today.

import type { ControlStore, PersistedNode, PersistedPlan } from './controlStore';

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
  /** Present when the plan was adopted; absent on virgin boots and resharding boots. */
  plan?: PersistedPlan;
  /** One stub per plan assignment, from registry.json where available, synthesized otherwise. */
  nodes?: PersistedNode[];
  reshardApplied?: { from: number; to: number; source: 'override' };
  reshardAdvised?: { running: number; recommended: number };
}

export async function evaluateRecovery(store: ControlStore, opts: RecoveryOptions): Promise<RecoveryResult> {
  if (opts.standalone) return { recovered: false };

  const plan = await store.loadPlan();
  if (!plan) return { recovered: false };

  const invalid = validatePlan(plan, opts.newTerm);
  if (invalid) {
    console.error(`[Fleet] Persisted plan DISCARDED (${invalid}); starting virgin`);
    return { recovered: false };
  }

  if (opts.override !== null && opts.override !== plan.shardCount) {
    console.warn(`[Fleet] FLEET_SHARD_COUNT override ${opts.override} != persisted ${plan.shardCount}; discarding plan for a fresh replan under hold-down`);
    return { recovered: true, reshardApplied: { from: plan.shardCount, to: opts.override, source: 'override' } };
  }

  const persisted = await store.loadRegistry();
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

  const result: RecoveryResult = { recovered: true, plan, nodes };
  if (opts.liveRecommendation !== null && opts.liveRecommendation !== plan.shardCount) {
    // DECISION-1: adopt the persisted shardCount even when Discord's live
    // recommendation differs; the guild -> shard formula binds ownership to
    // shard ids, so an advisory change must never re-scramble owned guilds.
    result.reshardAdvised = { running: plan.shardCount, recommended: opts.liveRecommendation };
    console.warn(`[Fleet] Discord now recommends ${opts.liveRecommendation} shard(s); fleet continues at ${plan.shardCount}; reshard requires setting FLEET_SHARD_COUNT`);
  }
  return result;
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
