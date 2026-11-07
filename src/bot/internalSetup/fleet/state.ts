// Read-only shard state of this process, answered over the fork IPC
// ('fleet:state') to the web UI.

import { resolveDataBackend } from '../../../utils/envLoader';
import { getDataBootStatus, DataBootStatus } from '../utils/dataBackends/boot';
import { getShardCountOverride } from './placement';
import { aboveReason, claimState, isExpired, rowsFor, type AboveReason, type ClaimState } from './claimRules';
import type { ShardSource } from './placement';
import type { BudgetInfo, IdentifyLedger } from './identifyLedger';
import type { LeaseInfo, LeaseRuntime } from './leaseRuntime';
import type { IngestService } from '../ingest/ingestService';
import type { ShardClaims } from './shardClaims';
import type { FailureClass, PageRead } from './claimStore';
import { databaseView, type DatabaseView } from '../utils/dataBackends/mainDatabase';
import { getWorkingSet } from '../utils/dataBackends/workingSet';

export interface FleetClaimRow {
  shardId: number;
  claim: number | null;
  holderName: string | null;
  holderNode: string | null;
  mine: boolean;
  homeName: string | null;
  state: ClaimState | 'never-taken';
  expiresInMs: number | null;
  expiredAgoMs: number | null;
  deferredMs: number | null;
}

export interface FleetNodeRow {
  nodeId: string;
  name: string;
  target: number;
  held: number;
  fit: boolean;
  restartable: boolean;
  returns: boolean;
  healthyForMs: number | null;
  seenAgoMs: number;
  takeoverSeconds: number;
  aboveReason: AboveReason | null;
}

export interface FleetState {
  initialized: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  shardCount: number;
  shardSource: ShardSource;
  /** Discord's latest recommended shard count; null before any /gateway/bot answer. */
  recommendedShards: number | null;
  recommendedAt: number | null;
  dataBackend: 'file' | 'postgres';
  dataBoot: DataBootStatus;
  /** This boot's process id; null on a JSON bot. */
  processId: string | null;
  leases: LeaseInfo[];
  shardTable: { shardId: number; nodeId: string; leaseId: string; status: string; guildCount: number }[];
  guildMap: Record<string, number>;
  budget: BudgetInfo | null;
  /** Every claim row of the active count, as last read; empty on a JSON bot. */
  claims: FleetClaimRow[];
  nodes: FleetNodeRow[];
  /** Ms since this process last read the claims; null before the first read. */
  claimsReadAgoMs: number | null;
  /** The last read is older than 2R: the page says "as last read". */
  claimsStale: boolean;
  renewalError: FailureClass | null;
  /** The class of the last failed claims read, or null once a read completes. */
  claimsReadError: FailureClass | null;
  stillConnected: number[];
  pendingRestart: string | null;
  /** Why the restart request waits (a fitness key); null when it was sent. */
  restartWaiting: string | null;
  returning: number[];
  aboveTarget: number[];
  /** NB5 decision 19: the main database and every address; null on a JSON bot. */
  database: DatabaseView | null;
  /** NB9 21: the open attempt as the last page read showed it; null with none. */
  reshard: FleetReshard | null;
  /** NB9 21: a wanted count the bot does not reshard to yet, and why; null when none waits. */
  reshardWait: { wanted: number; source: 'setting' | 'discord'; reason: string; cannot?: true } | null;
  /** NB9 21: the last attempt that ended. */
  lastReshard: { from: number; to: number; method: 'overlap' | 'stop-start' | null; state: 'done' | 'cancelled'; endedAt: number | null; reason: string | null } | null;
  /** NB9 21: the count an operator set, by machine and time; count null when the setting was removed. */
  target: { count: number | null; by: string; at: number | null } | null;
  updatedAt: number;
}

export interface FleetStateSources {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  shardSource: ShardSource;
  recommendedShards: number | null;
  recommendedAt: number | null;
  runtime: LeaseRuntime;
  ingest: IngestService;
  ledger: IdentifyLedger;
  claims: ShardClaims | null;
}

let sources: FleetStateSources | null = null;

/** NB9 21: the reshard driver's wait (Postgres), or a JSON bot's own reshard fields from its memory. */
export type ReshardSource = () => Partial<Pick<FleetState, 'reshard' | 'reshardWait' | 'lastReshard' | 'target'>>;
let reshardSource: ReshardSource | null = null;

let loginIntentBits = 0;

/** NB9 7: the intents bitfield this process logged in with, sent with the standby ask. */
export function setLoginIntents(bits: number): void {
  loginIntentBits = bits;
}

export function loginIntents(): number {
  return loginIntentBits;
}

export function setReshardSource(source: ReshardSource | null): void {
  reshardSource = source;
}

/** Wired once by the shard boot. */
export function _setFleetStateSources(s: FleetStateSources): void {
  sources = s;
}

/** NB9 21's open attempt. */
export interface FleetReshard {
  attempt: string;
  from: number;
  to: number;
  method: 'overlap' | 'stop-start' | null;
  state: 'standby' | 'flipped' | 'stopping';
  startedAgoMs: number | null;
  untilMs: number | null;
  reason: string | null;
  /** Ready live rows of the new count. */
  connected: number;
  /** The machines that still hold live rows of the old count. */
  waitingFor: string[];
}

const EMPTY_RESHARD = { reshard: null, reshardWait: null, lastReshard: null, target: null };

/** NB9 21: the reshard row from the last page read, its times moved on by ageMs. */
function reshardFields(page: PageRead | null, ageMs: number): Pick<FleetState, 'reshard' | 'reshardWait' | 'lastReshard' | 'target'> {
  const read = page?.reshard;
  if (!page || !read) return EMPTY_RESHARD;
  const more = page.attempt;
  const target = read.targetBy ? { count: read.target ?? null, by: read.targetBy, at: read.targetAt ?? null } : null;
  const counts = read.attempt !== null && read.fromCount !== null && read.toCount !== null;
  const open = counts && (read.state === 'standby' || read.state === 'flipped' || read.state === 'stopping');
  const reshard: FleetReshard | null = open ? {
    attempt: read.attempt!,
    from: read.fromCount!,
    to: read.toCount!,
    method: more?.method ?? null,
    state: read.state as FleetReshard['state'],
    startedAgoMs: more?.startedAgoMs == null ? null : more.startedAgoMs + ageMs,
    untilMs: more?.untilMs == null ? null : Math.max(more.untilMs - ageMs, 0),
    reason: more?.reason ?? null,
    connected: more?.connected ?? 0,
    waitingFor: more?.waitingFor ?? [],
  } : null;
  const ended = counts && (read.state === 'done' || read.state === 'cancelled');
  const lastReshard = ended ? {
    from: read.fromCount!,
    to: read.toCount!,
    method: more?.method ?? null,
    state: read.state as 'done' | 'cancelled',
    endedAt: more?.endedAgoMs == null ? null : Date.now() - more.endedAgoMs - ageMs,
    reason: more?.reason ?? null,
  } : null;
  return { reshard, reshardWait: null, lastReshard, target };
}

const EMPTY_CLAIMS = {
  claims: [] as FleetClaimRow[],
  nodes: [] as FleetNodeRow[],
  claimsReadAgoMs: null,
  claimsStale: false,
  renewalError: null,
  claimsReadError: null,
  stillConnected: [] as number[],
  pendingRestart: null,
  restartWaiting: null,
  returning: [] as number[],
  aboveTarget: [] as number[],
  ...EMPTY_RESHARD,
};

/**
 * Decision 21's tables from the last page read: every time is a database delta at the read, moved on by ageMs (this
 * process's clock since that read), so an old read does not show its times as current.
 */
function claimTables(claims: ShardClaims, shardCount: number, ageMs: number): Pick<FleetState, 'claims' | 'nodes' | 'aboveTarget'> {
  const snap = claims.snapshot();
  const page = snap.page;
  if (!page) return { claims: [], nodes: [], aboveTarget: [] };
  const less = (ms: number) => Math.max(ms - ageMs, 0);
  const nodesById = new Map(page.nodes.map(n => [n.nodeId, n]));
  const count = page.shardCount ?? shardCount;
  const byShard = new Map(page.rows.map(r => [r.shardId, r]));
  const rows: FleetClaimRow[] = [];
  for (let shardId = 0; shardId < count; shardId++) {
    const row = byShard.get(shardId);
    if (!row) {
      rows.push({ shardId, claim: null, holderName: null, holderNode: null, mine: false, homeName: null, state: 'never-taken', expiresInMs: null, expiredAgoMs: null, deferredMs: null });
      continue;
    }
    const { state, deferredMs } = claimState(row, row.renewedAgoMs, nodesById.get(row.holderNode), page.upMs, page.uPrimeMs);
    rows.push({
      shardId,
      claim: row.claim,
      holderName: row.holderName,
      holderNode: row.holderNode,
      mine: row.holderProcess === snap.processId,
      homeName: nodesById.get(row.homeNode)?.nodeName ?? row.homeNode,
      state,
      expiresInMs: isExpired(row, page.upMs) ? null : less(Math.max(row.expiresUpMs - page.uPrimeMs, 0)),
      expiredAgoMs: isExpired(row, page.upMs) ? Math.max(page.uPrimeMs - row.expiresUpMs, 0) + ageMs : null,
      deferredMs: deferredMs === undefined || deferredMs === null ? null : less(deferredMs),
    });
  }
  const nodes: FleetNodeRow[] = page.nodes.map(n => {
    const held = rowsFor(n.nodeId, page.rows, page.upMs);
    const reason = held > n.capacity ? aboveReason(n, page.nodes, page.rows, page.upMs) : null;
    return {
      nodeId: n.nodeId,
      name: n.nodeName,
      target: n.capacity,
      held,
      fit: n.fit,
      restartable: n.restartable,
      returns: n.returns,
      healthyForMs: n.healthyForMs === null ? null : n.healthyForMs + ageMs,
      seenAgoMs: n.seenAgoMs + ageMs,
      takeoverSeconds: n.takeoverSeconds,
      aboveReason: reason?.kind === 'waiting-healthy' ? { ...reason, leftMs: less(reason.leftMs) } : reason,
    };
  });
  const me = nodesById.get(page.nodes.find(n => n.processId === snap.processId)?.nodeId ?? '');
  const aboveTarget = me && snap.held.length > me.capacity ? snap.held.map(p => p.shardId).sort((a, b) => a - b).slice(me.capacity) : [];
  return { claims: rows, nodes, aboveTarget };
}

/** Decision 19: the chooser's view, with the held counts while any set is pending re-save. */
function databaseState(): DatabaseView | null {
  const view = databaseView();
  if (!view) return null;
  const ws = getWorkingSet();
  const resave = ws?.resaveGuilds().length ?? 0;
  return { ...view, held: resave > 0 ? { guilds: ws?.heldGuilds().length ?? 0, resave } : null };
}

export function getFleetState(): FleetState {
  if (!sources) {
    return {
      initialized: false,
      nodeId: '',
      nodeName: '',
      appVersion: '',
      shardCount: 0,
      shardSource: getShardCountOverride() !== null ? 'override' : 'discord',
      recommendedShards: null,
      recommendedAt: null,
      dataBackend: resolveDataBackend(),
      dataBoot: getDataBootStatus(),
      processId: null,
      leases: [],
      shardTable: [],
      guildMap: {},
      budget: null,
      ...EMPTY_CLAIMS,
      database: databaseState(),
      updatedAt: Date.now(),
    };
  }

  const { nodeId, nodeName, appVersion, runtime, ingest, ledger, claims } = sources;
  const lease = runtime.getCurrent();
  const leases = lease ? lease.leases.map(l => ({ ...l })) : [];
  const shardCount = lease?.shardCount ?? 0;
  const client = ingest.getClient();
  const guildMap: Record<string, number> = {};
  if (client && lease) {
    for (const guild of client.guilds.cache.values()) guildMap[guild.id] = guild.shardId;
  }
  const statusByShard = new Map(runtime.shardStatuses().map(s => [s.shardId, s]));
  const shardTable: FleetState['shardTable'] = [...leases]
    .sort((a, b) => a.shardId - b.shardId)
    .map(held => {
      const entry = statusByShard.get(held.shardId);
      return { shardId: held.shardId, nodeId, leaseId: held.leaseId, status: entry?.status ?? 'Unknown', guildCount: entry?.guildCount ?? 0 };
    });
  const recommendation = ledger.getRecommendation();
  let claimFields = { ...EMPTY_CLAIMS } as Pick<FleetState, keyof typeof EMPTY_CLAIMS>;
  if (claims) {
    const snap = claims.snapshot();
    const readAgoMs = snap.pageReadAt === null ? null : Math.max(Math.round(performance.now() - snap.pageReadAt), 0);
    claimFields = {
      ...claimTables(claims, shardCount, readAgoMs ?? 0),
      claimsReadAgoMs: readAgoMs,
      claimsStale: readAgoMs !== null && readAgoMs > 2 * snap.renewMs,
      renewalError: snap.renewalError,
      claimsReadError: snap.pageReadError,
      stillConnected: runtime.getStillConnected(),
      pendingRestart: snap.pendingRestart,
      restartWaiting: snap.restartWaiting,
      returning: snap.returning,
      ...reshardFields(snap.page, readAgoMs ?? 0),
    };
  }
  if (reshardSource) {
    const own = reshardSource();
    // On Postgres the page read holds the attempt; the driver adds only its wait. A JSON bot fills all four.
    claimFields = claims ? { ...claimFields, reshardWait: own.reshardWait ?? null } : { ...claimFields, ...own };
  }
  return {
    initialized: true,
    nodeId,
    nodeName,
    appVersion,
    shardCount,
    shardSource: sources.shardSource,
    recommendedShards: recommendation?.shards ?? sources.recommendedShards,
    recommendedAt: recommendation?.readAt ?? sources.recommendedAt,
    dataBackend: resolveDataBackend(),
    dataBoot: getDataBootStatus(),
    processId: lease?.processId ?? null,
    leases,
    shardTable,
    guildMap,
    budget: ledger.getBudgetInfo(),
    ...claimFields,
    database: databaseState(),
    updatedAt: Date.now(),
  };
}
