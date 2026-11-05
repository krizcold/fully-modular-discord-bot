import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { KeyTree, STORE_MAX_BYTES, keyRefusal } from '../../src/bot/internalSetup/utils/storableData';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 item 8 (wip-redesign/sheets/NB12.md, decisions 14 and 21): the one line a hydrate logs for stored keys a rule
// refuses, stored keys that collide and documents over 4 MiB, with its counts and its first three examples, and the
// stored append streams counted with the documents.

let guilds = 9_740_000_000;
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

async function hydrated(docs: Array<[string, string]>, streams: string[] = []) {
  const guildId = String(++guilds);
  const store = new FakeStore();
  for (const [key, doc] of docs) store.docs.set(`${guildId}|${key}`, doc);
  for (const key of streams) store.streams.set(`${guildId}|${key}`, '{}\n');
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, ws };
}

const TAIL = '. All of them read and delete as stored; a write to a refused key is refused, a colliding key takes writes under ' +
  'its own spelling, and an oversized document takes a new value of up to 4 MiB; tell the module\'s author';

const line = (guildId: string, refused: number, collided: number, oversized: number, firsts: string[]) =>
  `[Data] Guild ${guildId} holds ${refused} key(s) a write is refused for, ${collided} key(s) whose name collides with ` +
  `another stored key and ${oversized} document(s) over 4 MiB (first: ${firsts.join(', ')})${TAIL}`;

const refusal = (key: string) => `${key}: ${keyRefusal(key)}`;

function collisionOf(first: string, second: string): string {
  const tree = new KeyTree();
  tree.add(first);
  return `${second}: ${tree.add(second)!.reason}`;
}

const over = (bytes: number) => JSON.stringify('x'.repeat(bytes - 2));

describe('the hydrate line', () => {
  it('names a collision as its first example', async () => {
    const { guildId } = await hydrated([['m/Pair.json', '1'], ['m/pair.json', '2']]);
    expect(errors).toEqual([line(guildId, 0, 1, 0, [collisionOf('m/Pair.json', 'm/pair.json')])]);
  });

  it('counts one refused key and one collision, each named', async () => {
    const { guildId } = await hydrated([['m/a?.json', '1'], ['m/Pair.json', '2'], ['m/pair.json', '3']]);
    expect(errors).toEqual([line(guildId, 1, 1, 0, [refusal('m/a?.json'), collisionOf('m/Pair.json', 'm/pair.json')])]);
  });

  it('names only the first three of four refused keys', async () => {
    const keys = ['m/a?.json', 'm/b?.json', 'm/c?.json', 'm/d?.json'];
    const { guildId } = await hydrated(keys.map(k => [k, '1']));
    expect(errors).toEqual([line(guildId, 4, 0, 0, keys.slice(0, 3).map(refusal))]);
  });

  it('names only the first three of four collisions', async () => {
    const docs: Array<[string, string]> = [];
    for (const n of [1, 2, 3, 4]) docs.push([`m/P${n}.json`, '1'], [`m/p${n}.json`, '2']);
    const { guildId } = await hydrated(docs);
    expect(errors).toEqual([line(guildId, 0, 4, 0, [1, 2, 3].map(n => collisionOf(`m/P${n}.json`, `m/p${n}.json`)))]);
  });

  it('names a refused document over 4 MiB once, by its refusal', async () => {
    const { guildId } = await hydrated([['m/a?.json', over(STORE_MAX_BYTES + 1)]]);
    expect(errors).toEqual([line(guildId, 1, 0, 1, [refusal('m/a?.json')])]);
  });

  it('counts a fourth document over 4 MiB without naming it', async () => {
    const keys = ['m/a?.json', 'm/b?.json', 'm/c?.json'];
    const { guildId } = await hydrated([...keys.map(k => [k, '1'] as [string, string]), ['m/big.json', over(STORE_MAX_BYTES + 1)]]);
    expect(errors).toEqual([line(guildId, 3, 0, 1, keys.map(refusal))]);
  });

  it('says nothing of a document of exactly 4 MiB', async () => {
    await hydrated([['m/full.json', over(STORE_MAX_BYTES)]]);
    expect(errors).toEqual([]);
  });

  it('counts a refused key held as both a document and a stream once', async () => {
    const { guildId } = await hydrated([['m/a?.jsonl', '1']], ['m/a?.jsonl']);
    expect(errors).toEqual([line(guildId, 1, 0, 0, [refusal('m/a?.jsonl')])]);
  });

  it('counts a refused key held only as a stream', async () => {
    const { guildId } = await hydrated([], ['m/a?.jsonl']);
    expect(errors).toEqual([line(guildId, 1, 0, 0, [refusal('m/a?.jsonl')])]);
  });
});

describe('a stored append stream', () => {
  it('holds its spelling: a save under another letter case is refused as a collision', async () => {
    const { guildId, ws } = await hydrated([], ['m/Log.jsonl']);
    expect(errors).toEqual([]);
    const tree = new KeyTree();
    tree.add('m/Log.jsonl');
    expect(ws.save(guildId, 'm', 'log.jsonl', '{}')).toEqual({ collision: tree.check('m/log.jsonl')!.reason });
  });
});
