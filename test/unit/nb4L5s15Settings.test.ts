import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shardCapacity, shardReturnEnabled, takeoverSeconds } from '../../src/utils/envLoader';

// NB4 fleet settings: FLEET_SHARD_CAPACITY, FLEET_TAKEOVER_SECONDS and FLEET_SHARD_RETURN as the operator writes them,
// and the one warning line a bad value gets.

const KEYS = ['FLEET_SHARD_CAPACITY', 'FLEET_TAKEOVER_SECONDS', 'FLEET_SHARD_RETURN'] as const;
const saved: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;
let seq = 0;

function uniq(): string {
  seq += 1;
  return `bad${process.pid}x${Date.now()}x${seq}`;
}

function warnLines(): string[] {
  return warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  warn.mockRestore();
});

describe('NB4 fleet settings', () => {
  it('logs a bad value once, and logs a second bad value of the same key on its own line', () => {
    const first = uniq();
    const second = uniq();
    process.env.FLEET_SHARD_RETURN = first;
    expect(shardReturnEnabled()).toBe(true);
    expect(shardReturnEnabled()).toBe(true);
    expect(shardReturnEnabled()).toBe(true);
    let lines = warnLines().filter(l => l.includes(first));
    expect(lines).toEqual([`[EnvLoader] FLEET_SHARD_RETURN="${first}" is not valid (expected true or false; using true)`]);
    process.env.FLEET_SHARD_RETURN = second;
    expect(shardReturnEnabled()).toBe(true);
    expect(shardReturnEnabled()).toBe(true);
    lines = warnLines().filter(l => l.includes(second));
    expect(lines).toHaveLength(1);
    expect(warnLines().filter(l => l.includes('FLEET_SHARD_RETURN'))).toHaveLength(2);
  });

  it('logs a bad capacity once across repeated reads', () => {
    const bad = `-${seq + 7}${process.pid}`;
    process.env.FLEET_SHARD_CAPACITY = bad;
    expect(shardCapacity()).toBe(1);
    expect(shardCapacity()).toBe(1);
    expect(warnLines().filter(l => l.includes(`FLEET_SHARD_CAPACITY="${bad}"`))).toHaveLength(1);
  });

  it('reads a capacity with surrounding spaces and a capacity of several digits', () => {
    process.env.FLEET_SHARD_CAPACITY = '  3 \t';
    expect(shardCapacity()).toBe(3);
    process.env.FLEET_SHARD_CAPACITY = '12';
    expect(shardCapacity()).toBe(12);
    process.env.FLEET_SHARD_CAPACITY = '0';
    expect(shardCapacity()).toBe(0);
    expect(warnLines().filter(l => l.includes('FLEET_SHARD_CAPACITY'))).toEqual([]);
  });

  it('refuses a capacity that only starts with digits', () => {
    for (const bad of ['3e2', '2.0', '0x10']) {
      process.env.FLEET_SHARD_CAPACITY = bad;
      expect(shardCapacity()).toBe(1);
    }
  });

  it('reads a takeover delay with surrounding spaces', () => {
    process.env.FLEET_TAKEOVER_SECONDS = ' 20 ';
    expect(takeoverSeconds()).toBe(20);
    expect(warnLines().filter(l => l.includes('FLEET_TAKEOVER_SECONDS'))).toEqual([]);
  });

  it('refuses a takeover delay that is not plain digits', () => {
    for (const bad of ['+20', '1e2', '20.0', '2e1', '0x20']) {
      process.env.FLEET_TAKEOVER_SECONDS = bad;
      expect(takeoverSeconds()).toBe(30);
    }
  });

  it('reads FLEET_SHARD_RETURN with surrounding spaces', () => {
    process.env.FLEET_SHARD_RETURN = ' false ';
    expect(shardReturnEnabled()).toBe(false);
    process.env.FLEET_SHARD_RETURN = '\ttrue ';
    expect(shardReturnEnabled()).toBe(true);
    expect(warnLines().filter(l => l.includes('FLEET_SHARD_RETURN'))).toEqual([]);
  });
});
