import fs from 'fs';
import vm from 'vm';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 owner question 1's App Store tab line (wip-redesign/sheets/NB6.md 404-409, 505's row 63 and 2773's row 214 in
// test 10, 2030's row 145 in test 49; part 26c): on a Postgres bot the App Store tab on every machine shows "<module>
// <version> failed to load on <machine>: <error>" for each machine whose shared_module_status row says 'failed', until
// a version loads there. The status rows are written by moduleApply.ts's own MODULE_STATUS_SQL with the values its
// sendStatus sends, and deleted by sharedModules.ts's unpublish statement, through helpers/sharedRows.ts; the module
// list is read through the real App Store routes on the web UI's reader pool.

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const { fakeFork } = await import('../helpers/forkMock');
  const { offlineExecSync } = await import('../helpers/offlineStore');
  const fork = vi.fn(() => fakeFork());
  const execSync = offlineExecSync(real.execSync);
  return { ...real, fork, execSync, default: { ...real, fork, execSync } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
// Its providers load by require, which this suite does not resolve; no row here takes a payment.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: () => undefined, on: () => undefined, off: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { MODULE_STATUS_SQL } from '../../src/bot/internalSetup/utils/moduleApply';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { forks } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { exitChild, freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { readSourceText } from '../helpers/sourceText';
import { remoteGit, seedStoreClone } from '../helpers/offlineStore';

const A = 'postgres://bot@db:5432/bot';
const SHA_1 = 'a'.repeat(64);
const SHA_2 = 'b'.repeat(64);

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let selects: string[];
let client = 500;

beforeEach(() => {
  selects = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
  remoteGit.length = 0;
  seedStoreClone();
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  dm.setSharedWriteGate(inLocalOp);
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  manager = new BotManager();
  s = webuiSessions();
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      selects.push(text);
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
    session: config => s.session(config as Record<string, unknown>),
  });
});

afterEach(async () => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
  expect(remoteGit).toEqual([]);
});

/** One route of the App Store router, called as express calls it. */
async function route(at: string): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === at && l.route.methods.get);
  let status = 200;
  let body: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { body = b; return res; } };
  await layer!.route!.stack[0].handle({ params: {}, body: {}, query: {} }, res);
  return { status, body };
}

/** One committed transaction of statements on a client of its own, as another process sends it. */
async function committed(...statements: Array<[string, unknown[]]>): Promise<void> {
  client += 1;
  await s.rows.answer('BEGIN', [], 0, client);
  for (const [text, values] of statements) await s.rows.answer(text, values, 0, client);
  await s.rows.answer('COMMIT', [], 0, client);
}

/** The status upsert a machine's applyModuleChange sends (moduleApply.ts sendStatus's values). */
const status = (module: string, node: string, sha: string, state: 'applied' | 'failed', error: string | null, seq: number, processId = `p-${node}`): [string, unknown[]] =>
  [MODULE_STATUS_SQL, [module, `id-${node}`, node, sha, state, error, `2026-11-08T04:0${seq}:00.000Z`, processId, seq]];

/** The module row publishModule's manifest upsert stores (helpers/sharedRows.ts's model of it). */
const moduleRow = (module: string, sha: string, version: string | null): [string, unknown[]] =>
  [`INSERT INTO smdb_data.shared_modules (module, sha, rev, version, file_count, bytes, updated_by)
  VALUES ($1, $2, nextval('smdb_data.shared_rev_seq'), $3, $4, $5, $6)
  ON CONFLICT (module) DO UPDATE SET sha = EXCLUDED.sha, rev = EXCLUDED.rev, version = EXCLUDED.version,
    file_count = EXCLUDED.file_count, bytes = EXCLUDED.bytes, updated_at = now(), updated_by = EXCLUDED.updated_by`, [module, sha, version, 1, 10, 'ALPHA/p-ALPHA']];

function panel(): Record<string, any> {
  const code = transformSync(readSourceText(__dirname, '../../src/webui/public/components/AppStorePanel.jsx'), {
    presets: [[presetReact, { runtime: 'classic' }]], babelrc: false, configFile: false,
  })!.code!;
  const ctx: Record<string, any> = { React: { useState: () => [], useEffect: () => {}, useRef: () => ({}) }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

describe("row 63: a version that failed to load on a machine (test 10)", () => {
  it('the module list names each machine whose status row says failed, with the version and the error', async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_2, 'failed', "Cannot find module './missing'", 1));
    await committed(status('m', 'ALPHA', SHA_2, 'applied', null, 1));
    const answer = await route('/bundle');
    expect(answer.status).toBe(200);
    expect(answer.body.success).toBe(true);
    expect(answer.body.moduleFailures).toEqual([{ module: 'm', version: '2.0.0', machine: 'BRAVO', error: "Cannot find module './missing'" }]);
  });

  it('the App Store tab shows the line word for word', () => {
    expect(panel().appStoreFailureLines([
      { module: 'm', version: '2.0.0', machine: 'BRAVO', error: "Cannot find module './missing'" },
      { module: 'n', version: '1.1.0', machine: 'CHARLIE', error: 'boom' },
    ])).toEqual([
      "m 2.0.0 failed to load on BRAVO: Cannot find module './missing'",
      'n 1.1.0 failed to load on CHARLIE: boom',
    ]);
  });

  it('no failure, no line (guard)', () => {
    expect(panel().appStoreFailureLines(undefined)).toEqual([]);
    expect(panel().appStoreFailureLines([])).toEqual([]);
  });

  it('a status row of a version the module row no longer holds names that version by its sha', async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_1, 'failed', 'boom', 1));
    expect((await route('/bundle')).body.moduleFailures).toEqual([{ module: 'm', version: SHA_1, machine: 'BRAVO', error: 'boom' }]);
  });

  it('the installed list answers the same lines', async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_2, 'failed', 'boom', 1));
    const answer = await route('/installed');
    expect(answer.status).toBe(200);
    expect(answer.body.moduleFailures).toEqual([{ module: 'm', version: '2.0.0', machine: 'BRAVO', error: 'boom' }]);
  });
});

describe('row 145: the version fails on the publishing machine (test 49, the tab half)', () => {
  it('the publishing machine is listed like any other', async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'ALPHA', SHA_2, 'failed', 'boom', 1));
    await committed(status('m', 'BRAVO', SHA_2, 'failed', 'bang', 1));
    expect((await route('/bundle')).body.moduleFailures).toEqual([
      { module: 'm', version: '2.0.0', machine: 'ALPHA', error: 'boom' },
      { module: 'm', version: '2.0.0', machine: 'BRAVO', error: 'bang' },
    ]);
  });
});

describe('until a version loads there', () => {
  it("row 214: 'applied' after an older 'failed' row of this machine replaces it, and the tab stops listing the machine", async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_1, 'failed', 'boom', 1));
    expect((await route('/bundle')).body.moduleFailures).toHaveLength(1);
    await committed(status('m', 'BRAVO', SHA_2, 'applied', null, 2));
    expect((await route('/bundle')).body.moduleFailures).toEqual([]);
  });

  it("the module's uninstall deletes its status rows, and the tab stops listing it", async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_2, 'failed', 'boom', 1));
    await committed(['DELETE FROM smdb_data.shared_module_status WHERE module = $1', ['m']]);
    expect((await route('/bundle')).body.moduleFailures).toEqual([]);
  });
});

describe('a read that fails, and a JSON bot', () => {
  it('a status read that fails leaves the list as it was and answers its cause (lane C finding 5)', async () => {
    await committed(moduleRow('m', SHA_2, '2.0.0'));
    await committed(status('m', 'BRAVO', SHA_2, 'failed', 'boom', 1));
    s.rows.fault = sql => (/shared_module_status/.test(sql) && sql.startsWith('SELECT') ? new Error('connect ECONNREFUSED 10.0.0.1:5432') : undefined);
    const answer = await route('/bundle');
    expect(answer.status).toBe(200);
    expect(answer.body.success).toBe(true);
    expect(Array.isArray(answer.body.installed)).toBe(true);
    expect('moduleFailures' in answer.body).toBe(false);
    expect(answer.body.moduleFailuresUnread).toBe('connect ECONNREFUSED 10.0.0.1:5432');
  });

  it('a JSON bot reads no status and answers as before (guard)', async () => {
    setBackendKind('file');
    const answer = await route('/bundle');
    expect(answer.status).toBe(200);
    expect('moduleFailures' in answer.body).toBe(false);
    expect('moduleFailuresUnread' in answer.body).toBe(false);
    expect(selects).toEqual([]);
  });
});
