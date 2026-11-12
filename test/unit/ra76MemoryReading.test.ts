import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGE_TEXT, AT_TEXT, MB_TEXT, ROOM_TEXT, _resetMemoryReading, checkMemoryMessage, checkMemoryReading, heartbeatMemory,
  ignoredLine, keepMemoryMessage, refusedLine,
} from '../../src/utils/memoryReading';

const reading = (at: string) => ({ room: true, useMb: 10, freeMb: 20, at });
const message = (extra: Record<string, unknown> = {}) => ({ room: false, useMb: 10, freeMb: 20, ageMs: 5, ...extra });
const quietLog = () => ({ warn: vi.fn() });

afterEach(() => {
  _resetMemoryReading();
  vi.restoreAllMocks();
});

describe('the hook body date', () => {
  it.each([
    '2026-01-01',
    '2026-01-01T10:00',
    '2026-01-01T10:00Z',
    '2026-01-01T10:00:00',
    '2026-01-01T10:00:00Z',
    '2026-01-01T10:00:00.5Z',
    '2026-01-01T10:00:00+01:00',
    '2026-01-01T10:00:00-05:30',
    '2026-01-01T10:00:00+0100',
  ])('takes the ISO date %s', at => {
    expect(checkMemoryReading(reading(at))).toBeNull();
  });

  it.each([
    ' 2026-01-01',
    'Mon 2026-01-01',
    '2026-01-01 ',
    '2026-01-01 junk',
  ])('refuses a date Date.parse reads but ISO 8601 does not: %j', at => {
    expect(Number.isFinite(Date.parse(at))).toBe(true);
    expect(checkMemoryReading(reading(at))).toBe(AT_TEXT);
  });
});

describe('the sizes and the age', () => {
  it('takes 0 and 2147483647 megabytes and refuses one past it', () => {
    expect(checkMemoryReading({ ...reading('2026-01-01'), useMb: 0, freeMb: 0 })).toBeNull();
    expect(checkMemoryReading({ ...reading('2026-01-01'), useMb: 2147483647, freeMb: 2147483647 })).toBeNull();
    expect(checkMemoryMessage(message({ useMb: 0 }))).toBeNull();
    expect(checkMemoryMessage(message({ freeMb: 2147483647 }))).toBeNull();
    expect(checkMemoryMessage(message({ freeMb: 2147483648 }))).toBe(MB_TEXT);
  });

  it('takes an age of 0 and refuses a negative one', () => {
    expect(checkMemoryMessage(message({ ageMs: 0 }))).toBeNull();
    expect(checkMemoryMessage(message({ ageMs: -1 }))).toBe(AGE_TEXT);
  });
});

describe('a body that is not a plain object', () => {
  it('answers the room rule for null instead of throwing', () => {
    expect(checkMemoryReading(null)).toBe(ROOM_TEXT);
    expect(checkMemoryMessage(null)).toBe(ROOM_TEXT);
  });

  it('refuses a function or an array that carries the fields', () => {
    const fn = Object.assign(() => undefined, reading('2026-01-01'));
    const arr = Object.assign([], reading('2026-01-01'));
    expect(checkMemoryReading(fn)).toBe(ROOM_TEXT);
    expect(checkMemoryReading(arr)).toBe(ROOM_TEXT);
    expect(checkMemoryMessage(Object.assign(() => undefined, message()))).toBe(ROOM_TEXT);
  });
});

describe('the log lines', () => {
  it('names the source and the rule', () => {
    expect(refusedLine(AT_TEXT)).toBe(`[Memory] Refused a memory reading from the manager: ${AT_TEXT}`);
    expect(ignoredLine(AGE_TEXT)).toBe(`[Shards] Ignored a memory reading from the web UI process: ${AGE_TEXT}`);
  });
});

describe('keeping a pushed message', () => {
  it('answers false, logs the rule and keeps nothing for a bad message', () => {
    const log = quietLog();
    expect(keepMemoryMessage(message({ ageMs: -1 }), log)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(`[Shards] Ignored a memory reading from the web UI process: ${AGE_TEXT}`);
    expect(heartbeatMemory()).toBeNull();
  });

  it('answers true for a good message and the heartbeat writes it', () => {
    const log = quietLog();
    expect(keepMemoryMessage(message({ error: 'probe failed' }), log)).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(heartbeatMemory()).toMatchObject({ room: false, useMb: 10, freeMb: 20, error: 'probe failed' });
  });

  it('writes a null error when the error read after the check is not a string', () => {
    let reads = 0;
    const value = message();
    Object.defineProperty(value, 'error', { enumerable: true, get: () => (reads++ === 0 ? undefined : 5) });
    expect(keepMemoryMessage(value, quietLog())).toBe(true);
    expect(heartbeatMemory()?.error).toBeNull();
  });

  it('moves the age on by the time since the message arrived', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(100);
    expect(keepMemoryMessage(message({ ageMs: 1000 }), quietLog())).toBe(true);
    now.mockReturnValue(600);
    expect(heartbeatMemory()?.ageMs).toBe(1500);
    now.mockReturnValue(50);
    expect(heartbeatMemory()?.ageMs).toBe(1000);
  });
});
