import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A file name holding a backslash is legal on Linux but cannot be made on Windows: the key of any file named
// "...zz-badkey..." is read here as if its name held a backslash in that place.
vi.mock('../../src/bot/internalSetup/utils/dataKeys', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataKeys')>();
  return {
    ...real,
    canonicalGuildKey: (category: string | null | undefined, filename: string) =>
      real.canonicalGuildKey(category, filename.includes('zz-badkey') ? filename.replace('zz-badkey', 'zz\\badkey') : filename),
  };
});

import { writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { readJsonUnit } from '../../src/bot/internalSetup/utils/dataMigration';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): a key with no file form is refused by an export and by a migration, each
// naming the key and why, without the log tag of the error it came from.

let guilds = 9_413_000_000;
const freshGuild = () => String(++guilds);

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function put(guildId: string, rel: string, text: string): string {
  const full = path.join(dataPath(guildId), ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

const WHY = 'The guild key "m/zz\\badkey.json" holds a backslash; refused';

describe('a key with no file form', () => {
  it('an export names it with the reason, untagged', async () => {
    const guildId = freshGuild();
    put(guildId, 'm/zz-badkey.json', '{}');
    const error = await writeBundle(guildId, path.join(DATA_ROOT, `nb12L5s4-key-${guildId}.dbex`)).then(() => null, e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe(`[DataInterchange] Guild ${guildId} holds 1 file(s) a bundle cannot carry: m/zz-badkey.json: ${WHY}; move their content to an allowed name or delete them, then export again`);
  });

  it('a migration source names it and says nothing was written', async () => {
    const guildId = freshGuild();
    const full = put(guildId, 'm/zz-badkey.json', '{}');
    await expect(readJsonUnit({ guildId, dir: dataPath(guildId) }))
      .rejects.toThrow(new Error(`The key m/zz-badkey.json of ${full} has no file form ([Data] ${WHY}); nothing was written`));
  });
});
