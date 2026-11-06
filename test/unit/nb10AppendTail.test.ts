import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { appendData, flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { stubAppendHandles } from '../helpers/fileHandleStub';

// NB10 test 49, under NB13 decision 8: an append starts on its own line; the guard reads the file's last byte on every try.

let n = 0;
const fresh = () => `tail${++n}.jsonl`;
const opts = { scope: 'global' as const, category: 'nb10tail' };
const file = (name: string) => dataPath('global', 'nb10tail', name);
const L = (i: number) => JSON.stringify({ L: i, timestamp: `2026-10-29T00:00:0${i}.000Z`, action: 'nb10.tail' });
const linesOf = (name: string) => fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });

beforeEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('bot');
  fs.mkdirSync(dataPath('global', 'nb10tail'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
});

describe('an append after a line cut short', () => {
  it('starts on its own line after a cut line, the cut line stays, and the audit reader returns the new line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const audit = dataPath('global', 'premium-tiers.audit.jsonl');
    fs.rmSync(audit, { force: true });
    fs.writeFileSync(audit, '{"cut":');
    expect(appendData('premium-tiers.audit.jsonl', { scope: 'global' }, `${L(1)}\n`)).toBe(true);
    await flushAll();
    expect(fs.readFileSync(audit, 'utf8')).toBe(`{"cut":\n${L(1)}\n`);
    const { getPremiumManager } = await import('../../src/bot/internalSetup/utils/premiumManager');
    expect(getPremiumManager().readAuditEntries({ action: 'nb10.tail' }).entries).toEqual([JSON.parse(L(1))]);
  });

  it('an append to an absent file or an empty one writes no leading newline', async () => {
    const absent = fresh();
    appendData(absent, opts, `${L(1)}\n`);
    await flushAll();
    expect(fs.readFileSync(file(absent), 'utf8')).toBe(`${L(1)}\n`);
    const empty = fresh();
    fs.writeFileSync(file(empty), '');
    appendData(empty, opts, `${L(1)}\n`);
    await flushAll();
    expect(fs.readFileSync(file(empty), 'utf8')).toBe(`${L(1)}\n`);
  });

  it('a half-written append that failed EIO is retried whole on its own line, and the next one too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = fresh();
    fs.writeFileSync(file(name), '{"cut":');
    let failed = false;
    // The write passes half its bytes and returns that count.
    stubAppendHandles().onWrite(file(name), text => {
      if (failed) return undefined;
      failed = true;
      return Math.floor(Buffer.byteLength(text) / 2);
    });
    appendData(name, opts, `${L(1)}\n`);
    await flushAll();
    for (let i = 0; i < 100 && !fs.readFileSync(file(name), 'utf8').endsWith(`${L(1)}\n`); i++) await new Promise(r => setTimeout(r, 50));
    appendData(name, opts, `${L(2)}\n`);
    await flushAll();
    const text = fs.readFileSync(file(name), 'utf8');
    expect(failed).toBe(true);
    expect(text.endsWith(`\n${L(1)}\n${L(2)}\n`)).toBe(true);
    expect(text.split('\n').filter(l => l === L(1))).toHaveLength(1);
    expect(linesOf(name).filter(l => l !== null)).toEqual([JSON.parse(L(1)), JSON.parse(L(2))]);
  }, 20_000);

  it('after another holder cut a line between two takes of the writer lock, the next append starts on its own line', async () => {
    const name = fresh();
    expect(takeWriterLock().kind).toBe('taken');
    appendData(name, opts, `${L(1)}\n`);
    await flushAll();
    appendData(name, opts, `${L(2)}\n`);
    await flushAll();
    releaseWriterLock();
    // A second writer holds the lock, leaves the file ending in a cut line, and releases.
    fs.appendFileSync(file(name), '{"cut":');
    expect(takeWriterLock().kind).toBe('taken');
    appendData(name, opts, `${L(3)}\n`);
    await flushAll();
    expect(linesOf(name)).toEqual([JSON.parse(L(1)), JSON.parse(L(2)), null, JSON.parse(L(3))]);
  });
});
