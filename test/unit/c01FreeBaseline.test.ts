import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C01, R54-J1 (lanes/C01/sheet.md): the Premium Free baseline view and its save read the bot child's queue-first
// settings while the bot runs, and a save refuses while another write of the file is still queued.

vi.mock('../../src/webui/utils/installQueue', () => ({
  getInstallQueue: () => ({ setBotManager: () => undefined, getSnapshot: () => ({}) }),
}));
// Its providers load by require, which this suite does not resolve; no test here takes a payment.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: () => undefined, on: () => undefined, off: () => undefined }),
}));

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeChild, botFor, call, later, put, readJson, resetData, startApp } from '../helpers/configRig';

const child = new FakeChild();
const settings = () => dataPath('global', 'examples', 'settings.json');
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startApp(app => app.use('/api/appstore', createAppStoreRoutes(botFor(child)))));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  await resetData();
});

const childHolds = (body: unknown, pending: boolean) => {
  child.global = req => (req.rel === 'examples/settings.json' ? { ok: true, contentJson: JSON.stringify(body), pending } : undefined);
};

describe('the Free baseline reads the serving child (R54-J1)', () => {
  it('GET /global-config answers the child\'s newest accepted settings', async () => {
    put(settings(), { pingCustomMessage: 'disk-old' });
    childHolds({ pingCustomMessage: 'child-new' }, true);
    const got = await call(base, 'GET', '/api/appstore/global-config/examples');
    expect(got.status).toBe(200);
    expect(got.body.config.values.pingCustomMessage).toBe('child-new');
  });

  it('a Free save builds on the child\'s settings, keeping what the child holds', async () => {
    put(settings(), { pingCustomMessage: 'disk-old' });
    childHolds({ pingCustomMessage: 'child-new', _disabledCommands: ['ping'] }, false);
    const saved = await call(base, 'PUT', '/api/appstore/global-config/examples', { moduleEnabled: false });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await flushAll();
    expect(readJson(settings())).toEqual({ pingCustomMessage: 'child-new', _disabledCommands: ['ping'], _moduleEnabled: false });
  });

  it('a Free save refuses while the child still holds a queued write of the file', async () => {
    put(settings(), { pingCustomMessage: 'disk-old' });
    childHolds({ pingCustomMessage: 'child-new' }, true);
    const saved = await call(base, 'PUT', '/api/appstore/global-config/examples', { moduleEnabled: false });
    expect(saved.status, JSON.stringify(saved.body)).toBe(409);
    await flushAll();
    expect(readJson(settings())).toEqual({ pingCustomMessage: 'disk-old' });
  });
});

// Review round 1 on C01 (lanes/C01/sheet.md, findings C01-R1-2 and C01-R1-9).
describe('review round 1', () => {
  it('C01-R1-2: two Free saves made together both survive', async () => {
    put(settings(), { pingCustomMessage: 'disk' });
    // A child in its own process: it reads the disk, never this process's queue, and answers late.
    child.global = req => (req.rel === 'examples/settings.json'
      ? later(30, () => ({ ok: true, contentJson: fs.readFileSync(settings(), 'utf-8'), pending: false }))
      : undefined);
    const [a, b] = await Promise.all([
      call(base, 'PUT', '/api/appstore/global-config/examples', { moduleEnabled: false }),
      call(base, 'PUT', '/api/appstore/global-config/examples', { disabledCommands: ['ping'] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await flushAll();
    expect(readJson(settings())).toEqual({ pingCustomMessage: 'disk', _moduleEnabled: false, _disabledCommands: ['ping'] });
  });

  it('C01-R1-9: /bundle marks a Free baseline the serving child refused, and never shows this process\'s disk view as it', async () => {
    put(settings(), { pingCustomMessage: 'disk-old' });
    child.global = req => (req.rel === 'examples/settings.json' ? { ok: false, code: 'backend-unavailable', error: 'not ready' } : undefined);
    const got = await call(base, 'GET', '/api/appstore/bundle');
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.tiers.free.baselineUnavailable?.examples).toBeTruthy();
    expect(got.body.tiers.free.overrides.examples?.pingCustomMessage).not.toBe('disk-old');
  });

  it('C01-R1-9: /bundle labels a Free baseline read while the bot is not running', async () => {
    put(settings(), { pingCustomMessage: 'disk' });
    child.running = false;
    const got = await call(base, 'GET', '/api/appstore/bundle');
    expect(got.status).toBe(200);
    expect(got.body.tiers.free.baselineNotice).toMatch(/not running/);
  });
});

// Review round 2 on C01 (lanes/C01/sheet.md, finding C01-R2-2).
describe('review round 2', () => {
  it('C01-R2-2: a Free save refuses when this node becomes a co-worker during the serving read', async () => {
    const { clearRoleOverride, writeRoleOverride } = await import('../../src/bot/internalSetup/fleet/nodeIdentity');
    put(settings(), { pingCustomMessage: 'disk' });
    child.global = req => {
      if (req.rel !== 'examples/settings.json') return undefined;
      writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy: 'webui-demote' });
      return { ok: true, contentJson: fs.readFileSync(settings(), 'utf-8'), pending: false };
    };
    let saved: Awaited<ReturnType<typeof call>>;
    try {
      saved = await call(base, 'PUT', '/api/appstore/global-config/examples', { values: { pingCustomMessage: 'mine' } });
      await flushAll();
    } finally {
      clearRoleOverride();
    }
    expect(saved.status).toBe(403);
    expect(saved.body.code).toBe('co-worker-readonly');
    expect(readJson(settings())).toEqual({ pingCustomMessage: 'disk' });
  });
});
