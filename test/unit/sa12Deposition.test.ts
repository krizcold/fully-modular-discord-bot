import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CancelOutcome } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// A deposition of the writer lock: the queued shared writes it cancels are named by their answers, and the exit's
// helpers read what is left. The file queue is a stand-in whose cancel answers when the test says.

type Deposed = { answered: () => Promise<void>; nameLeft: () => void };
const h = vi.hoisted(() => ({
  paths: [] as string[],
  settle: null as null | ((results: unknown[]) => void),
  endedFails: null as Error | null,
  deposed: null as null | { answered: () => Promise<void>; nameLeft: () => void },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    queuedFilePaths: () => [...h.paths],
    pathOnTheWire: () => false,
    answerEndedTries: () => {
      if (h.endedFails) throw h.endedFails;
    },
    cancelQueued: () => new Promise(resolve => { h.settle = resolve as (results: unknown[]) => void; }),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    useDeposedWrites: (given: Deposed | null) => {
      if (given) h.deposed = given;
      real.useDeposedWrites(given);
    },
  };
});

import { checkWriterLock, configureWriterLock, takeWriterLock, unconfirmedWords, writerLockDepth, releaseWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';

const OTHER = 5353;
const BY = `another process (a bot process, pid ${OTHER}) took the data files' lock`;
let errors: unknown[][] = [];

function depose(paths: string[]): Deposed {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  const live = new Set([process.pid, OTHER]);
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  expect(takeWriterLock().kind).toBe('taken');
  h.paths = paths;
  h.settle = null;
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
  expect(h.settle).not.toBeNull();
  return h.deposed!;
}

/** How many microtask turns a promise takes to settle, at most 50. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  void p.then(() => { done = true; });
  let n = 0;
  while (!done && n < 50) {
    await Promise.resolve();
    n += 1;
  }
  return n;
}

const lines = () => errors.map(args => args.map(String).join(' '));

beforeEach(() => {
  errors = [];
  h.endedFails = null;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('the writes a deposition cancelled', () => {
  it('logs each write the cancel answered at its end, and the exit names none of them again', async () => {
    const a = dataPath('global', 'sa12dep', 'a.json');
    const b = dataPath('global', 'sa12dep', 'b.jsonl');
    const deposed = depose([a, b]);
    const unconfirmed: CancelOutcome = { path: b, outcome: 'unconfirmed', errno: 'EIO', cut: false };
    h.settle!([{ path: a, outcome: 'cancelled', errno: null }, unconfirmed]);
    await deposed.answered();
    expect(lines()).toContain(`[Data] Not saved: ${a}; ${BY}`);
    expect(lines()).toContain(`${unconfirmedWords(unconfirmed)}; ${BY}`);
    errors = [];
    deposed.nameLeft();
    expect(lines().filter(l => l.includes(a) || l.includes(b))).toEqual([]);
  });

  it('logs a failed read of the ended writes at the exit, and still names the writes left', () => {
    const a = dataPath('global', 'sa12dep', 'c.json');
    const deposed = depose([a]);
    const failure = new Error('sa12 look failed');
    h.endedFails = failure;
    errors = [];
    expect(() => deposed.nameLeft()).not.toThrow();
    expect(errors).toContainEqual(['[Data] Could not read the answers of the writes a deposition cancelled:', failure]);
    expect(lines()).toContain(`[Data] Can't confirm whether ${a} is saved: another process (a bot process, pid ${OTHER}) took the data files' lock, and this process exits before it knows how the write ended`);
    h.settle!([]);
  });

  it('once the cancel answered, answered() settles as fast as with nothing pending', async () => {
    const deposed = depose([dataPath('global', 'sa12dep', 'd.json')]);
    h.settle!([]);
    await deposed.answered();
    const idle = await turns(Promise.allSettled([]).then(() => undefined));
    expect(await turns(deposed.answered())).toBe(idle);
  });
});
