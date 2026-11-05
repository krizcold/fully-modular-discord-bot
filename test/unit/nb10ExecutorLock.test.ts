import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 15: the executor checks the writer lock before each op. Another live process named in the file answers
// held-elsewhere and closes this process's writes; an absent file is re-created naming this process and the op runs;
// a payment op constructs PremiumManager before the provider runs, so the event reaches a listening PremiumManager.

const reg = vi.hoisted(() => ({ listeners: [] as Array<(e: any) => void>, listenersAtHandle: -1 }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const provider = {
    id: 'evhook',
    async handleWebhook(): Promise<void> { reg.listenersAtHandle = reg.listeners.length; },
  };
  return {
    ...(await orig<any>()),
    getPaymentRegistry: () => ({
      on: (_t: string, fn: (e: any) => void) => { reg.listeners.push(fn); },
      off: () => undefined, list: () => [provider], startTickers: () => undefined, emitEvent: () => undefined,
      get: (id: string) => (id === 'evhook' ? provider : undefined),
    }),
  };
});

import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { flushAll, sharedWritesClosedLost } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { readJson } from '../helpers/configRig';

const OTHER = 4646;
const live = new Set<number>([process.pid, OTHER]);
const target = () => dataPath('global', 'nb10exec', 'x.json');
const write = (v: number) => applySharedOp({ op: 'global.write', args: { rel: 'nb10exec/x.json', contentJson: JSON.stringify({ v }), expectSha: 'absent' } });

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  await flushAll();
  fs.rmSync(dataPath('global', 'nb10exec'), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('the executor and the writer lock', () => {
  it('the lock naming another live process answers held-elsewhere, writes nothing and closes the writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'webui', at: Date.now() }));
    const reply = await write(1);
    expect(reply).toEqual({ ok: false, code: 'held-elsewhere', error: `Another process took the data files (the web UI, pid ${OTHER}); nothing was saved. Stop that process or wait until it ends, then try again.` });
    expect(sharedWritesClosedLost()).toBe(true);
    await flushAll();
    expect(fs.existsSync(target())).toBe(false);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
    // The other holder releases; this process takes the lock again for the rest of the file's tests.
    fs.unlinkSync(writerLockPath());
    expect(takeWriterLock().kind).toBe('taken');
  });

  it('an absent lock file is re-created naming this process, logged, and the op runs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(takeWriterLock().kind).toBe('taken');
    const written = fs.readFileSync(writerLockPath(), 'utf8');
    fs.unlinkSync(writerLockPath());
    const reply = await write(2);
    expect(reply).toMatchObject({ ok: true });
    expect(fs.readFileSync(writerLockPath(), 'utf8')).toBe(written);
    expect(errors.mock.calls.some(c => String(c[0]).startsWith(`[Data] ${writerLockPath()} was removed while this process held it; re-created it.`))).toBe(true);
    expect(readJson(target())).toEqual({ v: 2 });
  });

  it('a payment op constructs PremiumManager before the provider handles it', async () => {
    expect(reg.listeners.length).toBe(0);
    const reply = await applySharedOp({ op: 'payment.webhook', args: { providerId: 'evhook', body: '', signature: '', headers: {} } });
    expect(reply).toMatchObject({ ok: true });
    expect(reg.listenersAtHandle).toBeGreaterThan(0);
  });
});
