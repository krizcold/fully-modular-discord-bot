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
 *
 * A node with no standby and a fleet that is not replicating both sample
 * nothing and report nothing, which is what keeps this inert for the
 * single-machine deployments R7 leaves untouched.
 */

import { getGuildDataBackend } from '../utils/dataManager';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { probeReplica, resolveReplicaEndpoints, spliceFleetCredentials } from './replicaPromotion';
import type { ReplicaHealthReport } from './protocol';

const SAMPLE_MS = 60_000;

/** One attached standby, from the primary's point of view. */
export interface StandbyLinkView {
  clientAddr: string;
  state: string;
  replayLagSeconds: number | null;
}

let replicaHealth: ReplicaHealthReport | undefined;
let standbyLinks: StandbyLinkView[] | undefined;
let samplerStarted = false;

/** Cached standby view for the heartbeat; undefined when this node has no replica. */
export function getReplicaHealth(): ReplicaHealthReport | undefined {
  return replicaHealth;
}

/** Cached primary view for fleet state; undefined until the first successful read. */
export function getStandbyLinks(): StandbyLinkView[] | undefined {
  return standbyLinks;
}

async function sampleLocalReplica(): Promise<void> {
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) {
    replicaHealth = undefined;
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

/** Idempotent; called from the heartbeat builder and the master's state builder. */
export function startReplicaHealthSampler(): void {
  if (samplerStarted) return;
  samplerStarted = true;
  const sample = async (): Promise<void> => {
    await sampleLocalReplica().catch(() => { /* reported through the probe result */ });
    await sampleStandbyLinks();
  };
  void sample();
  setInterval(() => void sample(), SAMPLE_MS).unref();
}
