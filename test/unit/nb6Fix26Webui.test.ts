import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 fix of part 26 in the web UI process of a Postgres bot (wip-redesign/sheets/NB6.md decisions 16, 25, 31, 42's
// A11 and 57, C13): D2, the provider credentials doc is written by the bot child while one runs and by the local chain
// while none does; D3, the local chain's land-or-cancel leaves the App Store ops queued outside it alone and counts a
// stored App Store op as landed; Q2, inStoreWrite's frame admits App Store doc writes only. A real BotManager with
// helpers/forkMock.ts's child, the real facade and row queue, and the web UI's sessions over helpers/sharedRows.ts.

const registry = vi.hoisted(() => {
  const stripe = {
    id: 'stripe',
    getCredentialFields: () => ['STRIPE_SECRET_KEY', 'WEBUI_BASE_URL'].map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  };
  return { get: (id: string) => (id === 'stripe' ? stripe : undefined) };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => registry }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...real, fork, default: { ...real, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { dataPath } from '../../src/utils/dataRoot';
import { providerCredentialsPath } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { queueStoreDoc, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetRowQueue, rowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readDocRecord, readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { writerLockDepth } from '../../src/bot/internalSetup/utils/writerLock';
import { BotManager, inLocalOp, inStoreWrite } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { forks } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { exitChild, freshWriterLock, resetForks, startedWith } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const ENV = dataPath('.env');
const STORE = dataPath('global', 'appstore');
const CREDS = path.join(STORE, 'credentials', 'mod.json');
const CREDS_KEY = 'global/appstore/credentials/mod.json';
const DOC_KEY = 'global/payment-providers/credentials.json';
const A = 'postgres://bot@db:5432/bot';

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let envBefore: string | null;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;
  fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\n');
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  fs.mkdirSync(STORE, { recursive: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  // As src/index.ts installs it.
  dm.setSharedWriteGate(inLocalOp);
  manager = new BotManager();
  s = webuiSessions();
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
    session: config => s.session(config as Record<string, unknown>),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  if (envBefore === null) fs.rmSync(ENV, { force: true });
  else fs.writeFileSync(ENV, envBefore);
  vi.restoreAllMocks();
});

async function putCredentials(body: object): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods.put);
  let status = 200;
  let answer: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { answer = b; return res; } };
  await layer!.route!.stack[0].handle({ params: { providerId: 'stripe' }, body }, res);
  return { status, body: answer };
}

const docEntry = (key: string) => {
  const read = readDocRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};
const storeEntry = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe('D2: the provider credentials doc', () => {
  it('with a bot child running the save is sent to the child; the web UI writes no session, mirror or record entry', async () => {
    const { child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }], manager);
    const sent: any[] = [];
    child.send.mockImplementation((m: any) => {
      sent.push(m);
      if (m.type === 'shared:op') setTimeout(() => child.emit('message', { requestId: m.requestId, data: { ok: true } }), 1);
    });
    const answer = await putCredentials({ values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(answer.status).toBe(200);
    expect(answer.body.success).toBe(true);
    expect(sent.filter(m => m.type === 'shared:op').map(m => m.data)).toEqual([
      { op: 'provider.saveCredentials', args: { providerId: 'stripe', changes: { STRIPE_SECRET_KEY: 'made-up-secret' } } },
    ]);
    expect(s.sessions()).toBe(0);
    expect(fs.existsSync(providerCredentialsPath())).toBe(false);
    expect(docEntry(DOC_KEY)).toBeUndefined();
  });

  it('with none the local chain stores it, holding the writer lock, and writes the mirror and its entry', async () => {
    const lockAtCommit: number[] = [];
    s.state.before = sql => {
      if (sql === 'COMMIT') lockAtCommit.push(writerLockDepth());
      return undefined;
    };
    const answer = await putCredentials({ values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(answer.status).toBe(200);
    expect(answer.body.status.STRIPE_SECRET_KEY).toEqual({ set: true });
    expect(lockAtCommit).toHaveLength(1);
    expect(lockAtCommit[0]).toBeGreaterThan(0);
    const row = s.rows.docs.get(DOC_KEY)!;
    expect(JSON.parse(row.body.toString('utf8'))).toEqual({ stripe: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(fs.readFileSync(providerCredentialsPath()).equals(row.body)).toBe(true);
    expect(docEntry(DOC_KEY)).toEqual({ sha: row.sha, stamp: null, main: '1:ALPHA' });
  });
});

describe("D3: the local chain's land-or-cancel", () => {
  it("(a) leaves an App Store op the web UI queued outside the chain alone, and the chain op's answer stands", async () => {
    s.state.connectFault = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    await inStoreWrite(async () => { queueStoreDoc(CREDS, '{"token":"x"}', 'absent'); });
    await vi.waitFor(() => expect(rowQueue.ops(CREDS_KEY)[0]?.triesFailed).toBeGreaterThan(0));
    const answer = await manager.runLocalOp('nb6 fix26', async () => ({ ok: true }));
    expect(answer).toEqual({ ok: true });
    expect(rowQueue.ops(CREDS_KEY).map(op => op.state)).toEqual(['queued']);
  });

  it("(b) an App Store op whose COMMIT was answered during the cancel's wait counts as stored, and its mirror is written", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let atCommit = false;
    s.state.before = sql => {
      if (sql !== 'COMMIT') return undefined;
      atCommit = true;
      return held;
    };
    const pending = manager.runLocalOp('nb6 fix26', async () => {
      queueStoreDoc(CREDS, '{"token":"x"}', 'absent');
      return { ok: true };
    });
    await vi.waitFor(() => expect(atCommit).toBe(true));
    const hold = await storeMutex.acquire(1000);
    release();
    await tick();
    hold!.release();
    expect(await pending).toEqual({ ok: true });
    const row = s.rows.docs.get(CREDS_KEY)!;
    expect(fs.readFileSync(CREDS).equals(row.body)).toBe(true);
    expect(storeEntry(CREDS_KEY)).toEqual({ sha: row.sha, stamp: null, main: '1:ALPHA' });
  });
});

describe("Q2: inStoreWrite's frame admits App Store doc writes only", () => {
  it("a write of any other file inside it is refused 'not-ready'; an App Store doc write is taken", async () => {
    const answers = await inStoreWrite(async () => [
      dm.writeRawAtomicTracked(dataPath('global', 'nb6fix26', 'x.json'), '{}'),
      dm.writeRawAtomicTracked(providerCredentialsPath(), '{}', { baseSha: 'absent' }),
      dm.writeRawAtomicTracked(path.join(STORE, 'cache', 'x.json'), '{}'),
      dm.writeRawAtomicTracked(CREDS, '{}', { baseSha: 'absent' }),
    ]);
    expect(answers.map(a => (a.accepted ? 'accepted' : a.cause))).toEqual(['not-ready', 'not-ready', 'not-ready', 'accepted']);
    expect(fs.existsSync(dataPath('global', 'nb6fix26', 'x.json'))).toBe(false);
    expect(fs.existsSync(path.join(STORE, 'cache', 'x.json'))).toBe(false);
  });
});
