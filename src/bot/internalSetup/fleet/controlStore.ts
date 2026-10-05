// ControlStore - persistence seam for the control plane (terms, leases,
// registry). Phase 1 ships the embedded file implementation; an external
// store with real CAS replaces it for multi-master durability later, behind
// this same interface.

import type { BackupDesignation, LeaseInfo, MigrationKind, NodeCapabilities, SyncPosturePayload, TransferDirection } from './protocol';
import type { LossEvent } from './healthMonitor';

export interface PersistedTerm {
  term: number;
  nodeId: string;
  updatedAt: number;
}

export interface PersistedAssignment {
  nodeId: string;
  leases: LeaseInfo[];
}

export interface PersistedPlan {
  term: number;
  epoch: number;
  shardCount: number;
  assignments: PersistedAssignment[];
  updatedAt: number;
}

export interface PersistedNode {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  capabilities: NodeCapabilities;
  lastSeenAt: number;
}

export interface PersistedRegistry {
  nodes: PersistedNode[];
  /** Node-loss event ring; survives master restarts. */
  lostNodes?: LossEvent[];
  updatedAt: number;
}

/** Outgoing plan + registry snapshot written on a confirmed reshard; ownership records are archived, never discarded. */
export interface ReshardArchive {
  plan: PersistedPlan;
  registry: PersistedNode[];
  archivedAt: number;
  from: number;
  to: number;
}

/** Reshard pause marker (reshard-pending.json): while it exists, ANY boot enters the pause regardless of env. */
export interface ReshardMarker {
  from: number;
  to: number;
  at: number;
  archiveFile: string;
}

/** Master-side migration state machine states (P5). */
export type MigrationState =
  | 'PRECHECK'
  | 'PREPARING'
  | 'COPYING'
  | 'DRAINING'
  | 'VERIFYING'
  | 'COMMITTING'
  | 'GRANTING'
  | 'DONE'
  | 'ABORTING'
  | 'ABORTED';

/** One transfer leg of a migration record. */
export interface MigrationLeg {
  legId: string;
  shardId: number;
  sourceNodeId: string;
  targetNodeId: string;
  direction: TransferDirection;
  guilds: string[];
  /** Per-leg state for the sequential retire pipeline; undefined for single-barrier kinds. */
  legState?: MigrationState;
  error?: string;
  /** The commit decision's epoch and time, and the source's name then: they order, date and name the copy a source that missed this cleanup still holds. */
  committed?: { epoch: number; at: number; sourceName: string };
  /** The source was Declared Lost while it still owed this cleanup: its copy went with it. */
  sourceLostAt?: number;
  /** The target was Declared Lost before this leg's grant landed: the copy its commit put there went with it. */
  targetLostAt?: number;
  /** Its drain began, so its source's lease may be revoked: an abort, after a master restart too, re-grants the source. */
  drained?: boolean;
  /**
   * A Declare Lost freed this leg's shard while its source still owed this
   * cleanup: that copy may be the last, so the cleanup waits on the
   * operator's choice (restore it, or start the shard empty) while the
   * shard stays unplaced.
   */
  heldForChoice?: { lostNodeName: string; at: number };
}

/**
 * Persisted migration record (crash recovery). COMMITTING is written BEFORE the
 * first commit message leaves - the joint-commit decision barrier: once it is on
 * disk both-or-neither holds across a master crash.
 */
export interface MigrationRecord {
  id: string;
  kind: MigrationKind;
  legs: MigrationLeg[];
  state: MigrationState;
  term: number;
  epoch?: number;
  /** The shard count its legs' shard ids are numbered under (a reshard renumbers them). */
  shardCount?: number;
  error?: string;
  /** Retire: index of the leg currently executing; legs before it are committed. */
  currentLegIndex?: number;
  /**
   * Sources that were unreachable at COMMITTING: their originals are not yet
   * graveyarded. Retained on the finished record so the coordinator re-sends the
   * idempotent XFER_COMMIT when the source reconnects (term/epoch fencing keeps
   * it from serving meanwhile). Cleared per-node as each source cleanup acks.
   */
  pendingSourceCleanup?: { nodeId: string; legIds: string[] }[];
  /** Nodes an aborted record's abort has not reached yet (a promote's pin ended it for an old master gone before sending it). */
  abortUndelivered?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedMigrations {
  active: MigrationRecord | null;
  history: MigrationRecord[];
  updatedAt: number;
  /** The records exist but could not be read or parsed (not the same as none). */
  unreadable?: boolean;
}

/**
 * Redistribute assignment proposal (shard -> node) persisted alongside the
 * reshard pause. masterResume grants EXACTLY this map so every guild serves
 * from the node its data was committed to, not a load-based re-distribute.
 */
export interface RedistributeProposal {
  proposal: Record<number, string>;
  updatedAt: number;
}

/** Master-side backend transformation state machine states (spec 3.2). */
export type TransformationState =
  | 'PLANNING'
  | 'CONVERTING'
  | 'FLIPPING'
  | 'RETIRING'
  | 'PAUSED'
  | 'ABORTING'
  | 'DONE'
  | 'ABORTED';

export type TransformDirection = 'file-to-postgres' | 'postgres-to-file';

export interface TransformationNodePlan {
  nodeId: string;
  /** Owned-guild snapshot at PLANNING, ascending numeric. */
  guilds: string[];
  /** Guilds that appeared during the window (source-routed until FLIPPING). */
  joined: string[];
  /** Position in guilds concat joined; entries before it are converted. */
  cursor: number;
  /** Position in guilds concat joined for the RETIRING pass. */
  retireCursor?: number;
  /** Cursor value when ABORTING began: the reverse pass covers entries [0, abortLimit). */
  abortLimit?: number;
}

/**
 * Persisted transformation record (crash recovery). FLIPPING is written BEFORE
 * the flip broadcast leaves - the same both-or-neither barrier migrations use
 * for COMMITTING.
 */
export interface TransformationRecord {
  id: string;
  direction: TransformDirection;
  state: TransformationState;
  term: number;
  nodes: TransformationNodePlan[];
  /** State the operation was in when it paused; PAUSED resumes back into it. */
  pausedFrom?: TransformationState;
  error?: string;
  failedGuilds?: { guildId: string; reason: string }[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Fleet runtime config (PLAN_REPLICATION 20.7): topology edited at runtime with
 * zero restarts. Env values seed it exactly once (first master boot); after
 * that the stored copy owns every key, rides replication to the standby, and
 * is pushed to every node over the control channel.
 */
export interface PersistedFleetConfig {
  revision: number;
  /** Ordered master-candidate dial list (ws/wss URLs). */
  masterCandidates: string[];
  /** Designated backups; priority orders stand-in election (B5 consumes it). */
  backupDesignations: BackupDesignation[];
  /** Witness beacon channel id; absent = owner DM default (PLAN_REPLICATION 20.6). */
  witnessChannelId?: string;
  /** Set once a backup has ever been designated and never unset: the empty-store hold's evidence once the list is empty (20.14). */
  hadBackup?: boolean;
  updatedAt: number;
}

export interface ControlStore {
  /** CAS-acquire a new master term: strictly greater than any previously stored term. */
  acquireTerm(nodeId: string): Promise<number>;
  getTerm(): Promise<PersistedTerm | null>;
  saveFleetConfig(config: PersistedFleetConfig): Promise<void>;
  loadFleetConfig(): Promise<PersistedFleetConfig | null>;
  savePlan(plan: PersistedPlan): Promise<void>;
  loadPlan(): Promise<PersistedPlan | null>;
  saveRegistry(registry: PersistedRegistry): Promise<void>;
  loadRegistry(): Promise<PersistedRegistry>;
  /** Archive the outgoing plan + registry on a confirmed reshard; returns the archive file reference. */
  archivePlan(archive: ReshardArchive): Promise<string>;
  /** Fail-closed: null ONLY when the marker file does not exist; any other read/parse failure returns 'corrupt' (still a pause). */
  loadReshardMarker(): Promise<ReshardMarker | 'corrupt' | null>;
  saveReshardMarker(marker: ReshardMarker): Promise<void>;
  clearReshardMarker(): Promise<void>;
  /** Persist the migration record + history atomically (called on every state transition). */
  saveMigrations(state: PersistedMigrations): Promise<void>;
  loadMigrations(): Promise<PersistedMigrations>;
  /** Persist the redistribute assignment proposal for masterResume; null clears it. */
  saveRedistributeProposal(proposal: RedistributeProposal | null): Promise<void>;
  loadRedistributeProposal(): Promise<RedistributeProposal | null>;
  /** Persist the backend transformation record (every state transition); null clears it. */
  saveTransformation(record: TransformationRecord | null): Promise<void>;
  loadTransformation(): Promise<TransformationRecord | null>;
  /**
   * The master's synchronous posture (B6 map F23). On postgres this row is the
   * point: it lives in the replicated cluster, so every standby replays it with
   * no protocol at all, and while the posture is ARMED the row's own write is
   * synchronous, which is what makes a replayed row evidence rather than gossip.
   */
  saveSyncPosture(fact: SyncPosturePayload | null): Promise<void>;
}

const MIGRATION_KINDS = new Set<string>(['move', 'swap', 'retire', 'redistribute']);
const MIGRATION_STATES = new Set<string>(['PRECHECK', 'PREPARING', 'COPYING', 'DRAINING', 'VERIFYING', 'COMMITTING', 'GRANTING', 'DONE', 'ABORTING', 'ABORTED']);
const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const absentOrFinite = (v: unknown): boolean => v === undefined || isFiniteNumber(v);
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

// Every field the master reads off a persisted record, its legs and its owed cleanups.
function recordHoldsTogether(rec: unknown): boolean {
  if (!isObject(rec)) return false;
  const r = rec as MigrationRecord;
  return typeof r.id === 'string' && MIGRATION_KINDS.has(r.kind) && MIGRATION_STATES.has(r.state)
    && isFiniteNumber(r.term) && absentOrFinite(r.epoch) && absentOrFinite(r.updatedAt)
    && Array.isArray(r.legs) && r.legs.every(l => isObject(l) && typeof l.legId === 'string'
      && Number.isInteger(l.shardId) && typeof l.sourceNodeId === 'string' && typeof l.targetNodeId === 'string' && Array.isArray(l.guilds)
      && (l.legState === undefined || MIGRATION_STATES.has(l.legState))
      && (l.committed === undefined || (isObject(l.committed) && isFiniteNumber(l.committed.epoch) && isFiniteNumber(l.committed.at)))
      && (l.heldForChoice === undefined || (isObject(l.heldForChoice) && isFiniteNumber(l.heldForChoice.at)))
      && absentOrFinite(l.sourceLostAt) && absentOrFinite(l.targetLostAt))
    && (r.currentLegIndex === undefined || (Number.isInteger(r.currentLegIndex) && r.currentLegIndex >= 0 && r.currentLegIndex <= r.legs.length))
    && (r.pendingSourceCleanup === undefined || (Array.isArray(r.pendingSourceCleanup)
      && r.pendingSourceCleanup.every(e => isObject(e) && typeof e.nodeId === 'string' && Array.isArray(e.legIds))));
}

/** The active migration (when any) and every history entry hold together; records that do not read as unreadable. */
export function migrationsHoldTogether(m: PersistedMigrations): boolean {
  return (m.active === null || recordHoldsTogether(m.active)) && Array.isArray(m.history) && m.history.every(recordHoldsTogether);
}
