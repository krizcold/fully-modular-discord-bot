import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { readJsonUnit } from '../../src/bot/internalSetup/utils/dataMigration';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): an export names the files a bundle cannot carry, and a migration names why a
// file's bytes cannot be copied into Postgres.

let guilds = 9_412_000_000;
const freshGuild = () => String(++guilds);
let n = 0;

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function put(guildId: string, rel: string, bytes: Buffer | string): string {
  const full = path.join(dataPath(guildId), ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
}

async function exportError(guildId: string): Promise<string> {
  const file = path.join(DATA_ROOT, `nb12L5s4-${++n}.dbex`);
  const error = await writeBundle(guildId, file).then(() => null, e => e as Error);
  expect(error).toBeInstanceOf(Error);
  return error!.message;
}

const NUL = 'it holds U+0000 at character 1, which the database cannot store';

describe('writeBundle names the files a bundle cannot carry', () => {
  it('separates the named files with "; "', async () => {
    const guildId = freshGuild();
    put(guildId, 'm/a.json', 'a\u0000');
    put(guildId, 'm/b.json', 'b\u0000');
    const message = await exportError(guildId);
    expect(message).toContain(`holds 2 file(s) a bundle cannot carry: m/a.json: ${NUL}; m/b.json: ${NUL}; move their content`);
  });

  it('names at most 10 of them while counting every one', async () => {
    const guildId = freshGuild();
    const names = Array.from({ length: 11 }, (_, i) => `m/f${String(i).padStart(2, '0')}.json`);
    for (const rel of names) put(guildId, rel, 'x\u0000');
    const message = await exportError(guildId);
    expect(message).toContain('holds 11 file(s) a bundle cannot carry: ');
    expect(names.filter(rel => message.includes(`${rel}: `))).toHaveLength(10);
  });
});

describe('a JSON migration source refuses bytes Postgres cannot store, with the true reason', () => {
  it('a file that is not UTF-8 is named as such, not as holding U+0000', async () => {
    const guildId = freshGuild();
    const full = put(guildId, 'm/a.json', Buffer.from([0xc3, 0x28]));
    await expect(readJsonUnit({ guildId, dir: dataPath(guildId) })).rejects.toThrow(new Error(`${full} is not valid UTF-8 text`));
  });

  it('a file holding U+0000 is named as such', async () => {
    const guildId = freshGuild();
    const full = put(guildId, 'm/a.json', 'a\u0000');
    await expect(readJsonUnit({ guildId, dir: dataPath(guildId) })).rejects.toThrow(new Error(`${full} holds U+0000, which Postgres cannot store`));
  });
});
