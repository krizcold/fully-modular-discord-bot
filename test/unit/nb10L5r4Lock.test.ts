import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWriterTake } from '../../src/bot/internalSetup/utils/dataManager';
import { configureWriterLock, releaseWriterLock, takeWriterLock, WRITER_CHECK_MS, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// NB10: the holder checks the writer lock once every 5 s, even after a take step released the lock inside a take and
// left a check running at depth 0; the next take replaces that check instead of adding a second one.

let releaseOnce = false;
onWriterTake(() => {
  if (releaseOnce) {
    releaseOnce = false;
    releaseWriterLock();
  }
});

const HOLDS_TEXT = 'holds text this process did not write';

beforeEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => p === process.pid, startOf: () => null, now: () => Date.now() });
});

afterEach(() => {
  releaseOnce = false;
  while (writerLockDepth() > 0) releaseWriterLock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the writer lock check after a take step released the lock', () => {
  it('logs a foreign lock text once per 5 s, not once per check left running', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    releaseOnce = true;
    expect(takeWriterLock()).toEqual({ kind: 'taken' });
    expect(writerLockDepth()).toBe(0);
    expect(takeWriterLock()).toEqual({ kind: 'taken' });
    expect(writerLockDepth()).toBe(1);
    fs.writeFileSync(writerLockPath(), 'not a holder');
    vi.advanceTimersByTime(WRITER_CHECK_MS);
    const lines = error.mock.calls.map(c => c.map(String).join(' ')).filter(l => l.includes(HOLDS_TEXT));
    expect(lines).toHaveLength(1);
    fs.rmSync(writerLockPath(), { force: true });
    releaseWriterLock();
  });
});
