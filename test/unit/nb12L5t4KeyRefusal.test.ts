import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A file name holding a backslash cannot be made on Windows: a key "...zz-badkey..." under a module reads here as if
// it held a backslash in that place. A lone segment (the IPC's own check) stays as given.
vi.mock('../../src/bot/internalSetup/utils/dataKeys', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataKeys')>();
  return {
    ...real,
    canonicalGuildKey: (category: string | null | undefined, filename: string) =>
      real.canonicalGuildKey(category, category && filename.includes('zz-badkey') ? filename.replace('zz-badkey', 'zz\\badkey') : filename),
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<any>()),
  awaitGuildDataReady: async () => true,
}));

import { deleteDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): a delete of a key with no file form is refused 'unstorable' with the key's
// reason, untagged and starting in lower case, and an operator delete over IPC answers 'invalid' with that reason.

let guilds = 9_414_500_000;
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

describe('a delete of a key with no file form', () => {
  it('is refused unstorable with the reason, untagged and in lower case, and logged', () => {
    const guildId = freshGuild();
    const reason = 'the guild key "m/zz\\badkey.json" holds a backslash';
    expect(deleteDataTracked('zz-badkey.json', { guildId, category: 'm' })).toEqual({ outcome: 'refused', cause: 'unstorable', reason });
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(`[Data] Refused a write of guild:${guildId}:m/zz-badkey.json: ${reason}; nothing was saved`);
  });

  it('keeps a "; refused" inside the key in the reason', () => {
    const guildId = freshGuild();
    expect(deleteDataTracked('a; refused zz-badkey.json', { guildId, category: 'm' })).toEqual({
      outcome: 'refused',
      cause: 'unstorable',
      reason: 'the guild key "m/a; refused zz\\badkey.json" holds a backslash',
    });
  });
});

describe('an operator delete over IPC of a key with no file form', () => {
  it("answers 'invalid' with the reason", async () => {
    const guildId = freshGuild();
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename: 'zz-badkey.json', op: 'delete' })).toEqual({
      ok: false,
      code: 'invalid',
      error: 'The data was not saved: the guild key "m/zz\\badkey.json" holds a backslash',
    });
  });
});
