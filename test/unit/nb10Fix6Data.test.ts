import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 5 (NB10-R6-O2 and test 26 case c's cause), the fixer's regression tests: a JSON bot's
// operator guild write that a deposition cancelled before it landed answers the deposed text, and a verdict over a
// write the deposition cancelled answers writer-lost.

const h = vi.hoisted(() => ({ hold: null as null | { target: string; promise: Promise<void> }, fail: new Set<string>() }));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const promises = {
    ...real.promises,
    rename: async (from: any, to: any) => {
      const target = path.resolve(String(to));
      if (h.hold && target === h.hold.target) await h.hold.promise;
      if (h.fail.has(target)) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      return real.promises.rename(from, to);
    },
  };
  const wrapped = { ...real, promises };
  return { ...wrapped, default: wrapped };
});

import { fileFlushOnTheWire, flushAll as flushFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, deposedText, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { dataPath } from '../../src/utils/dataRoot';

const OTHER = 4949;
const live = new Set<number>([process.pid, OTHER]);
const seams = { pid: () => process.pid, alive: (p: number) => live.has(p), startOf: () => null, now: () => Date.now() };
const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
let guildSeq = 0;
const freshGuildId = () => `9000000000006${String(Date.now() % 100000).padStart(5, '0')}${++guildSeq}`;
const role = process.env.BOT_PROCESS_ROLE;

function freshLock(): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  configureWriterLock('bot', seams);
}

function deposeBy(holderRole: string): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: holderRole, at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** The flush of this file waits on the wire until released, and then fails as a full disk does. */
async function holdThenFail(file: string): Promise<() => void> {
  let open!: () => void;
  h.hold = { target: file, promise: new Promise<void>(resolve => { open = resolve; }) };
  h.fail.add(file);
  return () => open();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.hold = null;
  h.fail.clear();
  delete process.env.BOT_PROCESS_ROLE;
  freshLock();
});

afterEach(async () => {
  h.hold = null;
  h.fail.clear();
  freshLock();
  expect(takeWriterLock().kind).toBe('taken');
  releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await flushFiles();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('a write a deposition cancelled before it landed (O2, test 26 case c)', () => {
  it("an operator guild write answers held-elsewhere with the holder's text, and names no unload, delete or restore", async () => {
    const G = freshGuildId();
    saveData('a.json', { guildId: G, category: 'm' }, { v: 1 });
    await flushAll();
    const file = path.resolve(dataPath(G, 'm', 'a.json'));
    expect(takeWriterLock().kind).toBe('taken');
    const release = await holdThenFail(file);
    const writing = applyOperatorDataWrite({ guildId: G, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"v":2}' } as any);
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    expect(fileFlushOnTheWire()).toBe(true);
    deposeBy('import');
    release();
    const reply: any = await writing;
    expect(reply).toEqual({ ok: false, code: 'held-elsewhere', error: deposedText({ role: 'import', pid: OTHER }) });
    expect(reply.error).not.toMatch(/unloaded|graveyard/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 1 });
  });

  it('a verdict over a queued write the deposition cancelled answers writer-lost, not unavailable', async () => {
    const G = freshGuildId();
    saveData('b.json', { guildId: G, category: 'm' }, { v: 1 });
    await flushAll();
    const file = path.resolve(dataPath(G, 'm', 'b.json'));
    expect(takeWriterLock().kind).toBe('taken');
    const release = await holdThenFail(file);
    const verdict = runSealed('console', null, null, async ledger => {
      saveData('b.json', { guildId: G, category: 'm' }, { v: 2 });
      for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
      expect(fileFlushOnTheWire()).toBe(true);
      deposeBy('bot');
      release();
      return verdictOf([ledger]);
    });
    expect(await verdict).toEqual({ ok: false, answer: 'writer-lost', partial: false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 1 });
  });
});
