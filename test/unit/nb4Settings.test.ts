import { afterEach, describe, expect, it, vi } from 'vitest';

import { shardCapacity, shardReturnEnabled, takeoverSeconds } from '../../src/utils/envLoader';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decision 20: the three per-machine settings, each read by one function, and decision 5's R, D and S.

const KEYS = ['FLEET_SHARD_CAPACITY', 'FLEET_TAKEOVER_SECONDS', 'FLEET_SHARD_RETURN'];
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

function read<T>(key: string, raw: string | undefined, fn: () => T): { value: T; warned: string[] } {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (raw === undefined) delete process.env[key];
  else process.env[key] = raw;
  const value = fn();
  return { value, warned: warn.mock.calls.map(c => String(c[0])) };
}

describe('FLEET_SHARD_CAPACITY, the machine target', () => {
  it.each([
    [undefined, 1, false], ['', 1, false], ['0', 0, false], ['1', 1, false], ['3', 3, false],
    ['-1', 1, true], ['2.5', 1, true], ['x', 1, true],
  ] as const)('%s reads as %s', (raw, expected, rejected) => {
    const { value, warned } = read('FLEET_SHARD_CAPACITY', raw, shardCapacity);
    expect(value).toBe(expected);
    if (rejected) expect(warned).toContain(`[EnvLoader] FLEET_SHARD_CAPACITY="${raw}" is not valid (expected 0 or a positive whole number; using 1)`);
    else expect(warned).toEqual([]);
  });
});

describe('FLEET_TAKEOVER_SECONDS', () => {
  it.each([
    [undefined, 30, false], ['14', 30, true], ['15', 15, false], ['30', 30, false], ['3600', 3600, false],
    ['3601', 30, true], ['x', 30, true],
  ] as const)('%s reads as %s', (raw, expected, rejected) => {
    const { value, warned } = read('FLEET_TAKEOVER_SECONDS', raw, takeoverSeconds);
    expect(value).toBe(expected);
    if (rejected) expect(warned).toContain(`[EnvLoader] FLEET_TAKEOVER_SECONDS="${raw}" is not valid (expected a whole number from 15 to 3600; using 30)`);
    else expect(warned).toEqual([]);
  });
});

describe('FLEET_SHARD_RETURN', () => {
  it.each([
    ['true', true, false], ['false', false, false], [undefined, true, false], ['yes', true, true],
  ] as const)('%s reads as %s', (raw, expected, rejected) => {
    const { value, warned } = read('FLEET_SHARD_RETURN', raw, shardReturnEnabled);
    expect(value).toBe(expected);
    if (rejected) expect(warned).toContain(`[EnvLoader] FLEET_SHARD_RETURN="${raw}" is not valid (expected true or false; using true)`);
    else expect(warned).toEqual([]);
  });
});

describe('R, D and S from the takeover delay', () => {
  it.each([
    [30, 5000, 20_000, 1500],
    [15, 2500, 10_000, 1250],
    [3600, 5000, 2_400_000, 1500],
  ])('at %s s: R %s ms, D %s ms, S %s ms', (seconds, r, d, s) => {
    const t = claimTimings(seconds);
    expect(t.ttlMs).toBe(seconds * 1000);
    expect(t.renewMs).toBe(r);
    expect(t.deadlineMs).toBe(d);
    expect(t.statementMs).toBe(s);
    expect(t.lockMs).toBe(s / 2);
  });
});
