import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 5 (out/NB6/part-rulings.md "Code review round 5"). R5-B1: a throw from any step of the bot's
// shared files' pass is answered by one boundary in sharedMirror.ts: unanswered, `local` when the error is a file-system
// error, its line once per message; no pass rejects. The throw here is the module step's status clear on a full /data:
// a pending status whose entry's main is not the main tag (row 267's state, written by the real apply), and the store
// record's temp file failing ENOSPC at its open. R5-B2: T38's waiting form for that local cause.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { applyRig } from '../helpers/nb6ApplyRig';
import { pgError } from '../helpers/sharedRows';
import { readStoreRecord, storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import {
  bootShared, runSharedPass, setSharedModulePassStep, sharedBootCause, sharedBootCauseLocal, startSharedPass,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { sharedStartingText } from '../../src/bot/internalSetup/utils/sharedOps';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };

let rejections: unknown[];
const onRejection = (reason: unknown) => { rejections.push(reason); };
let restore: (() => void) | null;
let cause = '';
const stopLines = () => rig.state.lines.filter(l => l.startsWith('[Shared] The pass over the shared files stopped'));
const stopLine = () => `[Shared] The pass over the shared files stopped (${cause}); it tries again at the next pass`;
const ENOSPC_STOP = /^\[Shared\] The pass over the shared files stopped \(ENOSPC: no space left on device, open '.*\.shared-mirror\.json\.\d+\.\d+\.tmp'\); it tries again at the next pass$/;
const waitLines = () => rig.state.lines.filter(l => l.startsWith('[Shared] Waiting for '));

beforeEach(async () => {
  await rig.setup();
  rejections = [];
  restore = null;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  restore?.();
  _setListenClientFactory(null);
  await rig.teardown();
  process.off('unhandledRejection', onRejection);
});

/** Row 267's state: the apply's status upsert failed, so the entry keeps its status; then the main tag changed. */
async function pendingStatusAfterSwitch(): Promise<void> {
  const s = await rig.publish('m', S_FILES);
  rig.state.rows.fault = sql => (sql.startsWith('INSERT INTO smdb_data.shared_module_status') ? pgError('40P01', 'deadlock detected') : undefined);
  await rig.apply('m', s);
  rig.state.rows.fault = undefined;
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  record.record.modules.m = { ...record.record.modules.m, main: '0' };
  writeStoreRecord(record.record);
  expect(rig.entry('m')?.status).not.toBeNull();
}

/** The store record's temp file fails at its open as Node fails it on a full disk. */
function diskFull(): void {
  const prefix = `${storeRecordPath()}.`;
  const real = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(prefix)) {
      cause = `ENOSPC: no space left on device, open '${String(p)}'`;
      throw Object.assign(new Error(cause), { errno: -28, code: 'ENOSPC', syscall: 'open', path: String(p) });
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync);
  restore = () => spy.mockRestore();
}

describe('R5-B1: the 60 s pass', () => {
  it("the module step's status clear fails ENOSPC: no rejection at either pass, the line once, and the status is cleared once the disk takes writes", async () => {
    await pendingStatusAfterSwitch();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const listen = listenRig();
    _setListenClientFactory(listen.factory as never);
    diskFull();
    startSharedPass();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(stopLines()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rejections).toEqual([]);
    expect(stopLines()).toHaveLength(1);
    expect(stopLines()[0]).toMatch(ENOSPC_STOP);
    expect(rig.entry('m')?.status).not.toBeNull();
    restore!();
    restore = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(rig.entry('m')?.status).toBeNull());
    expect(rejections).toEqual([]);
    expect(stopLines()).toHaveLength(1);
  });
});

describe("R5-B1 and R5-B2: bootShared's loop", () => {
  it("the module step's status clear fails ENOSPC: the boot logs its wait line, T38 takes the local form, it tries again at 5 s and ends once the disk takes writes", async () => {
    await pendingStatusAfterSwitch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    diskFull();
    let ended: string | null = null;
    let failed: unknown = null;
    void bootShared().then(v => { ended = v; }, e => { failed = e; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(waitLines()).toHaveLength(1));
    expect(failed).toBeNull();
    expect(ended).toBeNull();
    expect(waitLines()).toEqual([`[Shared] Waiting for this machine to write the shared files (${cause}); modules start once they are up to date`]);
    expect(stopLines()).toEqual([stopLine()]);
    expect(sharedBootCause()).toBe(cause);
    expect(sharedBootCauseLocal()).toBe(true);
    expect(sharedStartingText('shared:op', sharedBootCause(), sharedBootCauseLocal())).toBe(
      `The bot is waiting for this machine to write the shared files (${cause}); nothing was saved. Check this machine's disk, then try again.`);
    expect(sharedStartingText('data:global-read', sharedBootCause(), sharedBootCauseLocal())).toBe(
      `The bot is waiting for this machine to write the shared files (${cause}). Check this machine's disk, then try again.`);
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toBeNull();
    expect(ended).toBeNull();
    expect(stopLines()).toHaveLength(1);
    restore!();
    restore = null;
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ended).toBe('done'));
    expect(rig.entry('m')?.status).toBeNull();
    expect(sharedBootCauseLocal()).toBe(false);
    expect(rejections).toEqual([]);
  });
});

describe('R5-B1: the boundary', () => {
  it('a throw that is not a file-system error answers unanswered with no local, and the database form of T38 stands', async () => {
    cause = 'terminating connection due to administrator command';
    setSharedModulePassStep(async () => { throw pgError('57P01', cause); });
    const res = await runSharedPass();
    expect(res).toEqual({ answered: false, cause });
    expect('local' in res).toBe(false);
    expect(stopLines()).toEqual([stopLine()]);
    await runSharedPass();
    expect(stopLines()).toHaveLength(1);
    expect(sharedStartingText('shared:op', cause, false)).toBe(
      `The bot is waiting for the database (${cause}) before it brings the shared files up to date; nothing was saved. Try again once the database answers.`);
    expect(rejections).toEqual([]);
  });

  it('a file-system throw answers local', async () => {
    await pendingStatusAfterSwitch();
    diskFull();
    const res = await runSharedPass();
    expect(res).toEqual({ answered: false, cause, local: true });
    expect(rejections).toEqual([]);
  });
});

describe('R6-B1: errors with a syscall and no path', () => {
  /** The store record's temp file opens, then its fd-based write fails as Node fails it on a full disk: no `path`. */
  function writeFull(): void {
    const prefix = `${storeRecordPath()}.`;
    const fds = new Set<number>();
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      if (String(p).startsWith(prefix)) fds.add(fd);
      return fd;
    }) as typeof fs.openSync);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (typeof target === 'number' && fds.has(target)) {
        cause = 'ENOSPC: no space left on device, write';
        throw Object.assign(new Error(cause), { errno: -28, code: 'ENOSPC', syscall: 'write' });
      }
      return (realWrite as (...a: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.writeFileSync);
    restore = () => { write.mockRestore(); open.mockRestore(); };
  }

  it("the store record's fd write fails ENOSPC with syscall 'write' and no path: the answer is local and T38 takes the local form", async () => {
    await pendingStatusAfterSwitch();
    writeFull();
    const res = await runSharedPass();
    expect(res).toEqual({ answered: false, cause, local: true });
    expect(stopLines()).toEqual([stopLine()]);
    expect(sharedStartingText('shared:op', res.cause, res.local === true)).toBe(
      `The bot is waiting for this machine to write the shared files (${cause}); nothing was saved. Check this machine's disk, then try again.`);
    expect(rig.entry('m')?.status).not.toBeNull();
    expect(rejections).toEqual([]);
  });

  it("a database socket reset (ECONNRESET, syscall 'read', no path) keeps no local", async () => {
    cause = 'read ECONNRESET';
    setSharedModulePassStep(async () => { throw Object.assign(new Error(cause), { errno: -104, code: 'ECONNRESET', syscall: 'read' }); });
    const res = await runSharedPass();
    expect(res).toEqual({ answered: false, cause });
    expect('local' in res).toBe(false);
    expect(stopLines()).toEqual([stopLine()]);
    expect(rejections).toEqual([]);
  });
});
