import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowCommitOwed, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { backendOn, commitProxy, pause, until, type CommitProxy } from '../helpers/nb6Pg';

// NB6 test 23 [pg] (wip-redesign/sheets/NB6.md row 15 as round 1 rewrote it, decisions 24 and 52): the bot's
// connection is cut by a proxy right after COMMIT is sent; the next attempt waits on the key's lock, finds the id and
// lands, writing nothing again. A second case cuts it before COMMIT reaches the server; the next attempt writes.

const CATEGORY = 'nb6lost';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };

let rig: ClaimRig;
let proxy: CommitProxy;
let backend: PostgresBackend;

beforeAll(async () => {
  rig = await startClaimRig();
  const c = rig.container;
  proxy = await commitProxy(c.getHost(), c.getPort(), c.getUsername(), c.getPassword(), c.getDatabase());
  backend = await backendOn(proxy.url);
}, 180_000);

afterAll(async () => {
  await backend?.stop();
  proxy?.close();
  await rig?.stop();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(backend);
  await until(() => backend.holdWords() === null);
});

afterEach(() => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
});

const save = (name: string, value: unknown) => (dm.saveDataTracked(name, opts, value) as { ticket: unknown }).ticket as RowTicket;
const rowOf = async (key: string) => (await rig.direct.query('SELECT sha, rev::text AS rev FROM smdb_data.shared_docs WHERE key = $1', [key])).rows[0];
const opsCount = async () => Number((await rig.direct.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops')).rows[0].n);

async function settle(ticket: RowTicket): Promise<void> {
  const end = Date.now() + 60_000;
  while (rowTicketState(ticket) === 'open' && Date.now() < end) {
    await dm.flushAll();
    if (rowTicketState(ticket) === 'open') await pause(25);
  }
}

describe('row 15: the connection is cut after COMMIT is sent', () => {
  it('the next attempt finds the id under the lock and lands; the row is written once', async () => {
    proxy.next = 'cut-after';
    const ticket = save('r15.json', { v: 1 });
    await dm.flushAll();
    expect(rowCommitOwed(ticket)).toBe(true);
    const before = await opsCount();
    const stored = await rowOf(keyOf('r15.json'));
    expect(stored).toBeDefined();
    await settle(ticket);
    expect(rowTicketState(ticket)).toBe('landed');
    expect((await rowOf(keyOf('r15.json'))).rev).toBe(stored.rev);
    expect(await opsCount()).toBe(before);
  }, 120_000);
});

describe('the connection is cut before COMMIT reaches the server', () => {
  it('nothing landed: the next attempt finds no id and writes', async () => {
    proxy.next = 'drop';
    const ticket = save('r15b.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(await rowOf(keyOf('r15b.json'))).toBeUndefined();
    await settle(ticket);
    expect(rowTicketState(ticket)).toBe('landed');
    expect(await rowOf(keyOf('r15b.json'))).toBeDefined();
  }, 120_000);
});
