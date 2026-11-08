import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 2, lane D finding 1 (out/NB6/review2-D.md; the texts as out/NB6/part-rulings.md "Code review
// round 2" rules them): a cause in one provider's entry of payment-providers/credentials.json names that provider in
// the log and in the premium tab, and leaves the other providers' keys read from the doc. The web UI process of a
// Postgres bot with no bot child, as nb6FixR1C.test.ts runs it. Key values are made up, never printed.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = {
    stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'WEBUI_BASE_URL']),
    paypal: provider('paypal', ['PAYPAL_CLIENT_ID']),
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
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, refreshShared } from '../../src/bot/internalSetup/utils/sharedMirror';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { forks } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { exitChild, freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const ENV = dataPath('.env');
const STORE = dataPath('global', 'appstore');
const DOC_KEY = 'global/payment-providers/credentials.json';
const A = 'postgres://bot@db:5432/bot';

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let lines: string[];
let envBefore: string | null;

beforeEach(() => {
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;
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

const keysOf = (providerId: string) => route('get', '/premium/providers/:providerId/credentials', { params: { providerId } });

describe('lane D round 2 finding 1: a cause in one provider\'s entry of the credentials doc', () => {
  it.each([
    ['the entry is no object', '"x"', 'the entry of stripe is not an object'],
    ['a key holds no text', '{"STRIPE_SECRET_KEY": 7}', 'a key of stripe holds no text'],
  ])('%s: the log and the tab name stripe, and paypal still reads its key from the doc', async (_what, entry, cause) => {
    fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\nSTRIPE_SECRET_KEY=made-up-env\n');
    s.rows.put(DOC_KEY, `{"stripe": ${entry}, "paypal": {"PAYPAL_CLIENT_ID": "pp_doc_made_up"}}`);
    expect((await refreshShared(null)).ok).toBe(true);
    const stripe = await keysOf('stripe');
    const again = await keysOf('stripe');
    const paypal = await keysOf('paypal');
    expect(stripe.status).toBe(200);
    expect(stripe.body.status.STRIPE_SECRET_KEY).toEqual({
      set: false, unread: `can't confirm: payment-providers/credentials.json cannot be read for stripe (${cause})`,
    });
    expect(stripe.body.status.WEBUI_BASE_URL).toEqual({ set: true, preview: '••••••••' });
    expect(again.body.status).toEqual(stripe.body.status);
    expect(paypal.body.status.PAYPAL_CLIENT_ID).toEqual({ set: true, preview: '••••••••' });
    expect(lines.filter(l => l.startsWith('[Payment] '))).toEqual([
      `[Payment] payment-providers/credentials.json cannot be read for stripe (${cause}); the keys of stripe read as not set until it can be read`,
    ]);
  });

  it('a doc that cannot be parsed keeps the doc-wide texts, for every built-in provider', async () => {
    fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\n');
    s.rows.put(DOC_KEY, '{"stripe": ');
    expect((await refreshShared(null)).ok).toBe(true);
    const stripe = await keysOf('stripe');
    const paypal = await keysOf('paypal');
    const unread = paypal.body.status.PAYPAL_CLIENT_ID.unread;
    expect(unread).toMatch(/^can't confirm: payment-providers\/credentials\.json cannot be read \(.+\)$/);
    expect(stripe.body.status.STRIPE_SECRET_KEY).toEqual({ set: false, unread });
    const cause = unread.slice("can't confirm: payment-providers/credentials.json cannot be read (".length, -1);
    expect(lines.filter(l => l.startsWith('[Payment] '))).toEqual([
      `[Payment] payment-providers/credentials.json cannot be read (${cause}); the built-in providers' keys read as not set until it can be read`,
    ]);
  });
});
