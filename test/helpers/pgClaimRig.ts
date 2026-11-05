import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { expect } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { ClaimStore, type Heartbeat } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type Me } from '../../src/bot/internalSetup/fleet/claimRules';
import { poolFor, startPostgres } from './postgres';

// NB4's real-Postgres rig: one provisioned database, claim stores per process, and direct moves of the claim clock
// (ticked_at set back stands for time passing between ticks, so no test waits for a TTL).

export const TIMINGS = claimTimings(30);
export const me = (name: string): Me => ({ processId: `p-${name}`, nodeId: `n-${name}`, nodeName: name.toUpperCase() });
export const heartbeat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: Date.now(), ...over,
});

export interface ClaimRig {
  container: StartedPostgreSqlContainer;
  direct: Pool;
  url: string;
  backend: PostgresBackend;
  stores: ClaimStore[];
  store(): ClaimStore;
  /** Moves the database time of the last tick back, as if ms passed with no tick. */
  idle(ms: number): Promise<void>;
  clock(): Promise<{ upMs: number; lastGapMs: number }>;
  row(shardId: number, count?: number): Promise<any>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startClaimRig(): Promise<ClaimRig> {
  const container = await startPostgres();
  const direct = poolFor(container);
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  const url = `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const backend = new PostgresBackend({ url });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  const stores: ClaimStore[] = [];
  return {
    container, direct, url, backend, stores,
    store() {
      const s = new ClaimStore(url, TIMINGS);
      stores.push(s);
      return s;
    },
    async idle(ms) {
      await direct.query(`UPDATE smdb_data.claim_clock SET ticked_at = ticked_at - make_interval(secs => $1::float8 / 1000)`, [ms]);
    },
    async clock() {
      const r = (await direct.query(`SELECT up_ms::text AS up, last_gap_ms::text AS gap FROM smdb_data.claim_clock`)).rows[0];
      return { upMs: Number(r.up), lastGapMs: Number(r.gap) };
    },
    async row(shardId, count) {
      return (await direct.query(`SELECT *, claim::text AS claim_text, expires_up_ms::text AS exp FROM smdb_data.shard_claims WHERE shard_id = $1 AND ($2::int IS NULL OR shard_count = $2)`, [shardId, count ?? null])).rows[0];
    },
    async reset() {
      await direct.query(`DELETE FROM smdb_data.shard_claims`);
      await direct.query(`DELETE FROM smdb_data.shard_nodes`);
      await direct.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
      await direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 0, ticked_at = now(), last_gap_ms = 0`);
    },
    async stop() {
      for (const s of stores) await s.end();
      await backend.stop();
      await direct.end();
      await container.stop();
    },
  };
}
