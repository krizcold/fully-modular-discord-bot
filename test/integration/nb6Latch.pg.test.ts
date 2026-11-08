import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowCommitOwed, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { poolFor, startPostgres } from '../helpers/postgres';
import { backendOn, commitProxy, pause, type CommitProxy } from '../helpers/nb6Pg';

// NB6 test 40 [pg] (wip-redesign/sheets/NB6.md row 80, decision 24): two databases; NB5's latch rises between a row
// op's COMMIT and its answer, so the answer confirms nothing and the op keeps the attempt's id; after the move, the
// next attempt's landing check runs on the new main, which lacks the id, and the op is written there.

const CATEGORY = 'nb6latch';
const KEY = `global/${CATEGORY}/r80.json`;

let rig: ClaimRig;
let second: StartedPostgreSqlContainer;
let secondUrl: string;
let proxy: CommitProxy;
let backend: PostgresBackend;

beforeAll(async () => {
  rig = await startClaimRig();
  second = await startPostgres();
  secondUrl = `postgres://${encodeURIComponent(second.getUsername())}:${encodeURIComponent(second.getPassword())}@${second.getHost()}:${second.getPort()}/${second.getDatabase()}`;
  const provisioner = await backendOn(secondUrl);
  await provisioner.stop();
  const c = rig.container;
  proxy = await commitProxy(c.getHost(), c.getPort(), c.getUsername(), c.getPassword(), c.getDatabase());
  backend = await backendOn(proxy.url);
}, 240_000);

afterAll(async () => {
  await backend?.stop();
  proxy?.close();
  await second?.stop();
  await rig?.stop();
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(backend);
});

afterEach(() => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
});

describe('row 80: the COMMIT answer arrives after the latch rose', () => {
  it('counts as lost; the check runs on the new main', async () => {
    proxy.next = 'hold';
    const ticket = (dm.saveDataTracked('r80.json', { scope: 'global', category: CATEGORY }, { v: 1 }) as { ticket: unknown }).ticket as RowTicket;
    const flushing = dm.flushAll();
    const until = Date.now() + 20_000;
    while (!rowCommitOwed(ticket) && Date.now() < until) await pause(10);
    await pause(300);
    backend.latch({ kind: 'tie', generation: 2 });
    proxy.release();
    await flushing;
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.unknown).toHaveLength(1);
    const lostId = ticket.op.unknown[0].id;
    expect((await rig.direct.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops WHERE id = $1', [lostId])).rows[0].n).toBe(1);

    const steps = { checkTarget: async () => null, claims: async () => true, settleRetires: async () => true, moved: () => undefined };
    expect(await backend.useDatabase(secondUrl, steps)).toBe(true);
    const settleUntil = Date.now() + 60_000;
    while (rowTicketState(ticket) === 'open' && Date.now() < settleUntil) await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    const pool = poolFor(second);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM smdb_data.shared_docs WHERE key = $1', [KEY])).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops WHERE id = $1', [lostId])).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  }, 180_000);
});
