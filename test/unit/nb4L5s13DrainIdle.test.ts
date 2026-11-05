import { afterEach, describe, expect, it, vi } from 'vitest';

import { drainForExit, GuildFrozenError, isClosedForExit, stopProcess } from '../../src/bot/internalSetup/utils/dataManager';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { queuedFileWrites } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// Its own file: the exit drain runs once per process. A JSON bot with nothing queued drains with no line at all,
// a stop asked before any stop handler exists says why the process exits, and the frozen refusal names the guild.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the exit drain of a bot with nothing queued', () => {
  it('logs nothing', async () => {
    expect(getWorkingSet()).toBeNull();
    expect(queuedFileWrites()).toBe(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await drainForExit(200);
    expect(isClosedForExit()).toBe(true);
    expect(warn.mock.calls).toEqual([]);
    expect(error.mock.calls).toEqual([]);
  });
});

describe('a stop with no stop handler built', () => {
  it('says the process exits, then exits', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try { stopProcess(); } catch { /* the real exit never returns */ }
    expect(error.mock.calls).toEqual([['[Data] No stop handler is built yet; the bot process exits']]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('the frozen refusal', () => {
  it('names the guild and its own error name', () => {
    const e = new GuildFrozenError('4242');
    expect(e.message).toBe('guild 4242 is frozen: this process stopped serving it');
    expect(e.name).toBe('GuildFrozenError');
    expect(e).toBeInstanceOf(Error);
  });
});
