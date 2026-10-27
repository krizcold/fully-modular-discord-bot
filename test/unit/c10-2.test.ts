import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A /data/.env that is in place but cannot be read (EACCES on the file, or an I/O error): existsSync answers true and
// every read throws.
const fault = vi.hoisted(() => ({ path: '', on: false, code: 'EACCES' }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (fault.on && String(p) === fault.path) throw Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
    return (real.readFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFileSync;
  const mocked = { ...real, readFileSync };
  return { ...mocked, default: mocked };
});

const fakeProvider = vi.hoisted(() => ({ id: 'c10-2-fake', getCredentialFields: () => [{ key: 'C10_FAKE_KEY', label: 'Fake' }], isConfigured: () => false }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: (id: string) => (id === fakeProvider.id ? fakeProvider : undefined), getAll: () => [fakeProvider] }),
}));

import { credentialsReadError, loadCredentials, removeCredentials, upsertCredentials } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { persistPromotedUrls } from '../../src/bot/internalSetup/fleet/replicaPromotion';
import { runRoleReset } from '../../src/webui/lifecycleActions';
import type { BotManager } from '../../src/webui/botManager';

const envPath = dataPath('.env');
const stored = 'DISCORD_TOKEN=fake-token-value-for-tests\nDATA_BACKEND=postgres\nDATA_BACKEND_URL=postgres://fake@db-a/x\n';
const onDisk = () => fs.readFileSync(envPath, 'utf-8');

beforeEach(() => {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, stored);
  Object.assign(fault, { path: envPath, on: false, code: 'EACCES' });
});
afterEach(() => {
  fault.on = false;
  fs.rmSync(envPath, { force: true });
});

describe('an unreadable /data/.env is never rewritten', () => {
  for (const code of ['EACCES', 'EIO']) {
    it(`upsertCredentials refuses on ${code} and leaves every stored key`, () => {
      Object.assign(fault, { on: true, code });
      const result = upsertCredentials({ DATA_BACKEND: 'file' });
      fault.on = false;
      expect(result.success).toBe(false);
      expect(result.error).toContain(code);
      expect(onDisk()).toBe(stored);
    });

    it(`removeCredentials refuses on ${code} and leaves every stored key`, () => {
      Object.assign(fault, { on: true, code });
      const result = removeCredentials(['DATA_BACKEND_URL']);
      fault.on = false;
      expect(result.success).toBe(false);
      expect(result.error).toContain(code);
      expect(onDisk()).toBe(stored);
    });
  }

  it('upsertCredentials still creates a missing file, and removeCredentials on a missing file is no error', () => {
    fs.rmSync(envPath);
    expect(removeCredentials(['X'])).toEqual({ success: true });
    expect(fs.existsSync(envPath)).toBe(false);
    expect(upsertCredentials({ DATA_BACKEND: 'file' })).toEqual({ success: true });
    expect(onDisk()).toBe('DATA_BACKEND=file\n');
  });

  it('upsertCredentials and removeCredentials keep the other lines of a readable file', () => {
    expect(upsertCredentials({ DATA_BACKEND: 'file' }).success).toBe(true);
    expect(removeCredentials(['DATA_BACKEND_URL']).success).toBe(true);
    expect(onDisk()).toBe('DISCORD_TOKEN=fake-token-value-for-tests\nDATA_BACKEND=file\n');
  });
});

describe('loadCredentials tells a failed read apart from a missing file', () => {
  it('names the read error, and clears it on the next good read', () => {
    fault.on = true;
    loadCredentials();
    fault.on = false;
    expect(credentialsReadError()).toContain('EACCES');
    loadCredentials();
    expect(credentialsReadError()).toBeNull();
    fs.rmSync(envPath);
    loadCredentials();
    expect(credentialsReadError()).toBeNull();
  });

  it('keeps the keys it seeded from the file when a later read fails', () => {
    loadCredentials();
    expect(process.env.DATA_BACKEND_URL).toBe('postgres://fake@db-a/x');
    fault.on = true;
    const creds = loadCredentials();
    fault.on = false;
    expect(process.env.DATA_BACKEND_URL).toBe('postgres://fake@db-a/x');
    expect(creds.DATA_BACKEND_URL).toBe('postgres://fake@db-a/x');
  });
});

describe('the callers refuse on a failed read', () => {
  it('persistPromotedUrls refuses and writes nothing', () => {
    fault.on = true;
    const result = persistPromotedUrls('postgres://fake@db-b/x', 'postgres://fake@public-b/x');
    fault.on = false;
    expect(result.success).toBe(false);
    expect(onDisk()).toBe(stored);
  });

  it('runRoleReset answers that the store forms are not cleared', async () => {
    fault.on = true;
    const result = await runRoleReset({} as BotManager, false);
    fault.on = false;
    expect(result.success).toBe(false);
    expect(result.error).toContain('the persisted store forms are not');
    expect(onDisk()).toBe(stored);
  });
});

describe('a payment provider credentials save on an unreadable /data/.env', () => {
  it('answers that nothing was saved and why, and writes nothing', async () => {
    const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
    const router = createAppStoreRoutes({} as BotManager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
    const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods.put);
    let status = 200;
    let body: { success?: boolean; error?: string } = {};
    const res = { status(code: number) { status = code; return res; }, json(b: typeof body) { body = b; return res; } };
    fault.on = true;
    try {
      await layer!.route!.stack[0].handle({ params: { providerId: 'c10-2-fake' }, body: { values: { C10_FAKE_KEY: 'fake-value' } } }, res);
    } finally {
      fault.on = false;
    }
    expect(body.success).toBe(false);
    expect(status).toBeGreaterThanOrEqual(500);
    expect(body.error).toContain('nothing was saved');
    expect(body.error).toContain('EACCES');
    expect(onDisk()).toBe(stored);
  });
});

describe('a delivery applied after a failed /data/.env read', () => {
  it('writes nothing for that delivery, its recycles included, until a read succeeds', async () => {
    const { deliveryPersistsFor } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    loadCredentials();
    expect(deliveryPersistsFor(undefined)).toBe(true);
    expect(deliveryPersistsFor(false)).toBe(false);
    fault.on = true;
    loadCredentials();
    fault.on = false;
    expect(deliveryPersistsFor(undefined)).toBe(false);
    expect(deliveryPersistsFor(true)).toBe(false);
    loadCredentials();
    expect(deliveryPersistsFor(undefined)).toBe(true);
  });
});
