import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { getPending, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB12 code review round 8 (wip-redesign/sheets/NB12.md decision 8 'Cost', NB12-O-R8-1): a file-route guild write
// reads only its own guild's queued ops, never the whole process queue.

let guilds = 9_800_000_000;
const fresh = () => String(++guilds);

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

/** Counts the entries yielded by for-of walks over maps holding more than `over` entries. */
function countLargeMapWalks(over: number): () => number {
  const proto = Map.prototype as any;
  const original = proto[Symbol.iterator];
  let visited = 0;
  proto[Symbol.iterator] = function (this: Map<unknown, unknown>) {
    const it = original.call(this);
    if (this.size <= over) return it;
    return {
      next: () => {
        const step = it.next();
        if (!step.done) visited += 1;
        return step;
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  };
  afterRestore.push(() => {
    proto[Symbol.iterator] = original;
  });
  return () => visited;
}
const afterRestore: Array<() => void> = [];
afterEach(() => {
  while (afterRestore.length) afterRestore.pop()!();
});

describe.each([true, false])('one write per guild in one synchronous loop (cache %s)', cache => {
  it('walks no large queue while the writes are queued', () => {
    setGuildViewCache(cache);
    const ids = Array.from({ length: 600 }, fresh);
    const visited = countLargeMapWalks(200);
    for (const guildId of ids) expect(dm.saveDataTracked('m/totals.json', { guildId }, { n: 1 }).outcome).toBe('saved');
    const n = visited();
    afterRestore.pop()!();
    expect(n).toBe(0);
    for (const guildId of ids.slice(0, 3)) expect(getPending(dataPath(guildId, 'm', 'totals.json'))?.op).toBe('write');
  });
});

describe.each([true, false])("a queued delete in the write's way, with other guilds queued (cache %s)", cache => {
  it("answers io naming the delete, only in its own guild, then saves once it lands", async () => {
    setGuildViewCache(cache);
    const guildId = fresh();
    const other = fresh();
    fs.mkdirSync(dataPath(guildId, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'm', 'a'), '1');
    for (let i = 0; i < 50; i++) expect(dm.saveDataTracked(`m/k${i}.json`, { guildId: other }, i).outcome).toBe('saved');
    expect(dm.deleteDataTracked('m/a', { guildId }).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/a/x.json', { guildId: other }, 1).outcome).toBe('saved');
    const answer = dm.saveDataTracked('m/a/x.json', { guildId }, 2);
    expect(answer).toEqual({ outcome: 'refused', cause: 'io', reason: 'a delete of m/a is still being written' });
    await dm.flushAll();
    expect(getPending(dataPath(guildId, 'm', 'a'))).toBeUndefined();
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(dataPath(guildId, 'm', 'a', 'x.json'), 'utf8')).toBe('2');
  });
});
