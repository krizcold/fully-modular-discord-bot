import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OWNER_KEYS_DAYS,
  isoTimes,
  keptKeys,
  keyTimesOfRows,
  mergeEarlier,
  readKeyFile,
  sameKeys,
} from '../../src/bot/internalSetup/utils/ownerMessageRecord';

afterEach(() => { vi.restoreAllMocks(); });

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

describe('readKeyFile', () => {
  it('a read that throws a value with no code answers not ok with its text, and does not throw', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw null; });
    expect(readKeyFile('/sa4/owner-messages.json')).toEqual({ ok: false, cause: 'null' });
  });
});

describe('keptKeys', () => {
  it('keeps a key posted exactly 90 days ago and drops one a millisecond older', () => {
    const edge = new Date(NOW - OWNER_KEYS_DAYS * DAY).toISOString();
    const older = new Date(NOW - OWNER_KEYS_DAYS * DAY - 1).toISOString();
    expect(keptKeys({ edge, older }, NOW)).toEqual({ edge });
  });
});

describe('mergeEarlier', () => {
  it('a key only in the second record is kept even when its time does not parse', () => {
    expect(mergeEarlier({}, { k: 'not a time' })).toEqual({ k: 'not a time' });
  });

  it('a key in both at the same instant keeps the first record\'s text', () => {
    expect(mergeEarlier({ k: '2026-01-01T00:00:00.000Z' }, { k: '2026-01-01T00:00:00Z' })).toEqual({ k: '2026-01-01T00:00:00.000Z' });
  });

  it('a key in both keeps the earlier time', () => {
    expect(mergeEarlier({ k: '2026-01-02T00:00:00.000Z' }, { k: '2026-01-01T00:00:00.000Z' })).toEqual({ k: '2026-01-01T00:00:00.000Z' });
    expect(mergeEarlier({ k: '2026-01-01T00:00:00.000Z' }, { k: '2026-01-02T00:00:00.000Z' })).toEqual({ k: '2026-01-01T00:00:00.000Z' });
  });
});

describe('keyTimesOfRows', () => {
  it('a meta row whose key is not an owner message key is left out', () => {
    expect(keyTimesOfRows([{ key: 'shard-map:abcdefghijklmnop', value: '"2026-01-01T00:00:00.000Z"', updated_at: '2026-01-01T00:00:00.000Z' }])).toEqual({});
  });

  it('a value that is not JSON text is read as its string: a Date value gives its own time when earlier than updated_at', () => {
    const value = new Date('2026-01-01T00:00:00.000Z');
    expect(keyTimesOfRows([{ key: 'owner-message:k', value, updated_at: '2026-02-01T00:00:00.000Z' }])).toEqual({ k: '2026-01-01T00:00:00.000Z' });
  });

  it('a value with no time takes updated_at', () => {
    expect(keyTimesOfRows([{ key: 'owner-message:k', value: '{"x":1}', updated_at: '2026-02-01T00:00:00.000Z' }])).toEqual({ k: '2026-02-01T00:00:00.000Z' });
  });

  it('a row with no time in its value or updated_at is left out, and does not throw', () => {
    expect(keyTimesOfRows([{ key: 'owner-message:k', value: '{"x":1}', updated_at: 'never' }])).toEqual({});
  });
});

describe('isoTimes', () => {
  it('drops a key whose time does not parse and writes the others as ISO', () => {
    expect(isoTimes({ bad: 'never', good: '2026-01-01T00:00:00Z' })).toEqual({ good: '2026-01-01T00:00:00.000Z' });
  });
});

describe('sameKeys', () => {
  const t = '2026-01-01T00:00:00.000Z';
  it('two records with the same keys at the same instants are the same', () => {
    expect(sameKeys({ x: t }, { x: '2026-01-01T00:00:00Z' })).toBe(true);
  });
  it('a record with one key more is not the same', () => {
    expect(sameKeys({ x: t }, { x: t, y: t })).toBe(false);
  });
  it('the same key at another time is not the same', () => {
    expect(sameKeys({ x: t }, { x: '2026-01-02T00:00:00.000Z' })).toBe(false);
  });
  it('another key of the same count is not the same', () => {
    expect(sameKeys({ x: t }, { y: t })).toBe(false);
  });
});
