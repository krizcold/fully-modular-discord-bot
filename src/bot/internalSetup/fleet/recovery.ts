// Restart recovery: validates the persisted plan against the freshly
// acquired term and the shardCount policy, and synthesizes node stubs when
// registry.json is missing or stale. Standalone never reads the store, so a
// zero-fleet-env boot stays byte-identical to today.

import type { ControlStore, PersistedMigrations, PersistedNode, PersistedPlan, RedistributeProposal, ReshardMarker } from './controlStore';
import { migrationsHoldTogether } from './controlStore';
import { isReshardConfirmed } from './placement';

export interface RecoveryOptions {
  newTerm: number;
  resolvedShardCount: number;
  /** Discord's /gateway/bot recommendation from a SUCCESSFUL live fetch; null when unreachable (never advise off a fallback). */
  liveRecommendation: number | null;
  override: number | null;
  standalone: boolean;
  /** Deployment's resolved backend for synthesized node stubs; passed in so this module stays env-import-free. */
  dataBackend: 'file' | 'postgres';
  /**
   * The caller INHERITED newTerm from the stored row instead of minting it (a
   * serve-only stand-in, 20.5). The stored plan is stamped under that same term,
   * so equality stops being evidence of a cloned store and becomes the expected
   * case; without this the plan is discarded and every shard the dead master
   * held reads as free.
   */
  termInherited?: boolean;
  /** This master's node id: a cleanup it owes itself runs at its own boot. */
  selfNodeId?: string;
}

export interface RecoveryResult {
  /** True on recovery boots (a valid prior plan existed); gates the hold-down window. */
  recovered: boolean;
  /** Present when a plan was adopted; a confirmed reshard adopts the empty new-count plan it just wrote. */
  plan?: PersistedPlan;
  /** One stub per plan assignment, from registry.json where available, synthesized otherwise. */
  nodes?: PersistedNode[];
  /** The stored redistribute proposal, read with the plan: outside the pause, a Resume's grants still landing. */
  proposal?: Record<number, string>;
  reshardApplied?: { from: number; to: number; source: 'override' };
  reshardAdvised?: { running: number; recommended: number };
  /** Override mismatch without FLEET_CONFIRM_RESHARD: the plan was adopted unchanged, the change awaits confirmation. */
  reshardNeedsConfirm?: { from: number; to: number };
  /** Confirmed, but a node not Declared Lost still owes a cleanup it missed, or the migration records cannot be read: the plan was adopted unchanged. */
  reshardDeferred?: { from: number; to: number; reason: string };
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

  const invalid = validatePlan(plan, opts.newTerm, opts.termInherited === true);
  if (invalid) {
    console.error(`[Fleet] Persisted plan DISCARDED (${invalid}); starting virgin`);
    const result: RecoveryResult = { recovered: false };
    if (paused) result.reshardPaused = paused;
    return result;
  }

  // A stand-in cannot persist the archive that makes a reshard reversible: on a
  // read-only store every write inside confirmedReshard is a silent no-op, and
  // it would still RETURN an empty plan, so the node would take over and serve
  // zero shards - strictly worse than never arming.
  if (opts.termInherited && opts.override !== null && opts.override !== plan.shardCount) {
    console.warn(`[Fleet] Standing in: ignoring the FLEET_SHARD_COUNT override ${opts.override} and adopting the persisted ${plan.shardCount}-shard plan`);
    const result = await adoptPlan(store, plan, opts.dataBackend);
    if (paused) result.reshardPaused = paused;
    return result;
  }
  if (opts.override !== null && opts.override !== plan.shardCount) {
    if (!isReshardConfirmed()) {
      // Unconfirmed count change: adopt the old count (zero downtime); an
      // unconfirmed change can never wipe or remap anything.
      const result = await adoptPlan(store, plan, opts.dataBackend);
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
    // A crash's re-run of the marker's own count passed the full wait when
    // the marker was written; it checks only for a migration a boot in
    // between may have run in the pause (records that cannot be read wait).
    const deferred = usableMarker?.to !== opts.override
      ? await reshardDeferral(store, plan, opts.selfNodeId, paused !== null)
      : await store.loadMigrations().then(
        m => m.unreadable || !migrationsHoldTogether(m) ? 'the migration records cannot be read' : m.active ? migrationUnderWay(m.active) : null,
        () => 'the migration records cannot be read');
    if (deferred) {
      const result = await adoptPlan(store, plan, opts.dataBackend);
      result.reshardDeferred = { from: plan.shardCount, to: opts.override, reason: deferred };
      if (paused) result.reshardPaused = paused;
      console.warn(`[Fleet] FLEET_SHARD_COUNT ${opts.override} is confirmed, but the reshard waits: ${deferred}; keeping ${plan.shardCount} shard(s); restart the master once that is settled`);
      return result;
    }
    return confirmedReshard(store, plan, opts.override, opts.newTerm, usableMarker);
  }

  const result = await adoptPlan(store, plan, opts.dataBackend);
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

async function adoptPlan(store: ControlStore, plan: PersistedPlan, dataBackend: 'file' | 'postgres'): Promise<RecoveryResult> {
  const persisted = (await store.loadRegistry()).nodes;
  const byId = new Map(persisted.map(n => [n.nodeId, n]));
  const nodes: PersistedNode[] = plan.assignments.map(a =>
    byId.get(a.nodeId) ?? {
      nodeId: a.nodeId,
      nodeName: a.nodeId,
      appVersion: '',
      capabilities: { shardCapacity: 1, dataBackend },
      lastSeenAt: 0,
    },
  );
  // A node the migration under way still names, or the stored redistribute
  // proposal names as a shard's owner, stays known though it holds no lease
  // (a drained source, an owner no Resume grant has reached): its rollback or
  // grant reaches a listed node, which a Declare Lost can settle. One a
  // Declare Lost wrote out is not invented. A store read that throws fails
  // the boot, as a registry read that throws does, rather than write these
  // nodes out.
  const stored = await store.loadRedistributeProposal();
  for (const nodeId of [...await migrationParticipants(store), ...proposalOwners(stored, plan)]) {
    const node = byId.get(nodeId);
    if (node && !nodes.some(n => n.nodeId === nodeId)) nodes.push(node);
  }
  return stored ? { recovered: true, plan, nodes, proposal: stored.proposal } : { recovered: true, plan, nodes };
}

/** The nodes the unfinished legs of the migration under way name, but a source or target marked Declared Lost. */
async function migrationParticipants(store: ControlStore): Promise<string[]> {
  const migrations = await store.loadMigrations();
  if (migrations.unreadable || !migrationsHoldTogether(migrations) || !migrations.active) return [];
  const ids = new Set<string>();
  for (const leg of migrations.active.legs) {
    if (leg.legState === 'DONE') continue;
    if (leg.sourceLostAt === undefined) ids.add(leg.sourceNodeId);
    if (leg.targetLostAt === undefined) ids.add(leg.targetNodeId);
  }
  return [...ids];
}

/** The owners the stored redistribute proposal names for the shards a Resume would grant (of the plan's count, leased by no one); one that cannot be parsed names none. */
function proposalOwners(stored: RedistributeProposal | null, plan: PersistedPlan): string[] {
  if (!stored) return [];
  const leased = new Set(plan.assignments.flatMap(a => a.leases.map(l => l.shardId)));
  return proposalShards(stored.proposal, plan.shardCount, shardId => leased.has(shardId)).map(([, owner]) => owner);
}

/** A redistribute proposal's shards a grant must still land, each with its owner: a shard of the count not settled (already placed, or held for the operator's choice), its owner a node id the caller still knows. */
export function proposalShards(proposal: Record<number, string>, shardCount: number, settled: (shardId: number) => boolean, known: (nodeId: string) => boolean = () => true): [number, string][] {
  return Object.entries(proposal).flatMap(([shardKey, owner]): [number, string][] => {
    const shardId = Number(shardKey);
    if (!Number.isInteger(shardId) || shardId < 0 || shardId >= shardCount || settled(shardId)) return [];
    return typeof owner === 'string' && known(owner) ? [[shardId, owner]] : [];
  });
}

/** The nodes still owing a cleanup they missed and not Declared Lost, named from their notes. */
export function owingNodes(migrations: PersistedMigrations): { nodeId: string; nodeName: string }[] {
  const owing = new Map<string, string>();
  for (const rec of [migrations.active, ...migrations.history]) {
    for (const entry of rec?.pendingSourceCleanup ?? []) {
      for (const legId of entry.legIds) {
        const leg = rec!.legs.find(l => l.legId === legId);
        if (!leg || leg.sourceLostAt !== undefined) continue;
        if (owing.get(entry.nodeId) === undefined || owing.get(entry.nodeId) === entry.nodeId) owing.set(entry.nodeId, leg.committed?.sourceName ?? entry.nodeId);
      }
    }
  }
  return [...owing].map(([nodeId, nodeName]) => ({ nodeId, nodeName }));
}

// A confirmed reshard renumbers every shard, and a cleanup a node missed
// names its shard by number: the reshard waits while a node not Declared
// Lost still owes one (it may come back to that shard), while a migration
// is under way (its recovery would grant or roll back old numbers into the
// pause), and while the records cannot be read. A lost node's note crosses
// it, kept only as its cleanup by guild ids.
async function reshardDeferral(store: ControlStore, plan: PersistedPlan, selfNodeId: string | undefined, inPause: boolean): Promise<string | null> {
  let migrations: PersistedMigrations;
  try {
    migrations = await store.loadMigrations();
  } catch {
    return 'the migration records cannot be read';
  }
  if (migrations.unreadable || !migrationsHoldTogether(migrations)) return 'the migration records cannot be read';
  // A copy held for the operator's choice waits on that choice, not on its node.
  const placed = new Set(plan.assignments.flatMap(a => a.leases.map(l => l.shardId)));
  const held = new Set<number>();
  const waiting = new Set<string>();
  for (const rec of [migrations.active, ...migrations.history]) {
    for (const entry of rec?.pendingSourceCleanup ?? []) {
      for (const legId of entry.legIds) {
        const leg = rec!.legs.find(l => l.legId === legId);
        if (!leg || leg.sourceLostAt !== undefined) continue;
        if (leg.heldForChoice && !placed.has(leg.shardId)) held.add(leg.shardId);
        else waiting.add(entry.nodeId);
      }
    }
  }
  const owing = owingNodes(migrations).filter(n => waiting.has(n.nodeId));
  const running = migrations.active;
  if (!running && held.size === 0 && owing.length === 0) return null;
  const stored = await store.loadRegistry().then(r => r.nodes).catch(() => [] as PersistedNode[]);
  const nameOf = (n: { nodeId: string; nodeName: string }): string => stored.find(s => s.nodeId === n.nodeId)?.nodeName ?? n.nodeName;
  const reasons = owing.map(n => n.nodeId === selfNodeId
    ? 'this master still owes the cleanup of a migration it missed (it is retried now; restart the master once more after it has run)'
    : `${nameOf(n)} still owes the cleanup of a migration it missed (bring it back online so the cleanup runs, or Declare it Lost on the Fleet tab)`);
  if (held.size > 0) reasons.unshift(`shard(s) [${[...held].sort((a, b) => a - b).join(', ')}] wait on the operator's choice on the Fleet tab${inPause ? ' after Resume' : ''} (restore the surviving copy or start the shard empty)`);
  if (running) reasons.unshift(migrationUnderWay(running));
  return reasons.join('; ');
}

function migrationUnderWay(rec: NonNullable<PersistedMigrations['active']>): string {
  return `a ${rec.kind} migration is still under way; restart the master once it has ended (a paused one is continued or aborted on the Fleet tab)`;
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

function validatePlan(plan: PersistedPlan, newTerm: number, termInherited: boolean): string | null {
  if (!Number.isInteger(plan.term) || plan.term < 0) return 'term is not an integer >= 0';
  if (!Number.isInteger(plan.epoch) || plan.epoch < 0) return 'epoch is not an integer >= 0';
  if (!Number.isInteger(plan.shardCount) || plan.shardCount < 1) return 'shardCount is not an integer >= 1';
  if (!Array.isArray(plan.assignments)) return 'assignments is not an array';
  // A stand-in does not MINT a term, it inherits the one the plan was stamped
  // under, so equality here is the normal case rather than a cloned store. The
  // relaxation is gated on that: for a master that minted, `>=` is still the
  // only thing that catches a boot against a copied volume, and losing it there
  // would let a clone adopt a plan it must discard.
  if (termInherited ? plan.term > newTerm : plan.term >= newTerm) {
    return `plan term ${plan.term} ${termInherited ? '>' : '>='} new term ${newTerm}, corrupted or cloned store`;
  }
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
