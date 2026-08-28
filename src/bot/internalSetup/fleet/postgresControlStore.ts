// PostgresControlStore - the durable control plane for multi-host fleets.
// Every mutating call is term-fenced: the write commits only if the term row
// still names this master's minted term. A fence trip means two masters share
// one schema; the store latches fenced, fires onFenced, and refuses further
// writes (the higher-term master is the healthy one).

import * as fs from 'fs';
import { Client, Pool, PoolClient } from 'pg';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import { dataPath } from '../../../utils/dataRoot';
import { getGuildDataBackend } from '../utils/dataManager';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { FileControlStore, atomicWriteFileSync } from './fileControlStore';
import { FLEET_DIR } from './constants';
import type {
  ControlStore,
  PersistedMigrations,
  PersistedPlan,
  PersistedRegistry,
  PersistedTerm,
  RedistributeProposal,
  ReshardArchive,
  ReshardMarker,
  TransformationRecord,
} from './controlStore';

const ACQUIRE_RETRY_BASE_MS = 1000;
const ACQUIRE_RETRY_CAP_MS = 30_000;
const SEED_RETRY_MS = 5000;

// While it exists, the control plane lives in smdb_control; a file-mode boot
// that finds it must export the documents back before serving.
const MOVED_SENTINEL = () => dataPath('global', FLEET_DIR, 'control-store-moved.json');

const DOC_NAMES = ['plan', 'registry', 'migrations', 'reshard-pending', 'redistribute-proposal', 'transformation'] as const;

const CONTROL_DDL = [
  `CREATE SCHEMA IF NOT EXISTS smdb_control`,
  `CREATE TABLE IF NOT EXISTS smdb_control.term (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    term bigint NOT NULL,
    node_id text NOT NULL,
    updated_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_control.docs (
    name text PRIMARY KEY,
    body text NOT NULL,
    updated_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_control.plan_archive (
    id bigserial PRIMARY KEY,
    from_count int NOT NULL,
    to_count int NOT NULL,
    archived_at bigint NOT NULL,
    body text NOT NULL
  )`,
];

export class PostgresControlStore implements ControlStore {
  private provisioned = false;
  private mintedTerm: number | null = null;
  private fenced = false;
  private fencedCb: ((observedTerm: number) => void) | null = null;

  constructor(private readonly pool: Pool) {}

  /** Fires once when a mutating call observes a foreign term (two masters on one schema). */
  onFenced(cb: (observedTerm: number) => void): void {
    this.fencedCb = cb;
  }

  isFenced(): boolean {
    return this.fenced;
  }

  private async ensureProvisioned(client: PoolClient): Promise<void> {
    if (this.provisioned) return;
    await client.query(`SELECT pg_advisory_lock(hashtext('smdb_control_bootstrap'))`);
    try {
      for (const statement of CONTROL_DDL) {
        await client.query(statement);
      }
      this.provisioned = true;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('smdb_control_bootstrap'))`);
    }
  }

  /**
   * CAS term acquisition; the floor is seeded from guild_ownership so a fresh
   * control schema on an existing data store can never mint a stale term.
   * Unreachable store: infinite backoff (master boot waits, never crashes).
   */
  async acquireTerm(nodeId: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect().catch(() => null);
      if (client) {
        try {
          await this.ensureProvisioned(client);
          let floor = 0;
          try {
            const res = await client.query(`SELECT COALESCE(MAX(term), 0) AS floor FROM smdb_data.guild_ownership`);
            floor = Number(res.rows[0]?.floor) || 0;
          } catch { /* separate control instance: no data schema to seed from */ }
          const res = await client.query(
            `INSERT INTO smdb_control.term AS t (id, term, node_id, updated_at)
             VALUES (1, $1 + 1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET term = t.term + 1, node_id = $2, updated_at = $3
             RETURNING term`,
            [floor, nodeId, Date.now()]);
          const term = Number(res.rows[0].term);
          this.mintedTerm = term;
          return term;
        } catch (error) {
          console.warn('[Fleet] Waiting on control store for term acquisition:', error instanceof Error ? error.message : error);
        } finally {
          client.release();
        }
      } else if (attempt === 0) {
        console.warn('[Fleet] Waiting on control store for term acquisition (unreachable)');
      }
      const ceiling = Math.min(ACQUIRE_RETRY_CAP_MS, ACQUIRE_RETRY_BASE_MS * 2 ** attempt);
      await sleep(Math.floor(ceiling / 2 + Math.random() * (ceiling / 2)));
    }
  }

  async getTerm(): Promise<PersistedTerm | null> {
    const client = await this.pool.connect();
    try {
      await this.ensureProvisioned(client);
      const res = await client.query(`SELECT term, node_id, updated_at FROM smdb_control.term WHERE id = 1`);
      if (res.rows.length === 0) return null;
      return { term: Number(res.rows[0].term), nodeId: res.rows[0].node_id, updatedAt: Number(res.rows[0].updated_at) };
    } finally {
      client.release();
    }
  }

  // Local-clock start of the current unbroken run of failed stamps; null while
  // stamping succeeds. Feeds the fleet-state stamp-health banner.
  private stampFailingSince: number | null = null;

  getStampFailingForMs(): number | null {
    return this.stampFailingSince === null ? null : Date.now() - this.stampFailingSince;
  }

  /**
   * Term liveness stamp (PLAN_STANDBY 3.1): touch updated_at under the minted
   * term. Zero rows updated means a newer master owns the schema - latch the
   * fence NOW instead of waiting for the next document write, so a deposed
   * master learns of its deposition within one stamp interval.
   */
  async stampTerm(): Promise<void> {
    if (this.fenced || this.mintedTerm === null) return;
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
    } catch {
      this.noteStampFailure();
      return;
    }
    try {
      const res = await client.query(
        `UPDATE smdb_control.term SET updated_at = $1 WHERE id = 1 AND term = $2`,
        [Date.now(), this.mintedTerm]);
      if ((res.rowCount ?? 0) === 0) {
        let observed = -1;
        try {
          const cur = await client.query(`SELECT term FROM smdb_control.term WHERE id = 1`);
          observed = cur.rows.length > 0 ? Number(cur.rows[0].term) : -1;
        } catch { /* fence with the term unknown */ }
        this.stampFailingSince = null;
        this.fenced = true;
        console.error(`[Fleet] CONTROL STORE FENCED (liveness stamp): term row holds ${observed}, this master minted ${this.mintedTerm}; a second master owns this schema`);
        this.fencedCb?.(observed);
        return;
      }
      this.stampFailingSince = null;
    } catch {
      this.noteStampFailure();
    } finally {
      client?.release();
    }
  }

  private noteStampFailure(): void {
    if (this.stampFailingSince === null) this.stampFailingSince = Date.now();
  }

  /**
   * File -> postgres control-plane move, run BEFORE acquireTerm on a
   * non-standalone postgres-mode master boot. Gated on FRESHNESS, not row
   * absence: whenever the file-store term exceeds the control-store term the
   * whole document set is mirrored in verbatim (stale rows with no file
   * counterpart are deleted, so an obsolete era can never resurrect). The
   * moved sentinel is ensured either way. Holds with backoff while the
   * database cannot be asked or a file document is unreadable.
   */
  async seedFromFileStore(): Promise<void> {
    const fileStore = new FileControlStore();
    for (let logged = false; ; ) {
      const client = await this.pool.connect().catch(() => null);
      if (client) {
        try {
          await this.ensureProvisioned(client);
          const fileTerm = (await fileStore.getTerm())?.term ?? 0;
          const res = await client.query(`SELECT term FROM smdb_control.term WHERE id = 1`);
          const pgTerm = res.rows.length > 0 ? Number(res.rows[0].term) : 0;
          if (fileTerm > pgTerm) {
            const marker = await fileStore.loadReshardMarker();
            if (marker === 'corrupt') {
              throw new Error('reshard-pending.json is unreadable; refusing to seed past an unreadable pause marker');
            }
            const docs: Record<string, string | null> = {
              'plan': jsonOrNull(await fileStore.loadPlan()),
              'registry': jsonOrNull(await fileStore.loadRegistry()),
              'migrations': jsonOrNull(await fileStore.loadMigrations()),
              'reshard-pending': jsonOrNull(marker),
              'redistribute-proposal': jsonOrNull(await fileStore.loadRedistributeProposal()),
              'transformation': jsonOrNull(await fileStore.loadTransformation()),
            };
            await client.query('BEGIN');
            const now = Date.now();
            const fileTermRow = await fileStore.getTerm();
            await client.query(
              `INSERT INTO smdb_control.term (id, term, node_id, updated_at) VALUES (1, $1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET term = EXCLUDED.term, node_id = EXCLUDED.node_id, updated_at = EXCLUDED.updated_at`,
              [fileTerm, fileTermRow?.nodeId ?? 'seed', now]);
            for (const name of DOC_NAMES) {
              const body = docs[name];
              if (body === null) {
                await client.query(`DELETE FROM smdb_control.docs WHERE name = $1`, [name]);
              } else {
                await client.query(
                  `INSERT INTO smdb_control.docs (name, body, updated_at) VALUES ($1, $2, $3)
                   ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
                  [name, body, now]);
              }
            }
            await client.query(`DELETE FROM smdb_control.docs WHERE name = 'superseded'`);
            await client.query('COMMIT');
            console.log(`[Fleet] Control store seeded from files (term ${fileTerm} over ${pgTerm})`);
          }
          if (!fs.existsSync(MOVED_SENTINEL())) {
            atomicWriteFileSync(MOVED_SENTINEL(), JSON.stringify({ movedAt: Date.now() }, null, 2));
          }
          return;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => { /* not in a txn */ });
          console.warn('[Fleet] Control-store seeding failed; retrying:', error instanceof Error ? error.message : error);
        } finally {
          client.release();
        }
      } else if (!logged) {
        console.warn('[Fleet] Waiting on control store to seed from files (unreachable)');
        logged = true;
      }
      await sleep(SEED_RETRY_MS);
    }
  }

  /** Term-fenced transaction wrapper: commit only under this master's minted term. */
  private async fencedWrite(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    if (this.fenced) throw new Error('[Fleet] Control store is fenced (another master holds the term); write refused');
    if (this.mintedTerm === null) throw new Error('[Fleet] Control store write before term acquisition');
    const client = await this.pool.connect();
    let inTxn = false;
    try {
      await this.ensureProvisioned(client);
      await client.query('BEGIN');
      inTxn = true;
      const res = await client.query(`SELECT term FROM smdb_control.term WHERE id = 1`);
      const observed = res.rows.length > 0 ? Number(res.rows[0].term) : -1;
      if (observed !== this.mintedTerm) {
        await client.query('ROLLBACK');
        inTxn = false;
        this.fenced = true;
        console.error(`[Fleet] CONTROL STORE FENCED: term row holds ${observed}, this master minted ${this.mintedTerm}; a second master owns this schema`);
        this.fencedCb?.(observed);
        throw new Error('[Fleet] Control store is fenced (another master holds the term); write refused');
      }
      await fn(client);
      await client.query('COMMIT');
      inTxn = false;
    } catch (error) {
      if (inTxn) {
        await client.query('ROLLBACK').catch(() => client.release(true));
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertDoc(client: PoolClient, name: string, body: string): Promise<void> {
    await client.query(
      `INSERT INTO smdb_control.docs (name, body, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
      [name, body, Date.now()]);
  }

  private async readDoc(name: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await this.ensureProvisioned(client);
      const res = await client.query(`SELECT body FROM smdb_control.docs WHERE name = $1`, [name]);
      return res.rows.length > 0 ? res.rows[0].body : null;
    } finally {
      client.release();
    }
  }

  private async deleteDoc(name: string): Promise<void> {
    await this.fencedWrite(client => client.query(`DELETE FROM smdb_control.docs WHERE name = $1`, [name]).then(() => undefined));
  }

  async savePlan(plan: PersistedPlan): Promise<void> {
    await this.fencedWrite(client => this.upsertDoc(client, 'plan', JSON.stringify(plan)));
  }

  async loadPlan(): Promise<PersistedPlan | null> {
    const body = await this.readDoc('plan');
    if (body === null) return null;
    try { return JSON.parse(body) as PersistedPlan; } catch { return null; }
  }

  async saveRegistry(registry: PersistedRegistry): Promise<void> {
    await this.fencedWrite(client => this.upsertDoc(client, 'registry', JSON.stringify(registry)));
  }

  async loadRegistry(): Promise<PersistedRegistry> {
    let parsed: PersistedRegistry | null = null;
    const body = await this.readDoc('registry');
    if (body !== null) {
      try { parsed = JSON.parse(body) as PersistedRegistry; } catch { parsed = null; }
    }
    return {
      nodes: Array.isArray(parsed?.nodes) ? parsed!.nodes! : [],
      lostNodes: Array.isArray(parsed?.lostNodes) ? parsed!.lostNodes! : undefined,
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  }

  async archivePlan(archive: ReshardArchive): Promise<string> {
    let ref = '';
    await this.fencedWrite(async client => {
      const res = await client.query(
        `INSERT INTO smdb_control.plan_archive (from_count, to_count, archived_at, body)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [archive.from, archive.to, archive.archivedAt, JSON.stringify(archive)]);
      ref = `pg:plan_archive/${res.rows[0].id}`;
    });
    return ref;
  }

  /** Fail-closed parity: null ONLY on a successful query with no row; any error is 'corrupt' (still a pause). */
  async loadReshardMarker(): Promise<ReshardMarker | 'corrupt' | null> {
    let body: string | null;
    try {
      body = await this.readDoc('reshard-pending');
    } catch {
      return 'corrupt';
    }
    if (body === null) return null;
    try {
      return JSON.parse(body) as ReshardMarker;
    } catch {
      return 'corrupt';
    }
  }

  async saveReshardMarker(marker: ReshardMarker): Promise<void> {
    await this.fencedWrite(client => this.upsertDoc(client, 'reshard-pending', JSON.stringify(marker)));
  }

  async clearReshardMarker(): Promise<void> {
    await this.deleteDoc('reshard-pending');
  }

  async saveMigrations(state: PersistedMigrations): Promise<void> {
    await this.fencedWrite(client => this.upsertDoc(client, 'migrations', JSON.stringify(state)));
  }

  async loadMigrations(): Promise<PersistedMigrations> {
    let parsed: PersistedMigrations | null = null;
    const body = await this.readDoc('migrations');
    if (body !== null) {
      try { parsed = JSON.parse(body) as PersistedMigrations; } catch { parsed = null; }
    }
    return {
      active: parsed?.active ?? null,
      history: Array.isArray(parsed?.history) ? parsed!.history! : [],
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  }

  async saveRedistributeProposal(proposal: RedistributeProposal | null): Promise<void> {
    if (proposal === null) {
      await this.deleteDoc('redistribute-proposal');
      return;
    }
    await this.fencedWrite(client => this.upsertDoc(client, 'redistribute-proposal', JSON.stringify(proposal)));
  }

  async loadRedistributeProposal(): Promise<RedistributeProposal | null> {
    const body = await this.readDoc('redistribute-proposal');
    if (body === null) return null;
    let parsed: RedistributeProposal;
    try { parsed = JSON.parse(body) as RedistributeProposal; } catch { return null; }
    if (!parsed || typeof parsed.proposal !== 'object' || parsed.proposal === null) return null;
    return { proposal: parsed.proposal, updatedAt: Number(parsed.updatedAt) || 0 };
  }

  async saveTransformation(record: TransformationRecord | null): Promise<void> {
    if (record === null) {
      await this.deleteDoc('transformation');
      return;
    }
    await this.fencedWrite(client => this.upsertDoc(client, 'transformation', JSON.stringify(record)));
  }

  async loadTransformation(): Promise<TransformationRecord | null> {
    const body = await this.readDoc('transformation');
    if (body === null) return null;
    let parsed: TransformationRecord;
    try { parsed = JSON.parse(body) as TransformationRecord; } catch { return null; }
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  }
}

/**
 * Single construction site (initMaster). Standalone always embeds the file
 * store; a fleet gets the durable store when the guild-data backend is
 * postgres OR a CONTROL_STORE_URL names one for a multi-host file-mode fleet.
 */
export function createControlStore(standalone: boolean): ControlStore {
  const controlStoreUrl = (loadCredentials().CONTROL_STORE_URL || '').trim();
  let backend: 'file' | 'postgres' = 'file';
  try {
    backend = resolveDataBackend();
  } catch { /* invalid DATA_BACKEND already refused at data boot; keep the file store */ }
  if (standalone || (backend !== 'postgres' && controlStoreUrl === '')) {
    return new FileControlStore();
  }
  if (controlStoreUrl !== '') {
    const pool = new Pool({
      connectionString: controlStoreUrl,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
    });
    // An idle client error must never take the master down.
    pool.on('error', () => { /* surfaced by the next query */ });
    return new PostgresControlStore(pool);
  }
  const dataBackend = getGuildDataBackend();
  if (dataBackend instanceof PostgresBackend) {
    return new PostgresControlStore(dataBackend.getPool());
  }
  // Postgres default with no live backend: an expected state on a
  // transformation-required boot (configured postgres, live file), and on a
  // refused boot the file store keeps the master process alive so the web UI
  // can serve the diagnosis - a warning, not an error.
  console.warn('[Fleet] Postgres control store unavailable (data backend not constructed); falling back to the embedded file store');
  return new FileControlStore();
}

/**
 * Boot-time control-store preparation, run before acquireTerm:
 * - postgres store: freshness-gated seeding from the file store (5.3 step 3).
 * - file store on a non-standalone master with the moved sentinel present:
 *   export the control documents back from smdb_control first (5.3 reverse),
 *   fail-closed - the boot HOLDS on unreachable, empty, or stale postgres.
 */
export async function prepareControlStore(standalone: boolean): Promise<ControlStore> {
  const store = createControlStore(standalone);
  if (store instanceof PostgresControlStore) {
    await store.seedFromFileStore();
  } else if (!standalone && fs.existsSync(MOVED_SENTINEL())) {
    await exportBackToFileStore();
  }
  return store;
}

async function exportBackToFileStore(): Promise<void> {
  const creds = loadCredentials();
  const url = (creds.CONTROL_STORE_URL || '').trim() || (creds.DATA_BACKEND_URL || '').trim();
  const fileStore = new FileControlStore();
  for (let logged = false; ; ) {
    if (!url) {
      if (!logged) {
        console.error('[Fleet] Control store was moved to postgres but no DATA_BACKEND_URL/CONTROL_STORE_URL is set; boot holds until one is restored');
        logged = true;
      }
      await sleep(SEED_RETRY_MS);
      continue;
    }
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      const termRes = await client.query(`SELECT term, node_id, updated_at FROM smdb_control.term WHERE id = 1`);
      const fileTerm = (await fileStore.getTerm())?.term ?? 0;
      // Zero rows or a term below the local files = the same hold as
      // unreachable: a silent no-op copy would delete the sentinel and let
      // the pre-seed file plan resurrect an obsolete topology.
      if (termRes.rows.length === 0 || Number(termRes.rows[0].term) < fileTerm) {
        throw new Error(termRes.rows.length === 0
          ? 'smdb_control carries no term row'
          : `smdb_control term ${termRes.rows[0].term} is below the local file term ${fileTerm}`);
      }
      const docsRes = await client.query(`SELECT name, body FROM smdb_control.docs WHERE name = ANY($1)`, [[...DOC_NAMES]]);
      const bodies = new Map<string, string>(docsRes.rows.map((row: any) => [row.name, row.body]));

      atomicWriteFileSync(dataPath('global', FLEET_DIR, 'term.json'), JSON.stringify({
        term: Number(termRes.rows[0].term),
        nodeId: termRes.rows[0].node_id,
        updatedAt: Number(termRes.rows[0].updated_at),
      }, null, 2));
      const fileFor: Record<string, string> = {
        'plan': 'leases.json',
        'registry': 'registry.json',
        'migrations': 'migrations.json',
        'reshard-pending': 'reshard-pending.json',
        'redistribute-proposal': 'redistribute-proposal.json',
        'transformation': 'transformation.json',
      };
      for (const name of DOC_NAMES) {
        const target = dataPath('global', FLEET_DIR, fileFor[name]);
        const body = bodies.get(name);
        if (body === undefined) {
          try { fs.unlinkSync(target); } catch { /* absent on both sides */ }
        } else {
          atomicWriteFileSync(target, JSON.stringify(JSON.parse(body), null, 2));
        }
      }
      await client.query(
        `INSERT INTO smdb_control.docs (name, body, updated_at) VALUES ('superseded', $1, $2)
         ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify({ at: Date.now() }), Date.now()]);
      fs.unlinkSync(MOVED_SENTINEL());
      console.log('[Fleet] Control store exported back to files; sentinel cleared');
      return;
    } catch (error) {
      if (!logged) {
        console.warn('[Fleet] Control-store export-back holding boot:', error instanceof Error ? error.message : error);
        logged = true;
      }
    } finally {
      await client.end().catch(() => { /* best effort */ });
    }
    await sleep(SEED_RETRY_MS);
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
