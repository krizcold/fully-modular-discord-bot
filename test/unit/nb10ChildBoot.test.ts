import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureWriterLock, releaseWriterLock, takeWriterLockForBoot, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// NB10 test 8 (the take's part): the bot process waits for the writer lock with no deadline, reporting and logging
// the holder before its first poll and every 30 s, and takes the lock once the holder is gone.

const live = new Set<number>([process.pid, 7171]);
const sent: any[] = [];
let clock = 0;

beforeEach(() => {
  sent.length = 0;
  clock = 0;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  (process as any).send = (message: unknown) => { sent.push(message); return true; };
});

afterEach(() => {
  delete (process as any).send;
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
});

describe('the bot process take at its start', () => {
  it('reports waiting with the holder before it polls, logs at once and every 30 s, and takes the lock when it is free', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 7171, start: null, role: 'webui', at: Date.now() }));
    let polls = 0;
    const sleep = async (ms: number) => {
      polls++;
      clock += ms;
      expect(ms).toBe(100);
      if (clock >= 65_000) fs.rmSync(writerLockPath(), { force: true });
    };
    await takeWriterLockForBoot(sleep, () => clock);
    expect(sent).toEqual([
      { type: 'data:writer', data: { stage: 'waiting', holder: { role: 'webui', pid: 7171 } } },
      { type: 'data:writer', data: { stage: 'opening' } },
    ]);
    const lines = warns.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[Data] Waiting for the web UI (pid 7171) to release the data files before the bot opens them'));
    expect(lines).toHaveLength(3);
    expect(polls).toBeGreaterThan(600);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'))).toMatchObject({ pid: process.pid, role: 'bot' });
  });

  it('a lock file it cannot read (a directory: EISDIR) reports readCause, logs it at once, and retries every second', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(writerLockPath());
    const waits: number[] = [];
    await takeWriterLockForBoot(async ms => {
      waits.push(ms);
      if (waits.length === 3) fs.rmdirSync(writerLockPath());
    }, () => clock);
    expect(sent[0]).toMatchObject({ type: 'data:writer', data: { stage: 'waiting' } });
    expect(sent[0].data.readCause).toEqual(expect.any(String));
    expect(sent[0].data.cause).toBeUndefined();
    expect(warns.mock.calls.map(c => String(c[0]))[0]).toBe(`[Data] Cannot read ${writerLockPath()} (${sent[0].data.readCause}); the bot waits until it can tell which process holds the data files`);
    expect(waits).toEqual([1000, 1000, 1000]);
    expect(writerLockDepth()).toBe(1);
  });
});
