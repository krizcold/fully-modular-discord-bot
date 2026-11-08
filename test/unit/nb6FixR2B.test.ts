import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 2, R2-B1 (out/NB6/part-rulings.md "Code review round 2"): the web UI chain's reconcile whose
// pass moved a mirror aside before a body read answered after the 10 s bound. The chain keeps the writer lock until the
// pass has written the mirror. Rows are another machine's, written by helpers/sharedRows.ts as the flush stores them.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
// R3-B1's follow-up: a throw in what follows the op (landOrCancel reads the file queue first).
const afterOpFault = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    queuedFilePaths: () => {
      if (afterOpFault.on) throw new Error('EIO: i/o error');
      return real.queuedFilePaths();
    },
  };
});

import { BotManager } from '../../src/webui/botManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions, type WebuiSessionDeps } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { sha } from '../helpers/sharedRows';

const CATEGORY = 'nb6fixr2b';
const KEY = `global/${CATEGORY}/r.json`;
const FILE = dataPath('global', CATEGORY, 'r.json');
const A = 'postgres://bot:pw@a.example:5432/bot';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const live = new Set<number>([process.pid]);

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;

function deps(): WebuiSessionDeps {
  return {
    target: async () => ({ entry: A, tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  freshWriterLock('webui', live);
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setGuildDataBackend(null);
  s = webuiSessions();
  manager = new BotManager();
  useWebuiSessions(deps());
});

afterEach(() => {
  afterOpFault.on = false;
  vi.useRealTimers();
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
});

describe("R2-B1: the reconcile's pass moved a mirror aside before a late body read", () => {
  it('the op answers 503 at the bound, and the chain keeps the writer lock until the pass wrote the mirror', async () => {
    s.rows.put(KEY, '{"v":1}');
    expect(await manager.runLocalOp('read', async () => ({ ok: true, result: 1 }))).toEqual({ ok: true, result: 1 });
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{"v":1}');
    expect(fs.existsSync(writerLockPath())).toBe(false);
    // Changed outside the bot while no chain held the lock: the next reconcile moves it aside, then reads the row.
    fs.writeFileSync(FILE, '{"edited":true}');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s.rows.fault = (sql, params) => (sql === BODY && params?.[0] === KEY ? new Promise(resolve => setTimeout(resolve, 12_000)) : undefined);
    let ran = 0;
    let reply: unknown = null;
    void manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; }).then(r => { reply = r; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reply).toEqual({
      ok: false, status: 503, code: 'backend-unavailable',
      error: "Can't reach the database to read the shared files (no answer within 10 s); nothing was saved. Try again in a moment.",
    });
    expect(ran).toBe(0);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false));
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{"v":1}');
    const record = readDocRecord();
    expect(record.ok && record.record.docs[KEY]?.sha).toBe(sha('{"v":1}'));
  });
});

describe('R3-B1: a reconcile pass that rejects before its bound', () => {
  it("the record write fails ENOSPC: the op answers R4-B2's local form with the cause, and the lock is released", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      s.rows.put(KEY, '{"v":1}');
      // The mirror holds the row and the record has no entry for it (a crash between the mirror write and the record's).
      fs.mkdirSync(dataPath('global', CATEGORY), { recursive: true });
      fs.writeFileSync(FILE, '{"v":1}');
      const recordFile = dataPath('.shared-mirror.json');
      const real = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).startsWith(`${recordFile}.`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.openSync);
      let ran = 0;
      const reply = await Promise.race([
        manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; }),
        new Promise(resolve => { setTimeout(() => resolve('no answer'), 5000); }),
      ]);
      expect(reply).toEqual({
        ok: false, status: 500, code: 'io-error',
        error: "This machine could not write its copy of the shared files (ENOSPC: no space left on device), so nothing was saved. Check this machine's disk, then try again.",
      });
      expect(ran).toBe(0);
      await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false));
      spy.mockRestore();
      expect(await manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; })).toEqual({ ok: true });
      expect(ran).toBe(1);
      await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false));
      await new Promise(resolve => { setTimeout(resolve, 50); });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('R3-B1 follow-up: a throw after the op started', () => {
  it("landOrCancel throws: the route answers can't confirm with the cause, the lock is released, and the next op runs", async () => {
    s.rows.put(KEY, '{"v":1}');
    let ran = 0;
    const reply = await manager.runLocalOp('op', async () => {
      ran += 1;
      afterOpFault.on = true;
      return { ok: true };
    });
    afterOpFault.on = false;
    expect(ran).toBe(1);
    expect(reply).toEqual({ ok: false, code: 'failed', error: "Can't confirm whether the change was saved (EIO: i/o error)." });
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false));
    expect(await manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; })).toEqual({ ok: true });
    expect(ran).toBe(2);
    await vi.waitFor(() => expect(fs.existsSync(writerLockPath())).toBe(false));
  });
});
