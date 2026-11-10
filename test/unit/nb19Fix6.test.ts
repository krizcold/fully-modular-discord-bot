import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 6 fixes: the scope record keeps one failed value per file path under the folder sync flag (O1), and
// the readers word the confirmFile-made range of a replaced try at the deadline (T1 ops, T2).

const h = vi.hoisted(() => ({
  chain: null as null | { dir: string; before: () => void; answer: { failed: true; kind: 'open'; dir: string; errno: string; error: null } },
  holdTemp: null as null | { file: string; until: Promise<void> },
  holder: null as null | { pid: number; role: string; start: null; at: number },
  flag: null as null | string,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      if (h.flag) return { failed: true, kind: 'earlier', dir: h.flag, errno: 'EIO', error: null };
      const s = h.chain;
      if (s && path.resolve(dir) === s.dir) {
        h.chain = null;
        s.before();
        return s.answer;
      }
      return real.syncFolderChain(dir);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<any>();
  return { ...real, deposedHolder: () => h.holder ?? real.deposedHolder() };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, confirmWrite: (ticket: unknown, deadlineMs: number) => real.confirmWrite(ticket, Math.min(deadlineMs, 400)) };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import { dataPath } from '../../src/utils/dataRoot';
import { enqueueWrite, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { pendingFor } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import { confirmSaved, confirmWrite, saveDataTracked, saveMark } from '../../src/bot/internalSetup/utils/dataManager';
import { resetFolderSyncFailureForTests, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { FileSessionStore, sessionSaveOutcome } from '../../src/webui/auth/fileSessionStore';
import { setBackendKind } from '../helpers/backendKind';

let guilds = 860_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
let releases: Array<() => void>;

const T21 = (file: string, dir: string) => {
  const { why, next } = syncWords('open', dir, 'EMFILE');
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};

beforeEach(() => {
  setBackendKind('file');
  h.chain = null;
  h.holdTemp = null;
  h.holder = null;
  h.flag = null;
  releases = [];
  resetFolderSyncFailureForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const p = String(file);
    const hold = h.holdTemp;
    if (flags === 'w' && hold && p.startsWith(`${hold.file}.`) && p.endsWith('.tmp')) await hold.until;
    return realOpen(file, flags, mode);
  }) as typeof fs.promises.open);
});
afterEach(async () => {
  h.chain = null;
  h.holdTemp = null;
  h.holder = null;
  h.flag = null;
  for (const release of releases) release();
  await flushAll();
  vi.restoreAllMocks();
  resetFolderSyncFailureForTests();
  setBackendKind(null);
});

/** The write to p made by start answers 'open' from its chain while W2 is enqueued, and W2's temp open waits. */
function replacedWhileNewerFlushes(p: string): void {
  const dir = path.dirname(p);
  let release!: () => void;
  const until = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  h.chain = {
    dir: path.resolve(dir),
    before: () => {
      enqueueWrite(p, '{"v":2}');
      h.holdTemp = { file: p, until };
    },
    answer: { failed: true, kind: 'open', dir: path.resolve(dir), errno: 'EMFILE', error: null },
  };
}

describe('O1: failed saves under the folder sync flag keep the scope record bounded', () => {
  it('many flushes of one guild file keep one failed group, and confirmSaved still answers by mark', async () => {
    const g = freshGuild();
    const before = saveMark();
    h.flag = dataPath(`x${g}`);
    for (let i = 0; i < 200; i += 1) {
      const saved = saveDataTracked('a.json', { guildId: g, category: 'm' }, { i });
      if (saved.outcome !== 'saved') throw new Error(saved.outcome);
      expect(await confirmWrite(saved.ticket, 3000)).toBe('unavailable');
    }
    const files = pendingFor(g, 0).files ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: dataPath(g, 'm', 'a.json'), tickets: [], failed: true });
    expect(await confirmSaved(g, { since: before })).toBe('unavailable');
    expect(await confirmSaved(g, { since: saveMark() })).toBe('ok');
  });
});

describe('T1 ops and T2: the readers at the deadline while the newer write of the path is flushing', () => {
  const write = (g: string) => applyOperatorDataWrite({ guildId: g, module: 'm', filename: 'x.json', op: 'write', contentJson: '{"v":1}' } as never);
  const banned = /left this node|nothing was saved|Another process took the data files/;

  for (const deposed of [false, true]) {
    it(`the web panel's guild data write answers T21 of kind open${deposed ? ' with a deposed holder' : ''}`, async () => {
      const g = freshGuild();
      const p = dataPath(g, 'm', 'x.json');
      replacedWhileNewerFlushes(p);
      if (deposed) h.holder = { pid: 6161, role: 'bot', start: null, at: Date.now() };
      const reply: any = await write(g);
      expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: T21('x.json', path.dirname(p)) });
      expect(reply.error).not.toMatch(banned);
      expect(fs.readFileSync(p, 'utf8')).toContain('"v"');
    });
  }

  it('a session save notes pending and calls back with no error', async () => {
    const dir = dataPath(`nb19fix6-sessions-${freshGuild()}`);
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, confirmMs: 400 });
    store.stop();
    replacedWhileNewerFlushes(path.join(dir, 'sid-f6.json'));
    const s = { cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) } } as any;
    const error = await new Promise<unknown>(resolve => store.set('sid-f6', s, e => resolve(e)));
    expect(error).toBeUndefined();
    expect(sessionSaveOutcome(s)).toBe('pending');
  });
});
