import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';
import { entryOf, probe, provision, setGeneration } from '../helpers/nb5Pg';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB5 section 8 [pg] test 7 (decision 15): switch-notice's verification pass against real databases, the Discord side
// a fake REST. A is a main at generation 2 named M (or 1), W a replaced main at 1.

const TOKEN = 'nb5-token';
const C = '500000000000000001';
const DATE = '2026-11-05T12:00:00.000Z';
let a: StartedPostgreSqlContainer;
let w: StartedPostgreSqlContainer;
let directA: Pool;
let directW: Pool;
let entryA: string;
let entryW: string;
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;

beforeAll(async () => {
  [a, w] = await Promise.all([startPostgres(), startPostgres()]);
  directA = poolFor(a);
  directW = poolFor(w);
  entryA = entryOf(a);
  entryW = entryOf(w);
  await provision(entryA, directA, 'store-nb5');
  await provision(entryW, directW, 'store-nb5');
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(x => x.use('/api/managed', createManagedRoutes({} as BotManager)));
}, 240_000);
afterAll(async () => {
  await app?.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  await directA?.end();
  await directW?.end();
  await Promise.all([a?.stop(), w?.stop()]);
});
beforeEach(async () => {
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 20_000, switchMs: 25_000 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(`${entryA},${entryW}`),
    probe: entries => probe(...entries.map(e => e.raw)),
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => 'store-nb5',
    noticeCheckOff: () => false,
  });
  setBackendKind('postgres');
  await setGeneration(directA, 'M', 2);
  await setGeneration(directW, 'O', 1);
  await directA.query("DELETE FROM smdb_data.meta WHERE key = 'owner_channel'");
  await directW.query("DELETE FROM smdb_data.meta WHERE key = 'owner_channel'");
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setWebuiChoiceDeps(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('the verification against real databases', () => {
  it('a main at 2 named M: the notice is posted', async () => {
    const res = await post({ machine: 'M', generation: 2, date: DATE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, channel: 'none' });
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('a call for 3 before the row is raised answers 409 and posts nothing; raised after, the next call posts', async () => {
    const before = await post({ machine: 'M', generation: 3, date: DATE });
    expect(before.status).toBe(409);
    expect(rest.creates(DM)).toHaveLength(0);
    await setGeneration(directA, 'M', 3);
    const after = await post({ machine: 'M', generation: 3, date: DATE });
    expect(after.status).toBe(200);
    expect(after.body.posted).toBe(true);
  });

  it('a main at 1: 409 for a notice of 2, nothing posted', async () => {
    await setGeneration(directA, 'M', 1);
    await directW.query('DELETE FROM smdb_manager.generation');
    const res = await post({ machine: 'M', generation: 2, date: DATE });
    expect(res.status).toBe(409);
    expect(rest.calls.filter(c => c.method === 'post')).toHaveLength(0);
  });

  it('an owner_channel row on the main: the DM notice first, then the copy in that channel', async () => {
    await directA.query("INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1)", [JSON.stringify(C)]);
    const res = await post({ machine: 'M', generation: 2, date: DATE });
    expect(res.body).toMatchObject({ success: true, posted: true, channel: 'posted' });
    const creates = rest.calls.filter(c => c.method === 'post' && /\/messages$/.test(c.route)).map(c => c.route);
    expect(creates).toEqual([`/channels/${DM}/messages`, `/channels/${C}/messages`]);
  });

  it('the row only on the replaced main at 1: no copy is posted', async () => {
    await directW.query("INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1)", [JSON.stringify(C)]);
    const res = await post({ machine: 'M', generation: 2, date: DATE });
    expect(res.body).toMatchObject({ success: true, posted: true, channel: 'none' });
    expect(rest.creates(C)).toHaveLength(0);
  });
});
