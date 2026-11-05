import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 4, the fixer's regression tests for the data findings: each case fails on the build the
// round reviewed.

const h = vi.hoisted(() => ({
  holdRename: null as null | { target: string; promise: Promise<void> },
  failRename: new Set<string>(),
  onStat: null as null | ((p: string) => void),
  stopping: false,
  pendingVerdict: false,
}));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const promises = {
    ...real.promises,
    rename: async (from: any, to: any) => {
      const target = path.resolve(String(to));
      const hold = h.holdRename;
      if (hold && target === hold.target) await hold.promise;
      if (h.failRename.has(target)) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      return real.promises.rename(from, to);
    },
    stat: async (p: any, ...rest: any[]) => {
      h.onStat?.(path.resolve(String(p)));
      return real.promises.stat(p, ...rest);
    },
  };
  const wrapped = { ...real, promises };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return { ...real, isStopping: () => h.stopping || real.isStopping() };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/replyGate')>();
  return {
    ...real,
    verdictOf: async (ledgers: any) => (h.pendingVerdict ? { ok: false, answer: 'pending', partial: false } : real.verdictOf(ledgers)),
  };
});

import { cancelQueued, enqueueWrite, fileFlushOnTheWire, flushAll as flushFiles, graveyardGuildDir } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, restoreGuildFromGraveyard, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, deposedText, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { sendHopReply } from '../../src/webui/routes/config';
import { dataPath } from '../../src/utils/dataRoot';

const OTHER = 4848;
const live = new Set<number>([process.pid, OTHER]);
const seams = { pid: () => process.pid, alive: (p: number) => live.has(p), startOf: () => null, now: () => Date.now() };
const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
let guildSeq = 0;
const freshGuildId = () => `9000000000004${String(Date.now() % 100000).padStart(5, '0')}${++guildSeq}`;

function freshLock(role: 'bot' | 'webui' | 'import'): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  configureWriterLock(role, seams);
}

/** Another live process overwrites the lock file, and the holder's check reads it: this process is deposed. */
function deposeBy(role: string): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role, at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

const graveyardEntries = (guildId: string): string[] => {
  const root = dataPath('_graveyard');
  return fs.existsSync(root) ? fs.readdirSync(root).filter(n => n.startsWith(`${guildId}-`)) : [];
};

const role = process.env.BOT_PROCESS_ROLE;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.holdRename = null;
  h.failRename.clear();
  h.onStat = null;
  h.stopping = false;
  h.pendingVerdict = false;
  delete process.env.BOT_PROCESS_ROLE;
  freshLock('bot');
});

afterEach(async () => {
  h.holdRename = null;
  h.failRename.clear();
  h.onStat = null;
  h.stopping = false;
  h.pendingVerdict = false;
  // A take from depth 0 forgets a deposition and reopens shared writes.
  freshLock('bot');
  expect(takeWriterLock().kind).toBe('taken');
  releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await flushFiles();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe("a deposed JSON bot moves no guild's whole directory (D1)", () => {
  it('a delete-namespace whose flush is on the wire at the deposition keeps the guild dir and answers held-elsewhere', async () => {
    const G = freshGuildId();
    saveData('a.json', { guildId: G, category: 'm' }, { v: 1 });
    await flushAll();
    const file = path.resolve(dataPath(G, 'm', 'a.json'));
    expect(fs.existsSync(file)).toBe(true);
    expect(takeWriterLock().kind).toBe('taken');
    let open!: () => void;
    h.holdRename = { target: file, promise: new Promise<void>(resolve => { open = resolve; }) };
    saveData('a.json', { guildId: G, category: 'm' }, { v: 2 });
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    expect(fileFlushOnTheWire()).toBe(true);
    const deleting = applyOperatorDataWrite({ guildId: G, module: 'm', filename: 'a.json', op: 'delete-namespace' } as any);
    await tick(10);
    deposeBy('import');
    open();
    const reply = await deleting;
    expect(reply).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText({ role: 'import', pid: OTHER }) });
    expect(fs.existsSync(dataPath(G))).toBe(true);
    expect(graveyardEntries(G)).toEqual([]);
  });

  it('the graveyard move refuses at the rename once the writer was lost', async () => {
    const G = freshGuildId();
    fs.mkdirSync(dataPath(G, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'm', 'a.json'), '{"v":1}');
    expect(await graveyardGuildDir(G, 'test', () => true)).toBe(false);
    expect(fs.readFileSync(dataPath(G, 'm', 'a.json'), 'utf8')).toBe('{"v":1}');
    expect(graveyardEntries(G)).toEqual([]);
  });

  it('a restore after a deposition leaves the graveyard entry and creates no live dir', async () => {
    const G = freshGuildId();
    const entry = dataPath('_graveyard', `${G}-1000`);
    fs.mkdirSync(path.join(entry, 'm'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'm', 'a.json'), '{"old":1}');
    expect(takeWriterLock().kind).toBe('taken');
    deposeBy('bot');
    const restored = await restoreGuildFromGraveyard(G, 1000);
    expect(restored.ok).toBe(false);
    expect((restored as { error?: string }).error).toContain('nothing was restored');
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(fs.readFileSync(path.join(entry, 'm', 'a.json'), 'utf8')).toBe('{"old":1}');
    const reply = await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'restore-graveyard', contentJson: '{"retiredAt":1000}' } as any);
    expect(reply).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText({ role: 'bot', pid: OTHER }) });
    expect(fs.existsSync(dataPath(G))).toBe(false);
    fs.rmSync(entry, { recursive: true, force: true });
  });
});

describe('a bundle import deposed before its swap (D2)', () => {
  it('throws naming the other process, leaves the live dir as it was and removes the staging dir', async () => {
    const G = freshGuildId();
    fs.mkdirSync(dataPath(G, 'mod'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'mod', 'a.json'), '{"a":1}');
    const bundle = dataPath(`nb10fix4-${G}.bundle`);
    await writeBundle(G, bundle);
    fs.writeFileSync(dataPath(G, 'mod', 'a.json'), '{"a":2}');
    freshLock('import');
    const liveDir = path.resolve(dataPath(G));
    h.onStat = p => {
      if (p === liveDir) fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
    };
    await expect(importBundle(bundle)).rejects.toThrow(
      `[DataInterchange] Another process (a bot process, pid ${OTHER}) took the data files during the import; the live guild dir was not touched`);
    expect(fs.readFileSync(dataPath(G, 'mod', 'a.json'), 'utf8')).toBe('{"a":2}');
    expect(graveyardEntries(G)).toEqual([]);
    expect(fs.readdirSync(dataPath()).filter(n => n.startsWith(`.bundle-import-${G}`))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
    fs.rmSync(bundle, { force: true });
  });
});

describe("cancelQueued's answer for an entry another cancel removed (D3)", () => {
  const A = () => path.resolve(dataPath('global', 'nb10fix4', 'a.json'));
  const B = () => path.resolve(dataPath('global', 'nb10fix4', 'b.json'));

  it('answers cancelled, not landed, when a deposition cancelled the paths during the wait and nothing landed', async () => {
    h.failRename.add(B());
    enqueueWrite(B(), '{"b":1}');
    await tick(20);
    let open!: () => void;
    h.holdRename = { target: A(), promise: new Promise<void>(resolve => { open = resolve; }) };
    h.failRename.add(A());
    enqueueWrite(A(), '{"a":1}');
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    expect(fileFlushOnTheWire()).toBe(true);
    const local = cancelQueued([A(), B()], () => tick(60));
    const deposition = cancelQueued([A(), B()], undefined, { freeze: true });
    await tick(5);
    open();
    const byDeposition = await deposition;
    const byLocal = await local;
    expect(byDeposition.map(r => r.outcome)).toEqual(['cancelled', 'cancelled']);
    expect(byLocal.map(r => r.outcome)).toEqual(['cancelled', 'cancelled']);
    expect(fs.existsSync(A())).toBe(false);
    expect(fs.existsSync(B())).toBe(false);
  });

  it('still answers landed for a path whose flush landed during the wait', async () => {
    let open!: () => void;
    h.holdRename = { target: A(), promise: new Promise<void>(resolve => { open = resolve; }) };
    enqueueWrite(A(), '{"a":2}');
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    const done = cancelQueued([A()]);
    await tick(5);
    open();
    expect(await done).toEqual([{ path: A(), outcome: 'landed' }]);
    expect(fs.readFileSync(A(), 'utf8')).toBe('{"a":2}');
  });
});

function fakeRes() {
  const out: { status: number | null; body: any } = { status: null, body: null };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  return { res, out };
}

describe('a shared op answered pending while the bot restarts (D4)', () => {
  it('carries stopping and the restart text, and the route answers 503 with that text', async () => {
    freshLock('webui');
    h.pendingVerdict = true;
    h.stopping = true;
    const reply: any = await applySharedOp({ op: 'global.write', args: { rel: 'nb10fix4/x.json', contentJson: '{"x":1}', expectSha: 'absent' } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'pending', stopping: true });
    expect(reply.error).toBe('The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.');
    const { res, out } = fakeRes();
    sendHopReply(res, reply);
    expect(out).toEqual({ status: 503, body: { success: false, error: reply.error } });
  });

  it('a pending answer outside a stop still reads accepted', async () => {
    freshLock('webui');
    h.pendingVerdict = true;
    const reply: any = await applySharedOp({ op: 'global.write', args: { rel: 'nb10fix4/y.json', contentJson: '{"y":1}', expectSha: 'absent' } });
    expect(reply.stopping).toBeUndefined();
    const { res, out } = fakeRes();
    sendHopReply(res, reply);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ success: true, pending: true });
  });
});
