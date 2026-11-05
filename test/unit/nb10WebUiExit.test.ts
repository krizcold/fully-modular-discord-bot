import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 47: at the web UI's exit no local op starts, queued ops answer the shutting-down text, and the op in
// progress ends its land-or-cancel step (at most 10 s) before flushBeforeExit; run for the two control.ts exit routes.
// The SIGTERM handlers of src/index.ts and src/webui/index.ts are nb10MainEntry.test.ts and nb10WebUiSignal.test.ts.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const order = vi.hoisted(() => [] as string[]);
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  drainForExit: vi.fn(async () => { order.push('flushBeforeExit'); return { left: [] }; }),
}));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { createControlRoutes } from '../../src/webui/routes/control';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { freshWriterLock, quiet } from '../helpers/nb10Rig';

let exits: number[] = [];

beforeEach(async () => {
  quiet();
  order.length = 0;
  exits = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code ?? 0); order.push('exit'); }) as typeof process.exit);
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  await resetData();
});

afterEach(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
});

/** A local premium op whose provider call the test holds. */
function heldPremiumOp(manager: BotManager): { reply: Promise<any>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
  const reply = (manager as any).enqueueLocal({
    label: 'premium.cancelPaidSubscriptionImmediately', provider: true,
    run: async () => { await held; order.push('op ended'); return { ok: true }; },
    again: () => manager.runSharedOp('premium.setTier', { args: [] }),
  });
  return { reply, release };
}

describe('the web UI after beginExit', () => {
  it('a config save answers the shutting-down text and the lock stays free; a webhook answers at once', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const manager = new BotManager();
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      manager.beginExit();
      const reply = await call(app.url, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
      expect(reply).toMatchObject({ status: 503, body: { success: false, error: 'The web panel is shutting down; nothing was saved. Save again once it is back.' } });
      expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 1 });
      expect(fs.existsSync(writerLockPath())).toBe(false);
      const started = Date.now();
      const hook = await manager.runSharedOp('payment.webhook', { providerId: 'dummy', body: '', signature: '', headers: {} }, { routeWaitMs: 5000 });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(hook).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe.each([
  ['the container restart', '/api/bot/shutdown', { emergency: true }],
  ['the full restart', '/api/bot/restart-server', {}],
])('%s route', (_name, route, body) => {
  it('answers the queued op with the shutting-down text and calls flushBeforeExit only after the op in progress ended', async () => {
    const manager = new BotManager();
    const app = await startApp(a => a.use('/api/bot', createControlRoutes(manager)));
    try {
      const { reply, release } = heldPremiumOp(manager);
      const queued = manager.runSharedOp('global.write', { rel: 'nb10exit/x.json', contentJson: '{}', expectSha: 'absent' });
      expect((await call(app.url, 'POST', route, body)).status).toBe(200);
      expect(await queued).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
      await new Promise(resolve => setTimeout(resolve, 800));
      expect(order).toEqual([]);
      release();
      expect(await reply).toEqual({ ok: true });
      for (let i = 0; i < 100 && !order.includes('exit'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(order).toEqual(['op ended', 'flushBeforeExit', 'exit']);
      expect(exits).toEqual([0]);
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('an op still running 10 s after the exit began', () => {
  it('is logged by name as can\'t confirm, and the exit goes on', async () => {
    const manager = new BotManager();
    const app = await startApp(a => a.use('/api/bot', createControlRoutes(manager)));
    try {
      const { reply, release } = heldPremiumOp(manager);
      expect((await call(app.url, 'POST', '/api/bot/restart-server', {})).status).toBe(200);
      for (let i = 0; i < 1200 && !order.includes('exit'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(order).toEqual(['flushBeforeExit', 'exit']);
      expect(vi.mocked(console.error).mock.calls.map(c => String(c[0]))).toContain(
        "[Main] Exiting while a local change is still running (premium.cancelPaidSubscriptionImmediately); can't confirm whether it was saved",
      );
      release();
      expect(await reply).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  }, 20_000);
});
