/**
 * Replication observability (PLAN_REPLICATION.md Stage 5).
 *
 * Two views of the same link, sampled on a slow tick because both cost a
 * database round trip and both are read from hot paths (the heartbeat builder
 * and getFleetState):
 *
 *  - standby side: this node's local copy, reusing the Stage 3 promote probe.
 *    Rides the heartbeat, so the master can show every node's copy at once.
 *  - primary side: pg_stat_replication on the fleet database. Every postgres
 *    node shares that database, so each reads the same answer and puts it
 *    straight into its own state; the warning reaches whichever UI is open.
 *  - the slot table (20.17 slot signal): pg_replication_slots on the same
 *    database. wal_status is the one fact a standby cannot see from its own
 *    machine, so the master pushes each read to the nodes hosting a standby.
 *
 * A node with no standby and a fleet that is not replicating both sample
 * nothing and report nothing, which is what keeps this inert for the
 * single-machine deployments R7 leaves untouched.
 */

import { getGuildDataBackend } from '../utils/dataManager';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { probeReplica, resolveReplicaEndpoints, spliceFleetCredentials } from './replicaPromotion';
import type { ReplicaHealthReport, SlotStatusRow } from './protocol';

const SAMPLE_MS = 60_000;

/** One attached standby, from the primary's point of view. */
export interface StandbyLinkView {
  clientAddr: string;
  state: string;
  replayLagSeconds: number | null;
}

/** The primary's slot table at one read; the master pushes it to standby-hosting nodes. */
export interface SlotSample {
  observedAt: number;
  slots: SlotStatusRow[];
}

/** What this node's own standby says about where it streams from; a pushed slot table is judged against it. */
export interface LocalReplicaIdentity {
  slotName: string | null;
  sourceHost: string | null;
  sourcePort: number | null;
  /** This node's clock when sourceHost was last READ, not when it was last carried forward. */
  sourceAt: number;
}

let replicaHealth: ReplicaHealthReport | undefined;
let localIdentity: LocalReplicaIdentity | undefined;
let standbyLinks: StandbyLinkView[] | undefined;
let slotSample: SlotSample | undefined;
let samplerStarted = false;
let probeListener: ((report: ReplicaHealthReport) => void) | undefined;

/** Called after every local standby probe; the co-worker uses it to drop a slot record the standby itself contradicts. */
export function setReplicaProbeListener(listener: (report: ReplicaHealthReport) => void): void {
  probeListener = listener;
}

/** Cached standby view for the heartbeat; undefined when this node has no replica. */
export function getReplicaHealth(): ReplicaHealthReport | undefined {
  return replicaHealth;
}

/** Slot name and source of this node's standby, from the last successful probe; undefined when it has no replica. */
export function getLocalReplicaIdentity(): LocalReplicaIdentity | undefined {
  return localIdentity;
}

/** Cached primary view for fleet state; undefined until the first successful read. */
export function getStandbyLinks(): StandbyLinkView[] | undefined {
  return standbyLinks;
}

/** Cached slot table for the master's push; undefined until the first successful read. */
export function getSlotSample(): SlotSample | undefined {
  return slotSample;
}

async function sampleLocalReplica(): Promise<void> {
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) {
    replicaHealth = undefined;
    localIdentity = undefined;
    return;
  }
  const spliced = spliceFleetCredentials(endpoints.local);
  if (!spliced.url) {
    // Before the first register this node has no fleet credentials to splice,
    // which is a not-yet rather than a fault: stay silent instead of reporting
    // a broken standby the operator cannot act on.
    replicaHealth = undefined;
    return;
  }
  const probe = await probeReplica(spliced.url);
  replicaHealth = probe.ok
    ? {
      streaming: probe.receiverStreaming === true,
      inRecovery: probe.inRecovery === true,
      replayAgeMs: probe.replayAgeMs ?? null,
    }
    : { streaming: false, inRecovery: false, replayAgeMs: null, error: probe.error };
  // Settings, not state: the last good read stays valid while the standby is
  // down, which is exactly when a pushed "lost" must still find its slot.
  // The source read can fail on its own (a superuser-only setting, a timeout
  // after the probe answered), so a known endpoint is kept rather than replaced
  // by "unknown" for an interval.
  if (probe.ok) {
    localIdentity = {
      slotName: probe.slotName ?? localIdentity?.slotName ?? null,
      sourceHost: probe.sourceHost ?? localIdentity?.sourceHost ?? null,
      sourcePort: probe.sourcePort ?? localIdentity?.sourcePort ?? null,
      sourceAt: probe.sourceHost ? Date.now() : localIdentity?.sourceAt ?? 0,
    };
  }
  try { probeListener?.(replicaHealth); } catch { /* a listener fault never blocks the sampler */ }
}

const STANDBY_SQL = `
  SELECT client_addr::text AS client_addr,
         state,
         EXTRACT(EPOCH FROM replay_lag) AS replay_lag_seconds
    FROM pg_stat_replication`;

async function sampleStandbyLinks(): Promise<void> {
  const backend = getGuildDataBackend();
  if (!backend || backend.kind !== 'postgres' || !backend.healthy()) return;
  try {
    const rows = (await (backend as PostgresBackend).getPool().query(STANDBY_SQL)).rows;
    standbyLinks = rows.map(row => ({
      clientAddr: String(row.client_addr || ''),
      state: String(row.state || ''),
      replayLagSeconds: row.replay_lag_seconds === null || row.replay_lag_seconds === undefined
        ? null
        : Number(row.replay_lag_seconds),
    }));
  } catch {
    // A read that fails says nothing about the link; the backend's own health
    // reporting already covers an unreachable database.
  }
}

// Retained WAL is measured only where WAL is written: on a database in
// recovery pg_current_wal_lsn() would raise instead of answering.
const SLOT_SQL = `
  SELECT slot_name,
         active,
         wal_status,
         restart_lsn::text AS restart_lsn,
         CASE WHEN restart_lsn IS NULL OR pg_is_in_recovery() THEN NULL
              ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) END AS retained_bytes
    FROM pg_replication_slots
   WHERE slot_type = 'physical'`;

async function sampleSlotTable(): Promise<void> {
  const backend = getGuildDataBackend();
  if (!backend || backend.kind !== 'postgres' || !backend.healthy()) return;
  try {
    const rows = (await (backend as PostgresBackend).getPool().query(SLOT_SQL)).rows;
    slotSample = {
      observedAt: Date.now(),
      slots: rows.map(row => ({
        slotName: String(row.slot_name || ''),
        active: row.active === true,
        // NULL until a standby first attaches (no restart position yet).
        walStatus: row.wal_status === null || row.wal_status === undefined ? 'unused' : String(row.wal_status),
        retainedBytes: row.retained_bytes === null || row.retained_bytes === undefined
          ? null
          : Number(row.retained_bytes),
        restartLsn: row.restart_lsn === null || row.restart_lsn === undefined ? null : String(row.restart_lsn),
      })),
    };
  } catch {
    // Same rule as the link read: a failed read says nothing about the slots.
  }
}

/** Idempotent; called from the heartbeat builder and the master's state builder. */
export function startReplicaHealthSampler(): void {
  if (samplerStarted) return;
  samplerStarted = true;
  const sample = async (): Promise<void> => {
    await sampleLocalReplica().catch(() => { /* reported through the probe result */ });
    await sampleStandbyLinks();
    await sampleSlotTable();
  };
  void sample();
  setInterval(() => void sample(), SAMPLE_MS).unref();
}
