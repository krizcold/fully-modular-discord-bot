import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 36 (its GET part): while a local op holds the writer lock, the web UI's read routes of the premium tiers
// and the Dummy variants load both caches from absent files and queue no write, inside the op's frame or outside it.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { call, startApp } from '../helpers/configRig';
import { freshWriterLock } from '../helpers/nb10Rig';
import { clearGlobal, DUMMY_STATE, gate, PREMIUM } from './nb10PremiumRig';

const GATE_LINE = 'the web UI process writes data files only inside a change it applies itself';
const role = process.env.BOT_PROCESS_ROLE;
let app: { url: string; close: () => Promise<void> } | null = null;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  delete process.env.BOT_PROCESS_ROLE;
  await flushAll();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  setSharedWriteGate(() => inLocalOp());
  freshWriterLock('webui');
});

afterEach(async () => {
  await app?.close();
  app = null;
  setSharedWriteGate(null);
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  vi.restoreAllMocks();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  fs.rmSync(writerLockPath(), { force: true });
});

describe('reads during a held local op (NB10 test 36)', () => {
  it('GET of the premium tiers and the Dummy variants with both files absent queues no write and leaves both files absent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getPaymentRegistry().register(new DummyProvider());
    expect(fs.existsSync(PREMIUM)).toBe(false);
    expect(fs.existsSync(DUMMY_STATE)).toBe(false);
    const manager = new BotManager();
    app = await startApp(a => a.use('/api/appstore', createAppStoreRoutes(manager)));
    const held = gate();
    const op = manager.runLocalOp('held op', async () => { await held.promise; return { ok: true }; });
    await vi.waitFor(() => expect(writerLockDepth()).toBe(1), { timeout: 2000, interval: 5 });

    const tiers = await call(app.url, 'GET', '/api/appstore/premium/tiers');
    expect(tiers.status).toBe(200);
    const variants = await call(app.url, 'GET', '/api/appstore/premium/providers/dummy/variants');
    expect(variants.status).toBe(200);
    expect(variants.body.success).toBe(true);
    const shared = dataPath('global');
    expect(queuedFilePaths().filter(p => p.startsWith(shared))).toEqual([]);

    held.open();
    expect(await op).toMatchObject({ ok: true });
    await flushAll();
    expect(queuedFilePaths().filter(p => p.startsWith(shared))).toEqual([]);
    expect(errors.mock.calls.some(c => String(c[0]).includes(GATE_LINE))).toBe(false);
    expect(fs.existsSync(PREMIUM)).toBe(false);
    expect(fs.existsSync(DUMMY_STATE)).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});
