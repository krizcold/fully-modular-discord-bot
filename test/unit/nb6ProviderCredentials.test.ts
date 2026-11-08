import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 55 (wip-redesign/sheets/NB6.md decision 57, owner question 2's answer (a), T17; rows 197, 198 and 247;
// part 26): the premium tab's credentials route on a Postgres bot writes a built-in provider's own keys to the
// credentials doc with decision 22's base and 28's answers, and WEBUI_BASE_URL and a custom provider's keys to this
// machine's /data/.env with T17. The doc op is stored by the web UI's session over helpers/sharedRows.ts's tables, as
// the flush stores it, in the local chain of a real BotManager with no bot child (the fix of part 26's D2). Key values
// are made up and compared, never printed.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = {
    stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'WEBUI_BASE_URL']),
    custom: provider('custom', ['CUSTOM_KEY']),
  };
  return { get: (id: string) => providers[id] };
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
import { loadCredentials, providerCredentials } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { lost } from '../helpers/sharedRows';

const ENV = dataPath('.env');
const DOC_KEY = 'global/payment-providers/credentials.json';
const A = 'postgres://bot@db:5432/bot';
const T17 = (keys: string) => `${keys} are kept on this machine only (in /data/.env); set them on each machine of the bot.`;

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;
let envBefore: string | null;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;
  fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\n');
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global', 'payment-providers'), { recursive: true, force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
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
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  freshWriterLock('webui');
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  if (envBefore === null) fs.rmSync(ENV, { force: true });
  else fs.writeFileSync(ENV, envBefore);
  vi.restoreAllMocks();
});

async function call(method: 'get' | 'put', providerId: string, body: object = {}): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods[method]);
  let status = 200;
  let answer: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { answer = b; return res; } };
  await layer!.route!.stack[0].handle({ params: { providerId }, body }, res);
  return { status, body: answer };
}

const stored = () => JSON.parse(s.rows.docs.get(DOC_KEY)!.body.toString('utf8'));
const env = () => fs.readFileSync(ENV, 'utf8');

describe('row 197: a built-in provider\'s keys go to the credentials doc', () => {
  it("stored by the doc's op; today's answer; /data/.env untouched; the provider reads them", async () => {
    const answer = await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ success: true, status: { STRIPE_SECRET_KEY: { set: true }, STRIPE_WEBHOOK_SECRET: { set: false }, WEBUI_BASE_URL: { set: true } }, isConfigured: true });
    expect(stored()).toEqual({ stripe: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(env()).toBe('WEBUI_BASE_URL=https://old.example\n');
    expect(providerCredentials('stripe').STRIPE_SECRET_KEY === 'made-up-secret').toBe(true);
    expect((await call('get', 'stripe')).body.status.STRIPE_SECRET_KEY).toMatchObject({ set: true });
  });

  it('a cleared key is stored as null and reads as not set', async () => {
    await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    const answer = await call('put', 'stripe', { clear: ['STRIPE_SECRET_KEY'] });
    expect(answer.body.status.STRIPE_SECRET_KEY).toEqual({ set: false });
    expect(stored()).toEqual({ stripe: { STRIPE_SECRET_KEY: null } });
  });

  it("another machine changed the doc meanwhile: 28's 409 and the row keeps its version", async () => {
    // Stored by the other machine after this write read its base: the chain's reconcile ran before the read.
    let first = true;
    s.state.before = () => {
      if (first) s.rows.put(DOC_KEY, JSON.stringify({ stripe: { STRIPE_SECRET_KEY: 'other' } }));
      first = false;
      return undefined;
    };
    const answer = await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatch(/^payment-providers\/credentials\.json was changed on BRAVO at .+ while this change was being made; nothing was saved\. Reload the App Store tab to see the current values\.$/);
    expect(stored()).toEqual({ stripe: { STRIPE_SECRET_KEY: 'other' } });
  });
});

describe('row 198: WEBUI_BASE_URL and a custom provider\'s keys stay on this machine', () => {
  it('WEBUI_BASE_URL is written to /data/.env with T17, nothing to the doc', async () => {
    const answer = await call('put', 'stripe', { values: { WEBUI_BASE_URL: 'https://panel.example' } });
    expect(answer.body).toMatchObject({ success: true, message: `Saved. ${T17('WEBUI_BASE_URL')}` });
    expect(loadCredentials().WEBUI_BASE_URL).toBe('https://panel.example');
    expect(s.rows.docs.has(DOC_KEY)).toBe(false);
  });

  it("a custom provider's key is written to /data/.env with T17", async () => {
    const answer = await call('put', 'custom', { values: { CUSTOM_KEY: 'made-up' } });
    expect(answer.body).toMatchObject({ success: true, message: `Saved. ${T17('CUSTOM_KEY')}` });
    expect(loadCredentials().CUSTOM_KEY === 'made-up').toBe(true);
    expect(s.rows.docs.has(DOC_KEY)).toBe(false);
  });
});

describe('row 247: built-in keys and a local key; the doc op not settled within 40 s', () => {
  it("/data/.env is written; the doc op lands during the local chain's cancel: saved, then T17 (lane C finding 1)", async () => {
    // The COMMIT is stored and its answer lost; no landing check is answered within the 40 s, and the one on the wire
    // then (or the cancel's own) is answered after them.
    let lostCommit = false;
    let checksWait = false;
    let releaseChecks!: () => void;
    const checks = new Promise<void>(resolve => { releaseChecks = resolve; });
    s.rows.fault = async sql => {
      if (sql === 'COMMIT' && !lostCommit) {
        lostCommit = true;
        return 'lose';
      }
      if (sql.startsWith('SELECT id')) {
        if (!checksWait) return lost();
        await checks;
      }
      return undefined;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret', WEBUI_BASE_URL: 'https://panel.example' } });
    setTimeout(() => { checksWait = true; }, 39_999);
    await vi.advanceTimersByTimeAsync(40_000);
    releaseChecks();
    await vi.advanceTimersByTimeAsync(1000);
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ success: true, message: `Saved. ${T17('WEBUI_BASE_URL')}` });
    expect(stored()).toEqual({ stripe: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(loadCredentials().WEBUI_BASE_URL).toBe('https://panel.example');
  });
});

describe('a JSON bot (guard)', () => {
  it('writes every key to /data/.env as today, with no T17', async () => {
    setBackendKind(null);
    const answer = await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret' } });
    expect(answer.body.message).toBeUndefined();
    expect(answer.body.success).toBe(true);
    expect(loadCredentials().STRIPE_SECRET_KEY === 'made-up-secret').toBe(true);
    expect(s.rows.docs.has(DOC_KEY)).toBe(false);
  });
});

describe('lane C finding 9: the credentials doc cannot be read', () => {
  it("names the provider whose keys were not saved, then T17's sentence for the keys kept on this machine", async () => {
    s.rows.put(DOC_KEY, '{"stripe": ');
    const answer = await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret', WEBUI_BASE_URL: 'https://panel.example' } });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toMatch(/^payment-providers\/credentials\.json cannot be read, so the keys of stripe were not saved: [^\n]+\. WEBUI_BASE_URL were saved on this machine only \(in \/data\/\.env\); set them on each machine of the bot\.$/);
    expect(answer.body.error).not.toContain('nothing was saved');
    expect(s.rows.docs.get(DOC_KEY)!.body.toString('utf8')).toBe('{"stripe": ');
  });

  it('a doc that holds no object answers in the same form', async () => {
    s.rows.put(DOC_KEY, '[]');
    const answer = await call('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-secret', WEBUI_BASE_URL: 'https://panel.example' } });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe('payment-providers/credentials.json holds no object, so the keys of stripe were not saved. WEBUI_BASE_URL were saved on this machine only (in /data/.env); set them on each machine of the bot.');
    expect(s.rows.docs.get(DOC_KEY)!.body.toString('utf8')).toBe('[]');
  });
});
