import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as envLoader from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

// NB9 test 16 (C12): FLEET_RESHARD_OVERLAP reads as FLEET_SHARD_RETURN does, and the credentials carry it to the forks.

const KEY = 'FLEET_RESHARD_OVERLAP';
afterEach(() => {
  delete process.env[KEY];
  vi.restoreAllMocks();
});

function read(raw: string | undefined): { value: boolean; warned: string[] } {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (raw === undefined) delete process.env[KEY];
  else process.env[KEY] = raw;
  const fn = (envLoader as unknown as { reshardOverlap?: () => boolean }).reshardOverlap;
  if (typeof fn !== 'function') throw new Error('reshardOverlap is not exported');
  const value = fn();
  const warned = warn.mock.calls.map(c => String(c[0]));
  warn.mockRestore();
  return { value, warned };
}

describe('FLEET_RESHARD_OVERLAP', () => {
  it.each([
    [undefined, true], ['', true], ['true', true], ['false', false], [' false ', false],
  ] as const)('%s reads as %s with no line', (raw, expected) => {
    const { value, warned } = read(raw);
    expect(value).toBe(expected);
    expect(warned).toEqual([]);
  });

  it.each(['FALSE', 'no'])('%s reads as on, with the line once per value', raw => {
    const first = read(raw);
    expect(first.value).toBe(true);
    expect(first.warned).toEqual([`[EnvLoader] FLEET_RESHARD_OVERLAP="${raw}" is not valid (expected true or false; using true)`]);
    const second = read(raw);
    expect(second.value).toBe(true);
    expect(second.warned).toEqual([]);
  });

  it('loadCredentials carries it beside FLEET_SHARD_RETURN', () => {
    fs.rmSync(dataPath('.env'), { force: true });
    process.env[KEY] = 'false';
    expect(envLoader.loadCredentials()).toMatchObject({ FLEET_RESHARD_OVERLAP: 'false' });
  });
});
