import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 26 (the web UI's local chain): a deposition during an op answers by what landed, and once the other holder
// released, the next local op takes the lock again, saves, and leaves no lock behind.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
const waits = vi.hoisted(() => ({ landOrCancel: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    cancelQueued: (...a: Parameters<typeof real.cancelQueued>) => {
      if (!a[2]?.freeze) waits.landOrCancel += 1;
      return real.cancelQueued(...a);
    },
  };
});

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { checkWriterLock, configureWriterLock, releaseWriterLock, takeWriterLockForBoot, WRITER_CHECK_MS, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { flushAll, setSharedWriteGate, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { dataPath } from '../../src/utils/dataRoot';
import { readJson } from '../helpers/configRig';
import { freshWriterLock, quiet } from '../helpers/nb10Rig';

const OTHER = 5353;
const live = new Set<number>([process.pid, OTHER]);
const file = (name: string) => dataPath('global', 'nb10depchain', name);
const G = '900000000000001168';
const write = (name: string, body: unknown) => applySharedOp({ op: 'global.write', args: { rel: `nb10depchain/${name}`, contentJson: JSON.stringify(body), expectSha: 'absent' } });

/** Holds the rename of the target's temp file onto it until the test opens the gate. */
function holdRename(target: string): { open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) await gate;
    return rename(from, to);
  }) as typeof fs.promises.rename);
  return { open };
}

/** Another live bot process takes the lock file over, and this holder's check reads it. */
function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

beforeEach(async () => {
  quiet();
  waits.landOrCancel = 0;
  setSharedWriteGate(() => inLocalOp());
  freshWriterLock('webui', live);
  await flushAll();
  fs.rmSync(dataPath('global', 'nb10depchain'), { recursive: true, force: true });
  fs.rmSync(dataPath(G), { recursive: true, force: true });
});

afterEach(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('a deposition during a local op', () => {
  it('a premium op whose every write landed before the deposition answers saved (NB10-R10-D2)', async () => {
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    const reply = await (manager as any).enqueueLocal({
      label: 'global.write', provider: false,
      run: async () => {
        const answer = await write('audit.json', { line: 1 });
        expect(answer).toMatchObject({ ok: true });
        deposeNow();
        return answer;
      },
      again: async () => ({ ok: false }),
    });
    expect(reply).toMatchObject({ ok: true, result: true });
    expect(reply.error).toBeUndefined();
    expect(fs.readFileSync(file('audit.json'), 'utf8')).toBe('{"line":1}');
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  });

  it('before any write landed, a global.write answers nothing was saved, with no provider sentence', async () => {
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    const reply = await (manager as any).enqueueLocal({
      label: 'global.write', provider: false,
      run: async () => {
        deposeNow();
        expect(writeRawAtomic(file('w.json'), '{}')).toBe(false);
        return write('x.json', {});
      },
      again: async () => ({ ok: false }),
    });
    expect(reply).toMatchObject({
      ok: false, code: 'held-elsewhere',
      error: `Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved; nothing was saved.`,
    });
    await flushAll();
    expect(fs.existsSync(file('x.json'))).toBe(false);
    expect(fs.existsSync(file('w.json'))).toBe(false);
  });

  it('a local guild write still pending at 8 s whose write lands during the cancel wait, with a deposition in it, answers saved (NB10-R11-D1)', async () => {
    const target = dataPath(G, 'mod', 'x.json');
    const held = holdRename(target);
    const manager = new BotManager();
    const reply = manager.writeGuildData({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: JSON.stringify({ a: 1 }, null, 2), expectSha: 'absent' });
    await vi.waitFor(() => expect(waits.landOrCancel).toBe(1), { timeout: 12_000, interval: 20 });
    expect(fs.existsSync(target)).toBe(false);
    deposeNow();
    held.open();
    const answer: any = await reply;
    expect(answer).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  }, 20_000);

  it('a local global.write answered unconfirmed pending whose write lands during the cancel wait, with a deposition in it, answers saved (NB10-R11-D1)', async () => {
    const held = holdRename(file('p.json'));
    const manager = new BotManager();
    const reply = manager.runSharedOp('global.write', { rel: 'nb10depchain/p.json', contentJson: '{"p":1}', expectSha: 'absent' });
    await vi.waitFor(() => expect(waits.landOrCancel).toBe(1), { timeout: 12_000, interval: 20 });
    expect(fs.existsSync(file('p.json'))).toBe(false);
    deposeNow();
    held.open();
    const answer: any = await reply;
    expect(answer).toMatchObject({ ok: true });
    expect(answer.error).toBeUndefined();
    expect(fs.readFileSync(file('p.json'), 'utf8')).toBe('{"p":1}');
  }, 20_000);

  it('once the other holder released, a local global.write takes the lock, saves, and leaves no lock and no re-create line; a bot then takes the lock with no wait', async () => {
    const errors = vi.mocked(console.error);
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const manager = new BotManager();
      expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
      await (manager as any).enqueueLocal({ label: 'deposed op', provider: false, run: async () => { deposeNow(); return { ok: false, code: 'failed', error: 'x' }; }, again: async () => ({ ok: false }) });
      expect(manager.writerRoute('shared')).toMatchObject({ code: 'held-elsewhere' });
      fs.unlinkSync(writerLockPath());
      vi.advanceTimersByTime(WRITER_CHECK_MS + 1_000);
      expect(fs.existsSync(writerLockPath())).toBe(false);
      expect(errors.mock.calls.some(c => String(c[0]).includes('re-created it'))).toBe(false);

      const reply = await manager.runSharedOp('global.write', { rel: 'nb10depchain/y.json', contentJson: '{"y":1}', expectSha: 'absent' });
      expect(reply).toEqual({ ok: true, result: true });
      expect(readJson(file('y.json'))).toEqual({ y: 1 });
      expect(fs.existsSync(writerLockPath())).toBe(false);
      vi.advanceTimersByTime(WRITER_CHECK_MS * 2);
      expect(fs.existsSync(writerLockPath())).toBe(false);
      expect(errors.mock.calls.some(c => String(c[0]).includes('re-created it'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    const CHILD = 6262;
    configureWriterLock('bot', { pid: () => CHILD, alive: p => live.has(p) || p === CHILD, startOf: () => null, now: () => Date.now() });
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn();
    const hadSend = process.send;
    process.send = send as any;
    try {
      await takeWriterLockForBoot(sleep);
    } finally {
      process.send = hadSend;
    }
    expect(sleep).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(c => c[0]?.data?.stage === 'waiting')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'))).toMatchObject({ pid: CHILD, role: 'bot' });
    releaseWriterLock();
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});
