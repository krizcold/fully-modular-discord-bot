import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { GuildKeyError } from '../../src/bot/internalSetup/utils/dataKeys';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';

// The facade's guild id and guild key checks on a JSON bot, the copy-sync texts of a graveyard restore, and the
// guild list of a Postgres bot.

const REQUIRED = '[DataManager] guildId is required for guild-scoped data';

function errorsOf(fn: () => unknown): { value: unknown; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return { value: fn(), errors };
  } finally {
    spy.mockRestore();
  }
}

function plant(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a guild read with no guild id', () => {
  it.each([['undefined', undefined], ['null', null]])('a guild id of %s is refused as missing, not as a bad id', (_name, guildId) => {
    const { value, errors } = errorsOf(() => dm.loadData('a.json', { guildId: guildId as any }, 'fallback'));
    expect(value).toBe('fallback');
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('[DataManager] Error loading a.json:');
    const error = errors[0][1] as Error;
    expect(error).not.toBeInstanceOf(GuildKeyError);
    expect(error.message).toBe(REQUIRED);
  });
});

describe('a guild key that leaves the guild folder', () => {
  it('is refused with no scope given, and the file beside the guild folder is not read', () => {
    plant(dataPath('sa9-escape.json'), '{"leaked":true}');
    const { value, errors } = errorsOf(() => dm.loadData('../sa9-escape.json', { guildId: '123456789012345678' }, { leaked: false }));
    expect(value).toEqual({ leaked: false });
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toBeInstanceOf(GuildKeyError);
    expect((errors[0][1] as Error).message).toBe('[Data] The guild key "../sa9-escape.json" leaves the guild folder; refused');
  });
});

describe('a guild id that is not a Discord id', () => {
  it("a scope other than 'guild' and 'global' is refused by name, so the global folder is not read as a guild", () => {
    plant(dataPath('global', 'sa9-scope.json'), '{"leaked":true}');
    const { value, errors } = errorsOf(() => dm.loadData('sa9-scope.json', { scope: 'module' as any, guildId: 'global' }, { leaked: false }));
    expect(value).toEqual({ leaked: false });
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe(`[Data] Refused a read of sa9-scope.json: the data scope "module" is neither 'guild' nor 'global'; serving the default`);
  });

  it("a file queue question for no guild id answers the guild id's refusal", () => {
    expect(() => dm.guildDocFileQueue(undefined as any, 'mod', 'a.json')).toThrow(GuildKeyError);
    expect(() => dm.guildDocFileQueue(undefined as any, 'mod', 'a.json')).toThrow('[Data] The guild id undefined is not a Discord id; refused');
  });
});

describe('the copy-sync texts of a graveyard restore', () => {
  it('a sync the disk did not confirm', () => {
    expect(dm.RESTORE_TEXTS.copySync(17, 'EIO', 'sync', '/data/123'))
      .toBe('the disk did not confirm the copy of entry 17 (EIO); nothing was restored; check the disk, then restart the machine and try again');
  });

  it('a folder sync that failed earlier in the process', () => {
    expect(dm.RESTORE_TEXTS.copySync(17, 'EIO', 'earlier', '/data/123'))
      .toBe('the copy of entry 17 is not trusted, since the disk did not confirm a folder sync earlier in this process (EIO); nothing was restored; check the disk, then restart the machine and try again');
  });

  it('a folder that could not be opened', () => {
    expect(dm.RESTORE_TEXTS.copySync(17, 'EMFILE', 'open', '/data/123'))
      .toBe('/data/123 could not be opened for the sync of the copy of entry 17 (EMFILE); nothing was restored; try again');
  });
});

describe('the guilds a Postgres bot serves', () => {
  it('lists the owned guilds, leaving out an id that is not a Discord id', () => {
    initWorkingSet({} as any);
    setBackendKind('postgres');
    dm.setOwnedGuildCatalog(['111111111111111111', 'not-a-guild', '222222222222222222']);
    try {
      expect(dm.listGuilds().sort()).toEqual(['111111111111111111', '222222222222222222']);
    } finally {
      dm.setOwnedGuildCatalog([]);
      setBackendKind(null);
    }
  });
});
