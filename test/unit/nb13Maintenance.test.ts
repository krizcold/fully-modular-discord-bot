import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendData, deleteData, drainForExit, flushAll, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { flushAll as flushAllFiles, graveyardGuildDir, unconfirmedFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  enterMaintenance,
  heldForContent,
  restartForShards,
  startLeave,
} from '../../src/bot/internalSetup/utils/maintenance';
import { BotManager, childHeldOf } from '../../src/webui/botManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { stubAppendHandles } from '../helpers/fileHandleStub';

// NB13 decision 6 and C12: a guild whose only held item is a save the database did not answer, and a file whose
// appended lines the disk did not confirm, are named apart and never as unsaved.

const NOT_UNSAVED = ['could not be saved', 'unsaved', 'unflushed writes', 'drops them'];
const sent: any[] = [];
const logs: string[] = [];
let guilds = 5_300_000;
const realSend = process.send;

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  logs.length = 0;
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 20, restartResendMs: 60_000, leaveSaveBoundMs: 100, heldAfterPasses: 2 });
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(async () => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One store for the file; each guild added hydrated on it. */
function storeRig() {
  setBackendKind('postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const add = async () => {
    const g = String(++guilds);
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    return g;
  };
  return { store, ws, add };
}

/** A guild holding only a batch whose COMMIT got no answer; checks fail while the store's checkMode is 'unknown'. */
async function unansweredOnly(r: ReturnType<typeof storeRig>) {
  const g = await r.add();
  saveData('a.json', { guildId: g, category: 'm' }, { v: 1 });
  r.store.mode = 'landed-unanswered';
  expect(await r.ws.flushGuildNow(g, 50)).toBe('pending');
  r.store.mode = 'commit';
  r.store.checkMode = 'unknown';
  return g;
}

/** A guild whose writes the store refuses: plain 'unavailable', dirty. */
async function dirty(r: ReturnType<typeof storeRig>) {
  const g = await r.add();
  const real = r.store.flushGuild.bind(r.store);
  const prior = r.store.flushGuild;
  r.store.flushGuild = (async (guildId, batch, token) => guildId === g
    ? { ok: false, reason: 'unavailable', detail: 'Connection refused' }
    : prior.call(r.store, guildId, batch, token)) as typeof real;
  saveData('b.json', { guildId: g, category: 'm' }, { v: 1 });
  return g;
}

const linesNaming = (g: string) => logs.filter(l => l.includes(g));
const expectNotUnsaved = (lines: string[]) => { for (const l of lines) for (const w of NOT_UNSAVED) expect(l).not.toContain(w); };

describe('5.1 and 5.2: maintenance enter', () => {
  it('5.1 one unanswered-only guild answers saved null, and the web UI maps it with no warning', async () => {
    const r = storeRig();
    const g = await unansweredOnly(r);
    const answer = await enterMaintenance('m', { saveBoundMs: 200 });
    expect(answer).toEqual({ saved: null, unansweredGuilds: 1, unconfirmedFiles: 0 });
    expectNotUnsaved(logs.filter(l => l.startsWith('[Maintenance]')));
    expectNotUnsaved(linesNaming(g));
    const warn = vi.spyOn(console, 'warn');
    warn.mockClear();
    const call = (BotManager.prototype as any).enterMaintenance.call({
      isRunning: () => true, botProcess: {}, stageReached: () => true, sendIPCMessage: vi.fn(async () => answer),
    }, 'm');
    expect(await call).toEqual({
      saved: null, unansweredGuilds: 1, unconfirmedFiles: 0,
      note: "1 guild(s) hold a save the database did not answer, which may have landed; can't confirm whether the held changes were saved",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('5.2 an unanswered-only guild beside a dirty one, and one guild holding both', async () => {
    const r = storeRig();
    await unansweredOnly(r);
    const d = await dirty(r);
    const answer = await enterMaintenance('m', { saveBoundMs: 200 });
    expect(answer).toEqual({ saved: false, unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 1, unconfirmedFiles: 0 });
    const mapped = await (BotManager.prototype as any).enterMaintenance.call({
      isRunning: () => true, botProcess: {}, stageReached: () => true, sendIPCMessage: vi.fn(async () => answer),
    }, 'm');
    expect(mapped.note).toBe('1 guild(s) and 0 file(s) hold changes that could not be saved; 1 guild(s) hold a save the database did not answer, which may have landed');
    expect(linesNaming(d).some(l => l.includes('hold changes that could not be saved'))).toBe(false);

    _resetMaintenance();
    const both = storeRig();
    const g = await unansweredOnly(both);
    saveData('c.json', { guildId: g, category: 'm' }, { v: 2 });
    expect(await enterMaintenance('m', { saveBoundMs: 200 })).toMatchObject({ saved: false, unsavedGuilds: 1, unansweredGuilds: 1 });
  });
});

describe('5.3 the full flush names an unanswered-only guild apart', () => {
  it('flushAll', async () => {
    const r = storeRig();
    const g = await unansweredOnly(r);
    const d = await dirty(r);
    await flushAll();
    expect(logs).toContain(`[Data] A full flush left guild(s) ${g} holding a save whose COMMIT got no answer, which may have landed`);
    expect(logs).toContain(`[Data] A full flush left 1 guild(s) with unflushed writes: ${d}`);
    expectNotUnsaved(linesNaming(g));
  });
});

describe('5.4, 5.5, 5.6 and 5.9: the leave and the migration texts', () => {
  it('5.4 the leave names an unanswered-only guild apart, reports it, and restarts once the check answers landed', async () => {
    const r = storeRig();
    const g = await unansweredOnly(r);
    startLeave('The hook says running');
    await vi.waitFor(() => expect(logs.some(l => l.includes('holding only a save'))).toBe(true), { timeout: 5000 });
    const pass = logs.find(l => l.includes('tries again in'))!;
    expect(pass).toBe('[Maintenance] 1 guild(s) hold a save the database did not answer, which may have landed; the bot process keeps them and tries again in 0 s');
    const held = logs.find(l => l.includes('holding only a save'))!;
    expect(held).toContain(`left guild(s) ${g} holding only a save the database did not answer, which may have landed`);
    expect(held).toContain('which drops every change not stored');
    expectNotUnsaved([pass, held]);
    expect(sent.find(m => m.type === 'maintenance:mode' && m.data.mode === 'held')?.data.held).toEqual({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 1 });
    r.store.checkMode = 'answer';
    await vi.waitFor(() => expect(sent.some(m => m.type === 'control:restart-bot')).toBe(true), { timeout: 5000 });
  });

  it('5.4 the held line names the dirty guild, never a stream whose append a short write left queued empty', async () => {
    const r = storeRig();
    const d = await dirty(r);
    const stub = stubAppendHandles();
    const name = `nb13f2-${guilds}.jsonl`;
    const at = /nb13f2-\d+\.jsonl$/;
    stub.shortWrite(at, text => text.length - 1, 1);
    stub.failWrite(at, 'ENOSPC', 10_000);
    appendData(name, { scope: 'global', category: 'm' }, 'x\n');
    await vi.waitFor(() => expect(stub.writes.some(w => w.text.endsWith('x\n') && w.accepted > 0)).toBe(true), { timeout: 5000 });
    try {
      startLeave('The hook says running');
      await vi.waitFor(() => expect(logs.some(l => l.includes('left changes unsaved'))).toBe(true), { timeout: 5000 });
      const held = logs.find(l => l.includes('left changes unsaved'))!;
      expect(held).toContain(`left changes unsaved: guild ${d} (`);
      expect(held).not.toContain(name);
      expect(sent.find(m => m.type === 'maintenance:mode' && m.data.mode === 'held')?.data.held).toEqual({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 0 });
    } finally {
      stub.restore();
    }
  });

  it('5.4 and 5.9 with canRestart false: the stop variant', async () => {
    (process as { send?: unknown }).send = undefined;
    _setMaintenanceSender(null);
    const r = storeRig();
    await unansweredOnly(r);
    startLeave('The hook says running');
    await vi.waitFor(() => expect(logs.some(l => l.includes('holding only a save'))).toBe(true), { timeout: 5000 });
    const held = logs.find(l => l.includes('holding only a save'))!;
    expect(held.endsWith('the bot process keeps running and does not stop until they are saved or found stored or the operator stops it, which drops every change not stored')).toBe(true);
    expect(held).not.toContain('which drops them');
    r.store.checkMode = 'answer';
  });

  it('5.9 with canRestart true and a restart asked earlier: the restart variant', async () => {
    const r = storeRig();
    await unansweredOnly(r);
    expect(restartForShards('take shard 1', () => null)).toBe(true);
    startLeave('The hook says running');
    await vi.waitFor(() => expect(logs.some(l => l.includes('holding only a save'))).toBe(true), { timeout: 5000 });
    const held = logs.find(l => l.includes('holding only a save'))!;
    expect(held.endsWith('the bot process keeps running and does not restart until they are saved or found stored or the operator restarts it, which drops every change not stored; a restart this process asked for earlier may still stop it, which drops every change not stored')).toBe(true);
    expect(held).not.toContain('which drops them');
    r.store.checkMode = 'answer';
  });

  it("5.9 a P2 flight whose set kept a content code: heldForContent is false and the leave never restarts for content", async () => {
    vi.useFakeTimers();
    const r = storeRig();
    const g = await r.add();
    saveData('a.json', { guildId: g, category: 'm' }, { v: 1 });
    r.store.mode = 'unavailable';
    r.store.failCode = '23503';
    const first = r.ws.flushGuildNow(g, 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBe('held');
    r.store.failCode = null;
    r.store.mode = 'commit-hang';
    void r.ws.flushGuildNow(g, 120_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.ws.heldGuilds()).toEqual([{ guildId: g, reason: 'the store did not take the flush', code: '23503' }]);
    expect(r.ws.unansweredGuilds().all).toEqual([g]);
    expect(heldForContent()).toBe(false);
    startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(2000);
    expect(logs.some(l => l.includes('refuses for their content') || l.includes('refuses these for their content'))).toBe(false);
    expect(sent.some(m => m.type === 'control:restart-bot')).toBe(false);
    r.store.mode = 'commit';
    r.store.release();
    await vi.advanceTimersByTimeAsync(100);
  });

  const state = (over: object) => (BotManager.prototype as any).migrationBotState.call({
    operationInProgress: false, stoppingRestart: false, queuedRestart: false, isRunning: () => true,
    childMaintenanceBoot: false, childModeReported: true, childEnterAnswer: null, childHeld: null, ...over,
  });

  it('5.5 migrationBotState in held', () => {
    expect(state({ childMode: 'held', childHeld: { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 1 } })).toEqual({
      ok: false, error: "can't confirm whether every change the bot held is saved: 1 guild(s) hold a save the database did not answer, which may have landed",
    });
    expect(state({ childMode: 'held', childHeld: { unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 1 } })).toEqual({
      ok: false, error: 'The bot holds unsaved changes (1 guilds, 0 files); a stop or restart drops them; 1 guild(s) hold a save the database did not answer, which may have landed',
    });
  });

  it('5.6 migrationBotState in maintenance after a null and a false enter answer', () => {
    expect(state({ childMode: 'maintenance', childEnterAnswer: { saved: null, unansweredGuilds: 1, unconfirmedFiles: 0 } })).toEqual({
      ok: false, error: "can't confirm whether every change the bot held is saved: 1 guild(s) hold a save the database did not answer, which may have landed",
    });
    expect(state({ childMode: 'maintenance', childEnterAnswer: { saved: false, unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 1, unconfirmedFiles: 0 } })).toEqual({
      ok: false, error: 'The bot holds unsaved changes (1 guilds, 0 files); a stop or restart drops them; 1 guild(s) hold a save the database did not answer, which may have landed',
    });
  });

  it('the maintenance:mode report keeps unansweredGuilds in childHeld, 0 when absent', () => {
    const self: any = { emitEvent: () => undefined, getStatus: () => ({}) };
    const handle = (held: object) => {
      self.childMode = 'held';
      self.childHeld = childHeldOf('held', held);
      return self.childHeld;
    };
    expect(handle({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 2 })).toEqual({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 2 });
    expect(handle({ unsavedGuilds: 1, unsavedFiles: 0 })).toEqual({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 0 });
  });
});

describe('5.8: a JSON append whose file fsync failed', () => {
  it('enter answers saved null with the file clause until a delete of the stream lands; a retire keeps the count', async () => {
    setBackendKind('file');
    const stub = stubAppendHandles();
    const before = unconfirmedFiles();
    const g = String(++guilds);
    stub.failSync(/nb13m\.jsonl$/, 'EIO', 1);
    appendData('nb13m.jsonl', { guildId: g, category: 'm' }, 'x');
    await flushAllFiles();
    expect(unconfirmedFiles()).toBe(before + 1);
    expect(await enterMaintenance('m', { saveBoundMs: 200 })).toEqual({ saved: null, unansweredGuilds: 0, unconfirmedFiles: before + 1 });
    expect(logs).toContain(`[Maintenance] ${before + 1} file(s) hold appended lines the disk did not confirm; can't confirm whether they are stored; can't confirm whether every change this process held is saved`);
    _resetMaintenance();
    appendData('nb13m.jsonl', { guildId: g, category: 'm' }, 'y');
    await flushAllFiles();
    expect(await enterMaintenance('m', { saveBoundMs: 200 })).toMatchObject({ saved: null });
    startLeave('The hook says running');
    await vi.waitFor(() => expect(sent.some(m => m.type === 'control:restart-bot')).toBe(true), { timeout: 5000 });
    _resetMaintenance();
    deleteData('nb13m.jsonl', { guildId: g, category: 'm' });
    await flushAllFiles();
    expect(unconfirmedFiles()).toBe(before);

    const g2 = String(++guilds);
    stub.failSync(/nb13r\.jsonl$/, 'EIO', 1);
    appendData('nb13r.jsonl', { guildId: g2, category: 'm' }, 'x');
    await flushAllFiles();
    expect(unconfirmedFiles()).toBe(before + 1);
    expect(await graveyardGuildDir(g2, 'test')).toBe(true);
    expect(unconfirmedFiles()).toBe(before + 1);
    stub.restore();
  });

  it('the short-write entry left empty counts as unconfirmed, never as unsaved', async () => {
    setBackendKind('file');
    const stub = stubAppendHandles();
    const g = String(++guilds);
    stub.shortWrite(/nb13s\.jsonl$/, text => text.length - 1, 1);
    stub.failWrite(/nb13s\.jsonl$/, 'ENOSPC', 100);
    appendData('nb13s.jsonl', { guildId: g, category: 'm' }, 'x\n');
    await flushAllFiles();
    const answer = await enterMaintenance('m', { saveBoundMs: 200 });
    expect(answer).toMatchObject({ saved: null, unansweredGuilds: 0 });
    expect((answer as { unconfirmedFiles: number }).unconfirmedFiles).toBeGreaterThan(0);
    expectNotUnsaved(logs.filter(l => l.startsWith('[Maintenance]')));
    stub.restore();
  });
});

describe('5.3 and 5.7: the exit drain (last: it closes writes for the process)', () => {
  it('names a flight whose COMMIT got no answer and an unanswered-only guild apart, the dirty one as unflushed', async () => {
    vi.useFakeTimers();
    const r = storeRig();
    const p3 = await unansweredOnly(r);
    const d = await dirty(r);
    const p2 = await r.add();
    saveData('h.json', { guildId: p2, category: 'm' }, { v: 1 });
    const prior = r.store.flushGuild;
    r.store.flushGuild = (async (guildId, batch, token) => {
      if (guildId !== p2) return prior.call(r.store, guildId, batch, token);
      batch.commitSent = true;
      return new Promise(() => undefined);
    }) as typeof prior;
    void r.ws.flushGuildNow(p2, 120_000);
    const committedAt = Date.now();
    await vi.advanceTimersByTimeAsync(10);
    expect(await (async () => { const a = enterMaintenance('m', { saveBoundMs: 3_000 }); await vi.advanceTimersByTimeAsync(4_000); return a; })())
      .toMatchObject({ saved: false, unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 2 });
    // The real client answers a COMMIT with no answer at 40 s: a drain started within 10 s ends while p2 is still in P2.
    expect(Date.now() - committedAt).toBeLessThan(10_000);
    const drain = drainForExit(30_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await drain;
    expect(Date.now() - committedAt).toBeLessThan(40_000);
    expect(logs).toContain(`[Data] Shutdown drain left 1 guild(s) with unflushed writes: ${d}`);
    expect(logs).toContain(`[Data] Shutdown drain left guild(s) ${[p3, p2].join(', ')} holding a save whose COMMIT got no answer, which may have landed`);
    expectNotUnsaved(logs.filter(l => l.startsWith('[Data] Shutdown drain') && !l.includes(d)));
  });
});
