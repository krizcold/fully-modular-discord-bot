import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { fileFlushOnTheWire } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { freshWriterLock } from '../helpers/nb10Rig';
import { stopSteps } from '../helpers/stopRig';

const OTHER = 6292;
const WORDS = `another process (a bot process, pid ${OTHER}) took the data files' lock`;
const where = { scope: 'global' as const, category: 'nb29after' };
const C = dataPath('global', 'nb29after', 'c.json');
const role = process.env.BOT_PROCESS_ROLE;
const cantConfirm = `[Data] Can't confirm whether ${C} is saved: its write was still running when ${WORDS}, and this process exits before it ends`;

let openC!: () => void;
const gateC = new Promise<void>(resolve => { openC = resolve; });
let onTheWire = false;
const events: string[] = [];
const exitCodes: unknown[] = [];

beforeAll(async () => {
  delete process.env.BOT_PROCESS_ROLE;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { events.push(String(args[0])); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
    events.push('EXIT');
    return undefined as never;
  }) as typeof process.exit);
  const real = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    const file = String(p);
    if (file.startsWith(`${C}.`) && file.endsWith('.tmp')) {
      onTheWire = true;
      await gateC;
    }
    return (real as any)(p, ...rest);
  }) as typeof fs.promises.open);
  fs.rmSync(dataPath('global', 'nb29after'), { recursive: true, force: true });
  freshWriterLock('bot', new Set([process.pid, OTHER]));
  expect(takeWriterLock().kind).toBe('taken');
  expect(dm.saveDataTracked('c.json', where, { v: 'c' }).outcome).toBe('saved');
  await vi.waitFor(() => expect(onTheWire).toBe(true), { timeout: 5_000, interval: 5 });
});

afterAll(async () => {
  openC();
  await vi.waitFor(() => expect(fileFlushOnTheWire()).toBe(false), { timeout: 30_000, interval: 10 });
  vi.restoreAllMocks();
  dm._resetStopHandler();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  dm.reopenSharedWrites();
  fs.rmSync(dataPath('global', 'nb29after'), { recursive: true, force: true });
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
}, 40_000);

describe('a deposition after the exit drain ended, while a flush try is on the wire', () => {
  it('the stop names that path with a can\'t-confirm line before it exits', async () => {
    const stop = stopSteps(dm, { claims: () => null });
    let drained = false;
    dm.addReleaseStep(() => {
      drained = dm.isExitDraining();
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
      expect(checkWriterLock()).toMatchObject({ kind: 'deposed', holder: { pid: OTHER } });
    });
    await stop();
    expect(drained).toBe(true);
    expect(fileFlushOnTheWire()).toBe(true);
    expect(exitCodes).toEqual([0]);
    expect(events.filter(line => line.includes(C) && !line.startsWith('[DataManager] Flush failed for'))).toEqual([cantConfirm]);
    expect(events.indexOf(cantConfirm)).toBeLessThan(events.indexOf('EXIT'));
  }, 20_000);
});
