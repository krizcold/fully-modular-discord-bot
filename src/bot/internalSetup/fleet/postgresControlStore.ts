// PostgresControlStore - the durable control plane for multi-host fleets.
// Every mutating call is term-fenced: the write commits only if the term row
// still names this master's minted term. A fence trip means two masters share
// one schema; the store latches fenced, fires onFenced, and refuses further
// writes (the higher-term master is the healthy one).

import { Pool, PoolClient } from 'pg';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import { getGuildDataBackend } from '../utils/dataManager';
import { PostgresBackend } from '../utils/dataBackends/postgresBackend';
import { FileControlStore } from './fileControlStore';
import type {
  ControlStore,
  PersistedMigrations,
  PersistedPlan,
  PersistedRegistry,
  PersistedTerm,
  RedistributeProposal,
  ReshardArchive,
  ReshardMarker,
} from './controlStore';

const ACQUIRE_RETRY_BASE_MS = 1000;
const ACQUIRE_RETRY_CAP_MS = 30_000;

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
  // Postgres default with no live backend (refused boot): the file store keeps
  // the master process alive so the web UI can serve the diagnosis.
  console.error('[Fleet] Postgres control store unavailable (data backend not constructed); falling back to the embedded file store');
  return new FileControlStore();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
