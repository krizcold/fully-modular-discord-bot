import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, lane C findings 1, 2, 4 and 5 and lane D finding 4 (out/NB6/review1-C.md, review1-D.md;
// the texts as out/NB6/part-rulings.md rules them). The web UI process of a Postgres bot with no bot child: a real
// BotManager and its local chain, the real facade and row queue, the web UI's sessions over helpers/sharedRows.ts's
// tables, the real App Store routes, and AppStorePanel.jsx run through babel. Key values are made up, never printed.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = {
    stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'WEBUI_BASE_URL']),
  };
  return { get: (id: string) => providers[id], on: () => undefined, off: () => undefined };
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
import { loadCredentials } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { queueStoreDoc } from '../../src/bot/internalSetup/utils/appStoreManager';
import { MODULE_STATUS_SQL } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, refreshShared } from '../../src/bot/internalSetup/utils/sharedMirror';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { forks } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { exitChild, freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { lost } from '../helpers/sharedRows';
import { readSourceText } from '../helpers/sourceText';

const ENV = dataPath('.env');
const STORE = dataPath('global', 'appstore');
const CREDS = path.join(STORE, 'credentials', 'mod.json');
const DOC_KEY = 'global/payment-providers/credentials.json';
const REPOS_KEY = 'global/appstore/repos.json';
const A = 'postgres://bot@db:5432/bot';
const LOCAL_TAIL = ' WEBUI_BASE_URL were saved on this machine only (in /data/.env); set them on each machine of the bot.';
const NOT_SENT = "it was not sent before the web panel released the data files' lock";

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let lines: string[];
let envBefore: string | null;
let tagNow: string;
let onSelect: (() => void) | null;
let client = 500;

beforeEach(() => {
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;
  fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\n');
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  dm.setSharedWriteGate(inLocalOp);
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  tagNow = '1:ALPHA';
  onSelect = null;
  manager = new BotManager();
  s = webuiSessions();
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      onSelect?.();
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => tagNow,
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

async function route(method: 'get' | 'put', at: string, req: { params?: object; body?: object } = {}): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === at && l.route.methods[method]);
  let status = 200;
  let body: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { body = b; return res; } };
  await layer!.route!.stack[0].handle({ params: {}, body: {}, query: {}, ...req }, res);
  return { status, body };
}

const putStripe = (values: Record<string, string>) =>
  route('put', '/premium/providers/:providerId/credentials', { params: { providerId: 'stripe' }, body: { values } });

/** One committed transaction of statements on a client of its own, as another process sends it. */
async function committed(...statements: Array<[string, unknown[]]>): Promise<void> {
  client += 1;
  await s.rows.answer('BEGIN', [], 0, client);
  for (const [text, values] of statements) await s.rows.answer(text, values, 0, client);
  await s.rows.answer('COMMIT', [], 0, client);
}

function panel(): Record<string, any> {
  const code = transformSync(readSourceText(__dirname, '../../src/webui/public/components/AppStorePanel.jsx'), {
    presets: [[presetReact, { runtime: 'classic' }]], babelrc: false, configFile: false,
  })!.code!;
  const ctx: Record<string, any> = { React: { useState: () => [], useEffect: () => {}, useRef: () => ({}) }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

describe("lane C finding 1: a provider save the local chain's 40 s wait left open is judged by the chain's cancel", () => {
  it("the op never reached COMMIT: A11's database text, then T17's sentence; nothing stored", async () => {
    s.state.connectFault = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = putStripe({ STRIPE_SECRET_KEY: 'made-up-secret', WEBUI_BASE_URL: 'https://panel.example' });
    await vi.advanceTimersByTimeAsync(45_000);
    const answer = await pending;
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe(`The database did not take the write of credentials.json (connect ECONNREFUSED 10.0.0.1:5432), so your change was not saved. Try again in a moment.${LOCAL_TAIL}`);
    expect(s.rows.docs.has(DOC_KEY)).toBe(false);
    expect(loadCredentials().WEBUI_BASE_URL).toBe('https://panel.example');
  });

  it("the COMMIT's answer was lost and no landing check is answered: A11's can't confirm text, then T17's sentence", async () => {
    let committing: number | null = null;
    s.rows.fault = (sql, _p, at) => {
      if (sql === 'COMMIT' && committing === null && at !== 999) {
        committing = at;
        return 'lose';
      }
      if (committing !== null && sql.startsWith('SELECT id')) return lost();
      return undefined;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = putStripe({ STRIPE_SECRET_KEY: 'made-up-secret', WEBUI_BASE_URL: 'https://panel.example' });
    await vi.advanceTimersByTimeAsync(200_000);
    const answer = await pending;
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe(`Can't confirm whether your change to credentials.json was saved: the database did not answer the save (Connection terminated unexpectedly). Reload to see the current values before you try again.${LOCAL_TAIL}`);
  });
});

describe("lane C finding 4: a row op of the chain cancelled before it was sent", () => {
  it("the log and A11's answer say it was not sent before the web panel released the lock", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let atCommit = false;
    s.state.before = sql => {
      if (sql !== 'COMMIT' || atCommit) return undefined;
      atCommit = true;
      return held;
    };
    const pending = manager.runLocalOp('nb6 fixr1', async () => {
      queueStoreDoc(CREDS, '{"token":"x"}', 'absent');
      queueStoreDoc(CREDS, '{"token":"y"}', dm.baseOf(CREDS));
      return { ok: true };
    });
    await vi.waitFor(() => expect(atCommit).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    const answer = await pending;
    expect(answer).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `The database did not take the write of mod.json (${NOT_SENT}), so your change was not saved. Try again in a moment.`,
    });
    expect(lines).toContain(`[Data] Not saved: ${CREDS} (${NOT_SENT}); the web UI dropped its write before releasing the data files' lock`);
  });
});

describe('lane C finding 2: the main database changed during the store docs pass', () => {
  it('the 503 says the main database changed, not that it could not be reached', async () => {
    s.rows.put(REPOS_KEY, JSON.stringify({ repositories: [] }));
    onSelect = () => { tagNow = '2:BRAVO'; };
    const answer = await route('get', '/repos');
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe("The bot's main database changed while the App Store's files were read, so nothing was changed. Try again in a moment.");
  });
});

describe('lane C finding 5: the status read fails', () => {
  const status = (module: string, node: string, sha: string, error: string): [string, unknown[]] =>
    [MODULE_STATUS_SQL, [module, `id-${node}`, node, sha, 'failed', error, '2026-11-08T04:01:00.000Z', `p-${node}`, 1]];

  it('the list answers moduleFailuresUnread with the cause, and the tab shows the line', async () => {
    await committed(status('m', 'BRAVO', 'b'.repeat(64), 'boom'));
    s.rows.fault = sql => (/shared_module_status/.test(sql) && sql.startsWith('SELECT') ? new Error('connect ECONNREFUSED 10.0.0.1:5432') : undefined);
    for (const at of ['/bundle', '/installed']) {
      const answer = await route('get', at);
      expect(answer.status).toBe(200);
      expect(answer.body.moduleFailuresUnread).toBe('connect ECONNREFUSED 10.0.0.1:5432');
      expect('moduleFailures' in answer.body).toBe(false);
    }
    expect(panel().appStoreFailureLines(undefined, 'connect ECONNREFUSED 10.0.0.1:5432')).toEqual([
      "Can't read which machines failed to load a module (connect ECONNREFUSED 10.0.0.1:5432).",
    ]);
  });
});

describe('lane D finding 4: the credentials doc cannot be read', () => {
  it("logs the cause once, and the premium tab's status says can't confirm for the doc's keys", async () => {
    fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\nSTRIPE_SECRET_KEY=made-up-env\n');
    s.rows.put(DOC_KEY, '{"stripe": ');
    expect((await refreshShared(null)).ok).toBe(true);
    const first = await route('get', '/premium/providers/:providerId/credentials', { params: { providerId: 'stripe' } });
    const second = await route('get', '/premium/providers/:providerId/credentials', { params: { providerId: 'stripe' } });
    expect(first.status).toBe(200);
    const unread = first.body.status.STRIPE_SECRET_KEY.unread;
    expect(unread).toMatch(/^can't confirm: payment-providers\/credentials\.json cannot be read \(.+\)$/);
    expect(first.body.status.STRIPE_SECRET_KEY.set).toBe(false);
    expect(first.body.status.WEBUI_BASE_URL).toEqual({ set: true, preview: '••••••••' });
    expect(second.body.status).toEqual(first.body.status);
    const cause = unread.slice("can't confirm: payment-providers/credentials.json cannot be read (".length, -1);
    const logged = lines.filter(l => l.startsWith('[Payment] '));
    expect(logged).toEqual([`[Payment] payment-providers/credentials.json cannot be read (${cause}); the built-in providers' keys read as not set until it can be read`]);
  });
});
