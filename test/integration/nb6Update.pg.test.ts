import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dmA from '../../src/bot/internalSetup/utils/dataManager';
import * as storeA from '../../src/bot/internalSetup/utils/sharedStore';
import * as kindA from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { backendOn, pause } from '../helpers/nb6Pg';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB6 test 22 [pg] (wip-redesign/sheets/NB6.md row 22, decision 5): two processes each run updateGlobalData 100 times
// on one counter; every update lands once, so the row ends at 200. The second process is a second load of the data
// layer (vi.resetModules) with a data pool of its own; both share the test's /data, as two processes on one machine.

const CATEGORY = 'nb6update';
const KEY = `global/${CATEGORY}/counter.json`;

let rig: ClaimRig;
let backendB: PostgresBackend;
let dmB: typeof dmA;
let storeB: typeof storeA;
let kindB: typeof kindA;

beforeAll(async () => {
  rig = await startClaimRig();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  dmA.setGuildDataBackend(rig.backend);
  backendB = await backendOn(rig.url);
  vi.resetModules();
  kindB = await import('../helpers/backendKind');
  dmB = await import('../../src/bot/internalSetup/utils/dataManager');
  storeB = await import('../../src/bot/internalSetup/utils/sharedStore');
  dmB.setGuildDataBackend(backendB);
}, 180_000);

// setup.ts's beforeEach sets the backend kind back to none before each row; both loads take Postgres after it.
beforeEach(() => {
  kindA.setBackendKind('postgres');
  kindB.setBackendKind('postgres');
});

afterAll(async () => {
  dmA.setGuildDataBackend(null);
  dmB?.setGuildDataBackend(null);
  await backendB?.stop();
  await rig?.stop();
  vi.restoreAllMocks();
});

const inc = (v: { n: number }) => ({ n: v.n + 1 });

describe('row 22: both processes update the key at once', () => {
  it('ends at 200', async () => {
    const file = dataPath('global', CATEGORY, 'counter.json');
    expect(storeA.sharedKeyOf(file)).toBe(KEY);
    expect(storeB.sharedKeyOf(file)).toBe(KEY);
    for (let i = 0; i < 100; i++) {
      expect(dmA.updateGlobalData('counter.json', { n: 0 }, inc, CATEGORY).outcome).toBe('saved');
      expect(dmB.updateGlobalData('counter.json', { n: 0 }, inc, CATEGORY).outcome).toBe('saved');
      if (i % 7 === 0) await Promise.all([dmA.flushAll(), dmB.flushAll()]);
    }
    const until = Date.now() + 120_000;
    while ((storeA.rowQueue.keys().length > 0 || storeB.rowQueue.keys().length > 0) && Date.now() < until) {
      await Promise.all([dmA.flushAll(), dmB.flushAll()]);
      await pause(25);
    }
    expect(storeA.rowQueue.keys()).toEqual([]);
    expect(storeB.rowQueue.keys()).toEqual([]);
    const stored = (await rig.direct.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', [KEY])).rows[0];
    expect(JSON.parse(stored.body.toString('utf8'))).toEqual({ n: 200 });
  }, 180_000);
});
