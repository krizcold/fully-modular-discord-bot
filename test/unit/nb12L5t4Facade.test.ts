import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<any>()),
  awaitGuildDataReady: async () => true,
}));

import { deleteDataTracked, saveDataTracked, updateData } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md) on the file route: rule K is checked for guild keys only (global keys keep
// today's rules until NB6), a write a queued delete stands in the way of is logged as not taken, and an operator read
// says when this process still holds a queued write of the document.

let guilds = 9_414_400_000;
const freshGuild = () => String(++guilds);
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await flushAll();
  vi.restoreAllMocks();
});

describe('a global key is not held to the guild key rules', () => {
  it('a global save under a .graveyard.json folder is saved and lands', async () => {
    const saved = saveDataTracked('s.json', { scope: 'global', category: '.graveyard.json' }, { a: 1 });
    expect(saved.outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath('global', '.graveyard.json', 's.json'), 'utf8'))).toEqual({ a: 1 });
  });

  it('a global update under a .graveyard.json folder is saved and lands', async () => {
    const saved = updateData('u.json', { scope: 'global', category: '.graveyard.json' }, { n: 0 }, current => ({ n: current.n + 1 }));
    expect(saved.outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath('global', '.graveyard.json', 'u.json'), 'utf8'))).toEqual({ n: 1 });
  });
});

describe('a write a queued delete stands in the way of', () => {
  it('is refused io and logged as not taken, naming the document and the delete', () => {
    const guildId = freshGuild();
    const file = path.join(dataPath(guildId), 'm', 'x', 'y.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    expect(deleteDataTracked('x/y.json', { guildId, category: 'm' }).outcome).toBe('deleted');
    errors.mockClear();
    const saved = saveDataTracked('x', { guildId, category: 'm' }, { b: 2 });
    expect(saved).toEqual({ outcome: 'refused', cause: 'io', reason: 'a delete of m/x/y.json is still being written' });
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
      `[Data] A write of guild:${guildId}:m/x was not taken: a delete of m/x/y.json is still being written; nothing was saved`,
    );
  });
});

describe('an operator read of a document with a queued write', () => {
  it('says the write is still queued', async () => {
    const guildId = freshGuild();
    expect(saveDataTracked('doc.json', { guildId, category: 'm' }, { c: 3 }).outcome).toBe('saved');
    const reply = await applyOperatorDataRead({ guildId, module: 'm', filename: 'doc.json' });
    expect(reply).toMatchObject({ ok: true, pending: true, failing: false });
  });
});
