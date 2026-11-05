import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendData, deleteData, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB13 decision 12: a .jsonl name marks a stream at every write, and every stream line ends in a newline.

let guilds = 5_600_000;
afterEach(async () => {
  await flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

type Backend = 'file' | 'postgres';

async function rig(kind: Backend) {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const guildId = String(++guilds);
  setBackendKind(kind);
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  if (kind === 'postgres') expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  const options = { guildId, category: 'm' };
  const stored = async (name: string): Promise<string | undefined> => {
    if (kind === 'file') {
      await flushAll();
      const p = dataPath(guildId, 'm', name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
    }
    expect(await ws.flushGuildNow(guildId, 2000)).toBe('ok');
    return store.streams.get(`${guildId}|m/${name}`) ?? store.docs.get(`${guildId}|m/${name}`);
  };
  return { guildId, options, stored };
}

describe.each<Backend>(['file', 'postgres'])('%s backend', kind => {
  it('6.1 appendData adds a newline to a line without one and stores a line that has one as given', async () => {
    const { options, stored } = await rig(kind);
    expect(appendData('x.jsonl', options, 'abc')).toBe(true);
    expect(appendData('x.jsonl', options, 'def\n')).toBe(true);
    expect(await stored('x.jsonl')).toBe('abc\ndef\n');
  });

  it('6.2 appendData of a name that does not end in .jsonl throws a TypeError and stores nothing', async () => {
    const { options, stored } = await rig(kind);
    expect(() => appendData('x.json', options, 'abc')).toThrow(new TypeError('[Data] x.json does not end in .jsonl; appendData writes only .jsonl files. The line was not saved'));
    expect(await stored('x.json')).toBeUndefined();
  });

  it('6.3 saveData of a .jsonl name throws a TypeError and stores nothing; deleteData still deletes', async () => {
    const { guildId, options, stored } = await rig(kind);
    const text = '[Data] x.jsonl is an append-only file; write it with appendData. The value was not saved';
    expect(() => saveData('x.jsonl', options, { v: 1 })).toThrow(new TypeError(text));
    expect(await stored('x.jsonl')).toBeUndefined();
    const reply = await applyOperatorDataWrite({ guildId, module: 'm', filename: 'x.jsonl', op: 'write', contentJson: JSON.stringify({ v: 1 }, null, 2) });
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).toContain(text);
    expect(await stored('x.jsonl')).toBeUndefined();
    appendData('x.jsonl', options, 'abc\n');
    expect(await stored('x.jsonl')).toBe('abc\n');
    expect(deleteData('x.jsonl', options)).toBe(true);
    expect(await stored('x.jsonl')).toBeUndefined();
  });
});
