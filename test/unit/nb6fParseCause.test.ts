import fs from 'fs';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6F D8, T10 and R7 (W9, X5): a credentials doc that is not valid JSON is named by the fixed cause "it is not valid
// JSON" in the [Payment] log, the premium tab's status and the save's refusal, and a module's credentials file in the
// App Store's log; Node 24's parse message quotes part of the input, so no text may carry it. The web UI process of a
// Postgres bot with no bot child, as nb6FixR2DKeys.test.ts runs it. The value is made up and never printed.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = { stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'WEBUI_BASE_URL']) };
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
import { providerCredentials } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, refreshShared } from '../../src/bot/internalSetup/utils/sharedMirror';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const ENV = dataPath('.env');
const DOC_KEY = 'global/payment-providers/credentials.json';
const A = 'postgres://bot@db:5432/bot';
const SECRET = 'sk_live_madeup_value_0123';
const NOT_JSON = `{"stripe": ${SECRET}}`;
const PIECES = [SECRET, SECRET.slice(0, 10), 'sk_live', 'madeup'];

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let calls: unknown[][];
let envBefore: string | null;

beforeEach(() => {
  calls = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { calls.push(a); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;
  fs.writeFileSync(ENV, 'WEBUI_BASE_URL=https://old.example\n');
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
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

async function route(method: 'get' | 'put', providerId: string, body: object = {}): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods[method]);
  let status = 200;
  let answer: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { answer = b; return res; } };
  await layer!.route!.stack[0].handle({ params: { providerId }, body, query: {} }, res);
  return { status, body: answer };
}

const printed = () => calls.map(a => format(...a)).join('\n');
const holdsNoPiece = (text: string) => PIECES.every(p => !text.includes(p));

describe('D8, T10: a credentials doc that is not valid JSON', () => {
  it('the [Payment] log and the premium tab say "it is not valid JSON" and hold no part of the value', async () => {
    s.rows.put(DOC_KEY, NOT_JSON);
    expect((await refreshShared(null)).ok).toBe(true);
    const keys = providerCredentials('stripe');
    expect(keys.STRIPE_SECRET_KEY).toBeUndefined();
    const answer = await route('get', 'stripe');
    expect(answer.body.status.STRIPE_SECRET_KEY).toEqual({ set: false, unread: "can't confirm: payment-providers/credentials.json cannot be read (it is not valid JSON)" });
    expect(calls.map(a => format(...a)).filter(l => l.startsWith('[Payment] '))).toEqual([
      "[Payment] payment-providers/credentials.json cannot be read (it is not valid JSON); the built-in providers' keys read as not set until it can be read",
    ]);
    expect(holdsNoPiece(JSON.stringify(answer.body))).toBe(true);
    expect(holdsNoPiece(printed())).toBe(true);
  });

  it("the save's refusal says it and holds no part of the value", async () => {
    s.rows.put(DOC_KEY, NOT_JSON);
    const answer = await route('put', 'stripe', { values: { STRIPE_SECRET_KEY: 'made-up-new' } });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe('payment-providers/credentials.json cannot be read, so the keys of stripe were not saved: it is not valid JSON.');
    expect(holdsNoPiece(printed())).toBe(true);
  });
});

describe('R7, W9, X5: a module credentials file that is not valid JSON', () => {
  it("getCredentials logs R7's words and no part of the value in any argument", () => {
    const file = dataPath('global', 'appstore', 'credentials', 'mod1.json');
    fs.mkdirSync(dataPath('global', 'appstore', 'credentials'), { recursive: true });
    fs.writeFileSync(file, `{"k": ${SECRET}}`);
    const got = AppStoreManager.prototype.getCredentials.call({} as AppStoreManager, 'mod1');
    expect(got).toBeNull();
    const errors = calls.map(a => format(...a)).filter(l => l.startsWith('[AppStoreManager]'));
    expect(errors).toEqual(['[AppStoreManager] The credentials of mod1 cannot be read (it is not valid JSON)']);
    expect(holdsNoPiece(printed())).toBe(true);
  });
});
