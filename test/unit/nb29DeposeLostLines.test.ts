import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { drainForExit, nameDeposedWritesLeft, reopenSharedWrites, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { fileFlushOnTheWire } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { freshWriterLock } from '../helpers/nb10Rig';

const OTHER = 6291;
const WORDS = `another process (a bot process, pid ${OTHER}) took the data files' lock`;
const where = { scope: 'global' as const, category: 'nb29' };
const A = dataPath('global', 'nb29', 'a.json');
const B = dataPath('global', 'nb29', 'b.json');
const C = dataPath('global', 'nb29', 'c.json');
const role = process.env.BOT_PROCESS_ROLE;

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

const gateB = gate();
const gateC = gate();
const opened = new Set<string>();
let errors: string[] = [];
let atDeposition: string[] = [];
const notSaved = (p: string) => `[Data] Not saved: ${p}; ${WORDS}`;
const cantConfirm = (p: string) => `[Data] Can't confirm whether ${p} is saved: its write was still running when ${WORDS}, and this process exits before it ends`;
const naming = (p: string) => errors.filter(line => line.includes(p) && !line.startsWith('[DataManager] Flush failed for'));

beforeAll(async () => {
  delete process.env.BOT_PROCESS_ROLE;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(String(args[0])); });
  const real = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    const file = String(p);
    if (file.startsWith(`${B}.`) && file.endsWith('.tmp')) {
      opened.add(B);
      await gateB.promise;
      throw Object.assign(new Error('ENOSPC: injected flush failure'), { code: 'ENOSPC' });
    }
    if (file.startsWith(`${C}.`) && file.endsWith('.tmp')) {
      opened.add(C);
      await gateC.promise;
    }
    return (real as any)(p, ...rest);
  }) as typeof fs.promises.open);
  fs.rmSync(dataPath('global', 'nb29'), { recursive: true, force: true });
  freshWriterLock('webui', new Set([process.pid, OTHER]));
  expect(takeWriterLock().kind).toBe('taken');
  expect(saveDataTracked('b.json', where, { v: 'b' }).outcome).toBe('saved');
  expect(saveDataTracked('c.json', where, { v: 'c' }).outcome).toBe('saved');
  await vi.waitFor(() => expect([...opened].sort()).toEqual([B, C].sort()), { timeout: 5_000, interval: 5 });
  expect(saveDataTracked('a.json', where, { v: 'a' }).outcome).toBe('saved');
  errors = [];
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: OTHER } });
  atDeposition = [...errors];
});

afterAll(async () => {
  gateB.open();
  gateC.open();
  await vi.waitFor(() => expect(fileFlushOnTheWire()).toBe(false), { timeout: 5_000, interval: 10 });
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  reopenSharedWrites();
  fs.rmSync(dataPath('global', 'nb29'), { recursive: true, force: true });
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a deposition while two flush tries are on the wire', () => {
  it('names the path not on the wire at once, and neither path on the wire yet', () => {
    expect(atDeposition).toContain(notSaved(A));
    expect(atDeposition.filter(line => line.includes(B) || line.includes(C))).toEqual([]);
  });

  it('names the path whose try fails as not saved when that try ends, while the other try still runs', async () => {
    gateB.open();
    await vi.waitFor(() => expect(errors).toContain(notSaved(B)), { timeout: 2_000, interval: 5 });
    expect(fileFlushOnTheWire()).toBe(true);
    expect(naming(C)).toEqual([]);
  });

  it('names the path still on the wire at the exit with a can\'t-confirm line right before the exit, not at the drain\'s end', async () => {
    await drainForExit(600);
    expect(fileFlushOnTheWire()).toBe(true);
    expect(naming(C)).toEqual([]);
    nameDeposedWritesLeft();
    expect(errors).toContain(cantConfirm(C));
  });

  it('names each lost write once and none as saved, even when the last try lands after the exit drain', async () => {
    gateC.open();
    await vi.waitFor(() => expect(fileFlushOnTheWire()).toBe(false), { timeout: 5_000, interval: 10 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(naming(A)).toEqual([notSaved(A)]);
    expect(naming(B)).toEqual([notSaved(B)]);
    expect(naming(C)).toEqual([cantConfirm(C)]);
    expect(errors.filter(line => /\bsaved\b/i.test(line) && !line.includes('Not saved:') && !line.startsWith("[Data] Can't confirm whether"))).toEqual([]);
  });
});
