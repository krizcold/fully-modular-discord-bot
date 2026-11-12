import fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The deposition's poll looks at a try on the wire every 5 ms. These tests hold that poll's timer, so a try can end
// with the poll not yet run: the exit's lines, and the drain's wait for the answers, are read inside that window.

const h = vi.hoisted(() => ({ answerEnded: true }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<any>();
  return { ...real, answerEndedTries: () => { if (h.answerEnded) real.answerEndedTries?.(); } };
});

import { dataPath } from '../../src/utils/dataRoot';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { drainForExit, nameDeposedWritesLeft, reopenSharedWrites, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { fileFlushOnTheWire, queuedFileWrites } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { freshWriterLock } from '../helpers/nb10Rig';

const OTHER = 6293;
const WORDS = `another process (a bot process, pid ${OTHER}) took the data files' lock`;
const where = { scope: 'global' as const, category: 'nb32' };
const file = (name: string) => dataPath('global', 'nb32', name);
const role = process.env.BOT_PROCESS_ROLE;
const notSaved = (p: string) => `[Data] Not saved: ${p}; ${WORDS}`;
const stillRunning = (p: string) => `[Data] Can't confirm whether ${p} is saved: its write was still running when ${WORDS}, and this process exits before it ends`;
const unknownEnd = (p: string) => `[Data] Can't confirm whether ${p} is saved: ${WORDS}, and this process exits before it knows how the write ended`;

let errors: string[] = [];
const naming = (p: string) => errors.filter(line => line.includes(p) && !line.startsWith('[DataManager] Flush failed for'));

// The 5 ms timers made while holding, run on release.
let holding = false;
const held: Array<() => void> = [];
const release = () => {
  holding = false;
  for (const run of held.splice(0)) run();
};

// A try of the named file waits on its gate inside its open, then fails with ENOSPC or goes on.
const gates = new Map<string, { open: () => void; fail: boolean; reached: boolean; promise: Promise<void> }>();
function gated(name: string, fail: boolean) {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  const gate = { open, fail, reached: false, promise };
  gates.set(file(name), gate);
  return gate;
}

async function deposeWith(name: string, fail: boolean) {
  const gate = gated(name, fail);
  freshWriterLock('webui', new Set([process.pid, OTHER]));
  expect(takeWriterLock().kind).toBe('taken');
  expect(saveDataTracked(name, where, { v: name }).outcome).toBe('saved');
  await vi.waitFor(() => expect(gate.reached).toBe(true), { timeout: 5_000, interval: 10 });
  holding = true;
  errors = [];
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: OTHER } });
  expect(held.length).toBeGreaterThan(0);
  expect(naming(file(name))).toEqual([]);
  return gate;
}

async function endTry(gate: { open: () => void }) {
  gate.open();
  await vi.waitFor(() => expect(fileFlushOnTheWire()).toBe(false), { timeout: 5_000, interval: 10 });
}

beforeAll(() => {
  delete process.env.BOT_PROCESS_ROLE;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(String(args[0])); });
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    if (holding && ms === 5) {
      held.push(() => fn(...rest));
      return realTimeout(() => undefined, 0);
    }
    return realTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
  const realOpen = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    const name = String(p);
    for (const [target, gate] of gates) {
      if (name.startsWith(`${target}.`) && name.endsWith('.tmp')) {
        gates.delete(target);
        gate.reached = true;
        await gate.promise;
        if (gate.fail) throw Object.assign(new Error('ENOSPC: injected flush failure'), { code: 'ENOSPC' });
      }
    }
    return (realOpen as any)(p, ...rest);
  }) as typeof fs.promises.open);
  fs.rmSync(dataPath('global', 'nb32'), { recursive: true, force: true });
});

afterEach(async () => {
  release();
  h.answerEnded = true;
  await vi.waitFor(() => expect(fileFlushOnTheWire()).toBe(false), { timeout: 5_000, interval: 10 });
});

afterAll(() => {
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  reopenSharedWrites();
  fs.rmSync(dataPath('global', 'nb32'), { recursive: true, force: true });
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the exit right after a try a deposition waited on ended, before the poll looked again', () => {
  it('names the answer that try left (not saved), never a write still running', async () => {
    const gate = await deposeWith('a.json', true);
    await endTry(gate);
    nameDeposedWritesLeft();
    expect(naming(file('a.json'))).toEqual([notSaved(file('a.json'))]);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(naming(file('a.json'))).toEqual([notSaved(file('a.json'))]);
  });

  it('with no answer to read, says it cannot know how the write ended, never that it still runs', async () => {
    h.answerEnded = false;
    const gate = await deposeWith('b.json', true);
    await endTry(gate);
    nameDeposedWritesLeft();
    expect(naming(file('b.json'))).toEqual([unknownEnd(file('b.json'))]);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(naming(file('b.json'))).toEqual([unknownEnd(file('b.json'))]);
  });

  it('still says a write runs while its try is on the wire', async () => {
    const gate = await deposeWith('c.json', false);
    nameDeposedWritesLeft();
    expect(naming(file('c.json'))).toEqual([stillRunning(file('c.json'))]);
    await endTry(gate);
  });
});

describe('the exit drain after a deposition', () => {
  it('waits for the answer of a try that landed before the poll looked, then ends within its bound', async () => {
    const gate = await deposeWith('d.json', false);
    await endTry(gate);
    expect(queuedFileWrites()).toBe(0);
    let drained = false;
    const started = Date.now();
    const drain = drainForExit(3_000).then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(drained).toBe(false);
    release();
    await drain;
    expect(Date.now() - started).toBeLessThan(2_000);
    nameDeposedWritesLeft();
    expect(naming(file('d.json'))).toEqual([]);
  });
});
