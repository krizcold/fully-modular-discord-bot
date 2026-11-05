import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined }),
}));

import { dataPath } from '../../src/utils/dataRoot';
import { appendData, flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// NB10 test 49: an append starts on its own line, reading the file's last byte only while this process does not know it.

let n = 0;
const fresh = () => `tail${++n}.jsonl`;
const opts = { scope: 'global' as const, category: 'nb10tail' };
const file = (name: string) => dataPath('global', 'nb10tail', name);
const realOpen = fs.promises.open.bind(fs.promises);
const L = (i: number) => JSON.stringify({ L: i, timestamp: `2026-10-29T00:00:0${i}.000Z`, action: 'nb10.tail' });
const linesOf = (name: string) => fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });

/** Counts the opens for reading of one path: the last-byte check is the only one. */
function byteReads(target: string): { count: number } {
  const seen = { count: 0 };
  vi.spyOn(fs.promises, 'open').mockImplementation(((p: fs.PathLike, flags?: any, ...rest: any[]) => {
    if (String(p) === target && flags === 'r') seen.count++;
    return (realOpen as any)(p, flags, ...rest);
  }) as typeof fs.promises.open);
  return seen;
}

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
    const realAppend = fs.promises.appendFile.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'appendFile').mockImplementation((async (p: any, data: any, ...rest: any[]) => {
      if (String(p) === file(name) && !failed) {
        failed = true;
        const text = String(data);
        await realAppend(p, text.slice(0, Math.floor(text.length / 2)), ...rest);
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return realAppend(p, data, ...rest);
    }) as typeof fs.promises.appendFile);
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

  it('after its own append landed the next reads no byte; after another holder cut a line between two takes it reads one', async () => {
    const name = fresh();
    expect(takeWriterLock().kind).toBe('taken');
    appendData(name, opts, `${L(1)}\n`);
    await flushAll();
    const reads = byteReads(file(name));
    appendData(name, opts, `${L(2)}\n`);
    await flushAll();
    expect(reads.count).toBe(0);
    releaseWriterLock();
    // A second writer holds the lock, leaves the file ending in a cut line, and releases.
    fs.appendFileSync(file(name), '{"cut":');
    expect(takeWriterLock().kind).toBe('taken');
    appendData(name, opts, `${L(3)}\n`);
    await flushAll();
    expect(reads.count).toBe(1);
    expect(linesOf(name)).toEqual([JSON.parse(L(1)), JSON.parse(L(2)), null, JSON.parse(L(3))]);
  });
});
