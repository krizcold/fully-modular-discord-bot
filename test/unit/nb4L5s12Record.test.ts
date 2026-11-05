import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const fsyncSync = (fd: any) => { h.events.push(`fsync:${fd}`); return real.fsyncSync(fd); };
  const openSync = (file: any, ...rest: any[]) => { const fd = real.openSync(file, ...rest); h.events.push(`open:${fd}`); return fd; };
  const closeSync = (fd: any) => { h.events.push(`close:${fd}`); return real.closeSync(fd); };
  const renameSync = (from: any, to: any) => { h.events.push('rename'); return real.renameSync(from, to); };
  const over = { fsyncSync, openSync, closeSync, renameSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import { readShardRecord, shardRecordPath, writeShardRecord } from '../../src/bot/internalSetup/fleet/shardRecord';

// /data/global/fleet/shards.json: written durably, and read back only when every shard id fits its count.

const FILE = () => path.join(process.env.DATA_DIR!, 'global', 'fleet', 'shards.json');

function store(content: unknown): void {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(content));
}

beforeEach(() => {
  h.events = [];
  fs.rmSync(FILE(), { force: true });
});

describe('writing the shard record', () => {
  it('lands at global/fleet/shards.json under the data root and reads back whole', () => {
    const record = { shardCount: 4, shardIds: [1, 3], processId: 'p-a', at: '2026-11-04T00:00:00.000Z', keptAtStop: [3] };
    writeShardRecord(record);
    expect(shardRecordPath()).toBe(FILE());
    expect(JSON.parse(fs.readFileSync(FILE(), 'utf-8'))).toEqual(record);
    expect(readShardRecord()).toEqual(record);
  });

  it('syncs the temp file to disk before it replaces the record', () => {
    writeShardRecord({ shardCount: 2, shardIds: [0], processId: 'p-a', at: 'now' });
    const fd = h.events.find(e => e.startsWith('open:'))!.slice('open:'.length);
    expect(h.events).toEqual([`open:${fd}`, `fsync:${fd}`, `close:${fd}`, 'rename']);
  });
});

describe('reading the shard record', () => {
  it.each([
    ['a count that is not a number', { shardCount: '3', shardIds: [] }],
    ['a zero count', { shardCount: 0, shardIds: [] }],
    ['ids that are not a list', { shardCount: 2, shardIds: 'x' }],
    ['an id at the count', { shardCount: 2, shardIds: [0, 2] }],
    ['an id past the count', { shardCount: 2, shardIds: [5] }],
    ['a negative id', { shardCount: 2, shardIds: [-1] }],
    ['a fractional id', { shardCount: 4, shardIds: [1.5] }],
    ['one id out of range among good ones', { shardCount: 2, shardIds: [0, 9] }],
  ])('answers null for %s', (_name, content) => {
    store({ processId: 'p-a', at: 'now', ...content });
    expect(readShardRecord()).toBeNull();
  });

  it('keeps the stored process id and time', () => {
    store({ shardCount: 2, shardIds: [1], processId: 'p-a', at: 'then' });
    expect(readShardRecord()).toEqual({ shardCount: 2, shardIds: [1], processId: 'p-a', at: 'then' });
  });

  it('answers empty strings for a missing process id and time', () => {
    store({ shardCount: 2, shardIds: [0, 1] });
    expect(readShardRecord()).toEqual({ shardCount: 2, shardIds: [0, 1], processId: '', at: '' });
  });

  it('drops kept shards when any of them is out of range', () => {
    store({ shardCount: 2, shardIds: [0], processId: 'p-a', at: 'now', keptAtStop: [0, 9] });
    const record = readShardRecord();
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty('keptAtStop');
  });
});
