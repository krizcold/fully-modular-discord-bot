import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 16 (part 10): the web UI's local chain on a Postgres bot. Its first op after each take of the writer lock
// waits for the reconcile (rows 50, 51); its land-or-cancel step lands or cancels the row ops still open (rows 122,
// 123; decision 42's A11 with E8's bound); the bot-down read of a shared key (C21: rows 52, 53, cell 444); a deposition
// with a refused row op (part 6's gap); and the web UI's exit drain, which sends a row op on its own session (part 7's
// gap). Row ops go out on helpers/nb6WebuiSession.ts's sessions over helpers/sharedRows.ts's tables.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { BOT_DOWN_DATABASE_NOTICE, readServedGlobal } from '../../src/webui/utils/servedRead';
import { checkWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setGuildDataBackend, writeRawAtomicTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { _resetRowQueue, rowQueue, shaOf, useWebuiSessions, type WebuiSessionDeps } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const CATEGORY = 'nb6webuichain';
const KEY = `global/${CATEGORY}/r.json`;
const FILE = dataPath('global', CATEGORY, 'r.json');
const A = 'postgres://bot:pw@a.example:5432/bot';
const OTHER = 6464;
const live = new Set<number>([process.pid, OTHER]);
const CANT_USE = "the web panel cannot use the bot's main database now: choosing the main database";

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;
const control = {
  refusal: null as null | { refusal: string; held: boolean },
  selectFault: null as Error | null,
};

function deps(): WebuiSessionDeps {
  return {
    target: async () => (control.refusal ?? { entry: A, tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      if (control.selectFault) throw control.selectFault;
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
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setGuildDataBackend(null);
  control.refusal = null;
  control.selectFault = null;
  s = webuiSessions();
  manager = new BotManager();
  useWebuiSessions(deps());
});

afterEach(() => {
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
});

const readMirror = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null);

describe("decision 16: the reconcile at the chain's first op after a take", () => {
  it('row 50: the first op runs on the mirrors the reconcile brought up to the rows', async () => {
    fs.mkdirSync(dataPath('global', CATEGORY), { recursive: true });
    fs.writeFileSync(FILE, '{"v":1}');
    s.rows.put(KEY, '{"v":2}');
    const reply = await manager.runLocalOp('read', async () => ({ ok: true, result: readMirror() }));
    expect(reply).toEqual({ ok: true, result: '{"v":2}' });
  });

  it("row 51: a reconcile that fails answers 503 with decision 16's text and runs nothing; the next op tries it again", async () => {
    control.selectFault = new Error('connect ECONNREFUSED');
    let ran = 0;
    const reply = await manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'backend-unavailable',
      error: "Can't reach the database to read the shared files (connect ECONNREFUSED); nothing was saved. Try again in a moment.",
    });
    expect(ran).toBe(0);
    control.selectFault = null;
    expect(await manager.runLocalOp('op', async () => { ran += 1; return { ok: true }; })).toEqual({ ok: true });
    expect(ran).toBe(1);
  });

  it('a JSON bot runs no reconcile (guard)', async () => {
    setBackendKind('file');
    control.selectFault = new Error('never read');
    expect(await manager.runLocalOp('op', async () => ({ ok: true, result: 1 }))).toEqual({ ok: true, result: 1 });
  });
});

describe("decision 42's A11: the land-or-cancel step over row ops", () => {
  it('row 123: an op whose COMMIT was not sent is cancelled and answers the database text with its cause', async () => {
    control.refusal = { refusal: 'choosing the main database', held: false };
    const reply = await manager.runLocalOp('write', async () => {
      expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
      await vi.waitFor(() => expect(rowQueue.entryOf(KEY)?.triesFailed).toBeGreaterThanOrEqual(1));
      return { ok: true, result: 1 };
    });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `The database did not take the write of r.json (${CANT_USE}), so your change was not saved. Try again in a moment.`,
    });
    expect(rowQueue.keys()).toEqual([]);
    expect(s.sessions()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('row 122: an op whose COMMIT answer was lost and whose landing check gets no answer is dropped and answers can\'t confirm', async () => {
    s.rows.fault = sql => (sql === 'COMMIT' ? new Error('Connection terminated unexpectedly') : undefined);
    const reply = await manager.runLocalOp('write', async () => {
      expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
      await vi.waitFor(() => expect(rowQueue.entryOf(KEY)?.unknown.length).toBe(1));
      s.state.connectFault = new Error('connect ETIMEDOUT');
      return { ok: true, result: 1 };
    });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'unconfirmed',
      error: "Can't confirm whether your change to r.json was saved: the database did not answer the save (Connection terminated unexpectedly). Reload to see the current values before you try again.",
    });
    expect(rowQueue.keys()).toEqual([]);
  });

  it('a lost COMMIT answer whose landing check finds the op answers saved', async () => {
    s.rows.fault = sql => (sql === 'COMMIT' ? 'lose' : undefined);
    const reply = await manager.runLocalOp('write', async () => {
      expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
      await vi.waitFor(() => expect(rowQueue.entryOf(KEY)?.unknown.length).toBe(1));
      s.rows.fault = undefined;
      return { ok: true, result: 1 };
    });
    expect(reply).toEqual({ ok: true, result: 1 });
    expect(s.rows.docs.get(KEY)?.sha).toBe(shaOf(Buffer.from('{"a":1}')));
    expect(s.rows.history.filter(h => h.key === KEY)).toHaveLength(1);
  });
});

describe('C21: the bot-down read of a shared key', () => {
  const target = { rel: `${CATEGORY}/r.json`, path: FILE };

  it("row 52: this process's queued op answers first, with the database notice", async () => {
    control.refusal = { refusal: 'choosing the main database', held: false };
    s.rows.put(KEY, '{"db":1}');
    expect(writeRawAtomicTracked(FILE, '{"queued":1}')).toEqual({ accepted: true });
    expect(await readServedGlobal(manager, target)).toEqual({ ok: true, content: '{"queued":1}', notice: BOT_DOWN_DATABASE_NOTICE });
  });

  it("row 52: else the row's body, read from the database", async () => {
    fs.mkdirSync(dataPath('global', CATEGORY), { recursive: true });
    fs.writeFileSync(FILE, '{"disk":1}');
    s.rows.put(KEY, '{"db":1}');
    expect(await readServedGlobal(manager, target)).toEqual({ ok: true, content: '{"db":1}', notice: BOT_DOWN_DATABASE_NOTICE });
  });

  it('cell 444: no row reads content null with the database notice', async () => {
    fs.mkdirSync(dataPath('global', CATEGORY), { recursive: true });
    fs.writeFileSync(FILE, '{"disk":1}');
    expect(await readServedGlobal(manager, target)).toEqual({ ok: true, content: null, notice: BOT_DOWN_DATABASE_NOTICE });
  });

  it("row 53: a read that fails answers 503 with decision 16's text", async () => {
    control.selectFault = new Error('connect ECONNREFUSED');
    expect(await readServedGlobal(manager, target)).toEqual({ ok: false, status: 503, error: "Can't reach the database to read this file (connect ECONNREFUSED)" });
  });

  it('a file that is no shared key reads the disk as today (guard)', async () => {
    const local = dataPath('global', 'fleet', 'nb6webuichain.json');
    fs.mkdirSync(dataPath('global', 'fleet'), { recursive: true });
    fs.writeFileSync(local, '{"local":1}');
    try {
      const read = await readServedGlobal(manager, { rel: 'fleet/nb6webuichain.json', path: local });
      expect(read).toMatchObject({ ok: true, content: '{"local":1}' });
    } finally {
      fs.rmSync(local, { force: true });
    }
  });
});

describe("part 6's gap: a deposition with a refused row op", () => {
  it('a row op the flush refused stored nothing: the deposed op answers nothing was saved', async () => {
    const reply = await manager.runLocalOp('write', async () => {
      s.rows.put(KEY, '{"other":1}');
      const r = await applySharedOp({ op: 'global.write', args: { rel: `${CATEGORY}/r.json`, contentJson: '{"a":1}', expectSha: 'absent' } });
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
      expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
      return r;
    });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: `Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved; nothing was saved.`,
    });
  });
});

describe("part 7's gap: the web UI's exit drain", () => {
  it('sends a queued row op on its own session and ends without the give-up wait', async () => {
    vi.resetModules();
    (await import('../helpers/backendKind')).setBackendKind('postgres');
    const fresh = await import('../../src/bot/internalSetup/utils/dataManager');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    control.refusal = { refusal: 'choosing the main database', held: false };
    store.useWebuiSessions(deps());
    try {
      expect(fresh.writeRawAtomicTracked(FILE, '{"exit":1}')).toEqual({ accepted: true });
      await vi.waitFor(() => expect(store.rowQueue.entryOf(KEY)?.triesFailed).toBeGreaterThanOrEqual(1));
      control.refusal = null;
      const started = Date.now();
      await fresh.drainForExit(20_000);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(s.rows.docs.get(KEY)?.body.toString()).toBe('{"exit":1}');
      expect(store.rowQueue.keys()).toEqual([]);
    } finally {
      store.useWebuiSessions(null);
      store._resetRowQueue();
    }
  });
});
