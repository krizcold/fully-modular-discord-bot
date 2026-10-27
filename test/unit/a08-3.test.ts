import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  saveData,
  appendData,
  deleteData,
  flushAll,
  DataBackendUnavailableError,
} from '../../src/bot/internalSetup/utils/dataManager';
import path from 'path';
import { writeRawAtomic, deleteRawAtomic, dropPendingForGuild } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { FileSessionStore } from '../../src/webui/auth/fileSessionStore';
import { dataUnavailableMessage } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { deleteRawAtomic as managerDeleteRaw } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

const realOpen = fs.promises.open.bind(fs.promises);
let clock = 1_000_000;

function failDisk(match: (p: string) => boolean = () => true): void {
  vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: any[]) => {
    if (String(args[0]).endsWith('.tmp') && match(String(args[0]))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return (realOpen as any)(...args);
  }) as any);
}

async function settle(): Promise<void> {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 20));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
});

describe('A08-3 the file queue refuses writes while the disk keeps failing', () => {
  it('refuses a save, append and delete once a failing flush is older than the age bound, then accepts again after the disk recovers', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk();
    expect(saveData('a.json', { scope: 'global' }, { v: 1 })).toBe(true);
    await settle();
    clock += 10_000;
    expect(saveData('b.json', { scope: 'global' }, { v: 2 })).toBe(true);
    clock += 25_000;
    expect(() => saveData('c.json', { scope: 'global' }, { v: 3 })).toThrow(DataBackendUnavailableError);
    let cause: string | undefined;
    try { appendData('log.jsonl', { scope: 'global' }, 'x\n'); } catch (e: any) { cause = e.causeKey; }
    expect(cause).toBe('storage-failing');
    expect(() => deleteData('b.json', { scope: 'global' })).toThrow(DataBackendUnavailableError);

    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(saveData('c.json', { scope: 'global' }, { v: 3 })).toBe(true);
  });

  it('refuses a write once the bytes held in memory pass the byte bound', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk();
    const big = 'x'.repeat(20 * 1024 * 1024);
    expect(saveData('big1.json', { scope: 'global' }, big)).toBe(true);
    expect(saveData('big2.json', { scope: 'global' }, big)).toBe(true);
    expect(() => saveData('small.json', { scope: 'global' }, 1)).toThrow(DataBackendUnavailableError);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(saveData('small.json', { scope: 'global' }, 1)).toBe(true);
    expect(deleteData('big1.json', { scope: 'global' })).toBe(true);
    expect(deleteData('big2.json', { scope: 'global' })).toBe(true);
  });

  it('stays refusing while the held bytes are above half the bound, and accepts once they drain below it', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk(p => p.includes('big2'));
    const big = 'x'.repeat(20 * 1024 * 1024);
    expect(saveData('big1.json', { scope: 'global' }, big)).toBe(true);
    expect(saveData('big2.json', { scope: 'global' }, big)).toBe(true);
    expect(() => saveData('small.json', { scope: 'global' }, 1)).toThrow(DataBackendUnavailableError);
    await flushAll();
    expect(() => saveData('small.json', { scope: 'global' }, 1)).toThrow(DataBackendUnavailableError);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(saveData('small.json', { scope: 'global' }, 1)).toBe(true);
    expect(deleteData('big1.json', { scope: 'global' })).toBe(true);
    expect(deleteData('big2.json', { scope: 'global' })).toBe(true);
  });

  it('refuses raw writes and deletes during the refusal, and a failing path dropped with its guild releases it', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const guild = 'a083guild';
    const raw = path.join(DATA_ROOT, 'global', 'a083raw.json');
    expect(writeRawAtomic(raw, '{}')).toBe(true);
    await flushAll();
    clock += 1_000;
    failDisk();
    expect(writeRawAtomic(path.join(DATA_ROOT, guild, 'x.json'), '{}')).toBe(true);
    expect(writeRawAtomic(path.join(DATA_ROOT, guild, 'a083mod', 'y.json'), '{}')).toBe(true);
    await settle();
    clock += 31_000;
    expect(writeRawAtomic(path.join(DATA_ROOT, 'global', 'a083other.json'), '{}')).toBe(false);
    expect(deleteRawAtomic(raw)).toBe(false);
    vi.mocked(fs.promises.open).mockRestore();
    dropPendingForGuild(guild);
    expect(writeRawAtomic(path.join(DATA_ROOT, 'global', 'a083other.json'), '{}')).toBe(true);
    expect(deleteRawAtomic(raw)).toBe(true);
    await flushAll();
    expect(deleteRawAtomic(path.join(DATA_ROOT, 'global', 'a083other.json'))).toBe(true);
  });

  it('answers a raw delete of an absent path with nothing queued as nothing to delete during the refusal, and records no refusal', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const guild = 'a083absentguild';
    failDisk();
    expect(writeRawAtomic(path.join(DATA_ROOT, guild, 'x.json'), '{}')).toBe(true);
    expect(writeRawAtomic(path.join(DATA_ROOT, guild, 'a083mod', 'y.json'), '{}')).toBe(true);
    await settle();
    clock += 31_000;
    const queued = path.join(DATA_ROOT, guild, 'x.json');
    expect(writeRawAtomic(path.join(DATA_ROOT, 'global', 'a083absentother.json'), '{}')).toBe(false);
    const ledger = openLedger('panel');
    runInLedger(ledger, 'modA', () => expect(managerDeleteRaw(path.join(DATA_ROOT, 'global', 'a083absent.json'))).toBe(false));
    expect(ledger.refusals()).toEqual([]);
    runInLedger(ledger, 'modA', () => expect(managerDeleteRaw(queued)).toBe(false));
    expect(ledger.refusals().length).toBe(1);
    vi.mocked(fs.promises.open).mockRestore();
    dropPendingForGuild(guild);
    await flushAll();
  });

  it('does not refuse by age when one path keeps failing but other flushes land', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk(p => p.includes('a083bad'));
    const badPlace = { scope: 'global' as const, category: 'a083badsub' };
    expect(saveData('a083bad.json', badPlace, 1)).toBe(true);
    await settle();
    clock += 1_000;
    expect(saveData('a083good.json', { scope: 'global' }, 1)).toBe(true);
    await settle();
    clock += 40_000;
    expect(saveData('a083good.json', { scope: 'global' }, 2)).toBe(true);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(deleteData('a083bad.json', badPlace)).toBe(true);
    expect(deleteData('a083good.json', { scope: 'global' })).toBe(true);
  });

  it('lets a path that fails alone on a quiet bot refuse only its own folder', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk(p => p.includes('a083quiet'));
    expect(saveData('a083quiet.json', { scope: 'global', category: 'a083sub' }, 1)).toBe(true);
    await settle();
    clock += 40_000;
    expect(saveData('a083elsewhere.json', { scope: 'global' }, 1)).toBe(true);
    expect(() => saveData('a083near.json', { scope: 'global', category: 'a083sub' }, 1)).toThrow(DataBackendUnavailableError);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(deleteData('a083quiet.json', { scope: 'global', category: 'a083sub' })).toBe(true);
    expect(deleteData('a083elsewhere.json', { scope: 'global' })).toBe(true);
    await flushAll();
  });

  it('keeps accepting writes elsewhere when two files fail in one folder on a quiet bot', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    failDisk(p => p.includes('a083pair'));
    const sub = { scope: 'global', category: 'a083pairsub' } as const;
    expect(saveData('a083pair1.json', sub, 1)).toBe(true);
    expect(saveData('a083pair2.json', sub, 1)).toBe(true);
    await settle();
    clock += 40_000;
    expect(saveData('a083pairok.json', { scope: 'global' }, 1)).toBe(true);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    for (const n of ['a083pair1.json', 'a083pair2.json']) expect(deleteData(n, sub)).toBe(true);
    expect(deleteData('a083pairok.json', { scope: 'global' })).toBe(true);
    await flushAll();
  });

  it('still refuses when the whole disk fails after an old bad path and a landed flush', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let wholeDisk = false;
    failDisk(p => wholeDisk || p.includes('a083old'));
    expect(saveData('a083old.json', { scope: 'global', category: 'a083sub2' }, 1)).toBe(true);
    await settle();
    clock += 1_000;
    expect(saveData('a083fine.json', { scope: 'global' }, 1)).toBe(true);
    await settle();
    clock += 60_000;
    wholeDisk = true;
    expect(saveData('a083fine.json', { scope: 'global' }, 2)).toBe(true);
    await settle();
    clock += 31_000;
    expect(() => saveData('a083new.json', { scope: 'global', category: 'a083other' }, 1)).toThrow(DataBackendUnavailableError);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(saveData('a083new.json', { scope: 'global', category: 'a083other' }, 1)).toBe(true);
    for (const [n, cat] of [['a083old.json', 'a083sub2'], ['a083fine.json', undefined], ['a083new.json', 'a083other']] as const) {
      expect(deleteData(n, { scope: 'global', ...(cat ? { category: cat } : {}) })).toBe(true);
    }
    await flushAll();
  });

  it('gives the session store an error when a save or a log out is refused', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const store = new FileSessionStore({ dir: path.join(DATA_ROOT, 'a083sessions') });
    const sid = 'a083sid';
    const session: any = { cookie: { maxAge: 60_000 }, passport: { user: 'u' } };
    const call = (fn: (cb: (err?: any) => void) => void) => new Promise<any>(r => fn(err => r(err)));
    expect(await call(cb => store.set(sid, session, cb))).toBeUndefined();
    await flushAll();
    failDisk();
    expect(saveData('a083s1.json', { scope: 'global' }, 1)).toBe(true);
    expect(saveData('a083s2.json', { scope: 'global', category: 'a083sx' }, 1)).toBe(true);
    await settle();
    clock += 31_000;
    expect(await call(cb => store.set(sid, session, cb))).toBeInstanceOf(Error);
    expect(await call(cb => store.destroy(sid, cb))).toBeInstanceOf(Error);
    vi.mocked(fs.promises.open).mockRestore();
    await flushAll();
    expect(await call(cb => store.destroy(sid, cb))).toBeUndefined();
    store.stop();
    expect(deleteData('a083s1.json', { scope: 'global' })).toBe(true);
    expect(deleteData('a083s2.json', { scope: 'global', category: 'a083sx' })).toBe(true);
    await flushAll();
  });

  it('tells the user the change was not saved', () => {
    expect(dataUnavailableMessage('storage-failing')).toMatch(/disk.*not saved/);
    expect(new DataBackendUnavailableError('storage-failing').message).toMatch(/Disk writes.*not saved/);
  });
});
