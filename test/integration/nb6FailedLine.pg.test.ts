import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 owner question 1's App Store tab line [pg] (wip-redesign/sheets/NB6.md row 63 in test 10, row 214; part 26c):
// on real Postgres, the status rows written by moduleApply.ts's MODULE_STATUS_SQL and the module row written by
// publishModule's manifest statement, read by the App Store routes on the web UI's reader through useWebuiSessions.

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...real, fork, default: { ...real, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: () => undefined, on: () => undefined, off: () => undefined }),
}));

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { MODULE_STATUS_SQL } from '../../src/bot/internalSetup/utils/moduleApply';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

const SHA_1 = 'a'.repeat(64);
const SHA_2 = 'b'.repeat(64);
const MODULE_UPSERT_SQL = `INSERT INTO smdb_data.shared_modules (module, sha, rev, version, file_count, bytes, updated_by)
  VALUES ($1, $2, nextval('smdb_data.shared_rev_seq'), $3, $4, $5, $6)
  ON CONFLICT (module) DO UPDATE SET sha = EXCLUDED.sha, rev = EXCLUDED.rev, version = EXCLUDED.version,
    file_count = EXCLUDED.file_count, bytes = EXCLUDED.bytes, updated_at = now(), updated_by = EXCLUDED.updated_by`;

let rig: ClaimRig;
let manager: BotManager;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

beforeEach(async () => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  dm.setSharedWriteGate(inLocalOp);
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  for (const table of ['shared_module_status', 'shared_modules', 'shared_docs']) await rig.direct.query(`DELETE FROM smdb_data.${table}`);
  manager = new BotManager();
  useWebuiSessions({
    target: async () => ({ entry: rig.url, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => ({ rows: (await rig.direct.query(text, values as unknown[])).rows }),
    tag: () => '1:ALPHA',
  });
});

afterEach(async () => {
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  vi.restoreAllMocks();
});

async function installed(): Promise<any> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/installed' && l.route.methods.get);
  let body: any;
  const res = { status() { return res; }, json(b: unknown) { body = b; return res; } };
  await layer!.route!.stack[0].handle({ params: {}, body: {}, query: {} }, res);
  return body;
}

const status = (module: string, node: string, sha: string, state: string, error: string | null, seq: number) =>
  rig.direct.query(MODULE_STATUS_SQL, [module, `id-${node}`, node, sha, state, error, `2026-11-08T04:0${seq}:00.000Z`, `p-${node}`, seq]);

describe('the App Store tab line on real Postgres', () => {
  it("lists each machine whose row says failed, with the module row's version or the sha, until a version loads there", async () => {
    await rig.direct.query(MODULE_UPSERT_SQL, ['m', SHA_2, '2.0.0', 1, 10, 'ALPHA/p-ALPHA']);
    await status('m', 'BRAVO', SHA_2, 'failed', "Cannot find module './missing'", 1);
    await status('m', 'CHARLIE', SHA_1, 'failed', 'boom', 1);
    await status('m', 'ALPHA', SHA_2, 'applied', null, 1);
    expect((await installed()).moduleFailures).toEqual([
      { module: 'm', version: '2.0.0', machine: 'BRAVO', error: "Cannot find module './missing'" },
      { module: 'm', version: SHA_1, machine: 'CHARLIE', error: 'boom' },
    ]);
    await status('m', 'BRAVO', SHA_2, 'applied', null, 2);
    expect((await installed()).moduleFailures).toEqual([{ module: 'm', version: SHA_1, machine: 'CHARLIE', error: 'boom' }]);
  });
});
