import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  outcome: 'saved',
  pending: false,
  file: undefined as string | undefined,
  renameFails: false,
  renamed: [] as string[],
}));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  const mine = (p: unknown) => String(p).endsWith('persistent-panels.json');
  const readFileSync = ((p: string, ...rest: unknown[]) => {
    if (!mine(p)) return (real.readFileSync as any)(p, ...rest);
    if (s.file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return s.file;
  }) as typeof real.readFileSync;
  const renameSync = ((from: string, to: string) => {
    if (!mine(from)) return real.renameSync(from, to);
    if (s.renameFails) throw new Error('busy');
    s.renamed.push(String(from));
  }) as typeof real.renameSync;
  return { ...real, default: { ...real, readFileSync, renameSync }, readFileSync, renameSync };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPending: () => (s.pending ? {} : undefined),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const update = (key: string, apply: (current: unknown) => unknown) => {
    if (s.outcome === 'saved') s.db[key] = apply(s.db[key]);
    return { outcome: s.outcome };
  };
  return {
    ...(await importOriginal<object>()),
    isClosedForExit: () => false,
    areGuildWritesClosed: () => false,
    loadModuleData: (_f: string, guildId: string) => s.db[guildId],
    loadGlobalModuleData: () => s.db.global,
    updateModuleData: (_f: string, guildId: string, _n: string, _d: unknown, apply: (c: unknown) => unknown) => update(guildId, apply),
    updateGlobalModuleData: (_f: string, _n: string, _d: unknown, apply: (c: unknown) => unknown) => update('global', apply),
  };
});

import {
  getPersistentPanel,
  removePersistentPanel,
  storePersistentPanel,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { setBackendKind } from '../helpers/backendKind';

const inst = (messageId: string) => ({ messageId, channelId: 'c', userId: 'u', createdAt: 0, lastUpdated: 0, state: 'a' }) as any;
let errors: any;

beforeEach(() => {
  s.db = {};
  s.outcome = 'saved';
  s.pending = false;
  s.file = undefined;
  s.renameFails = false;
  s.renamed = [];
  setBackendKind('file');
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('an unparsable panel registry file is moved aside only when it is safe', () => {
  it('a file that does not parse is moved aside', async () => {
    s.file = '{bad';
    expect((await storePersistentPanel('p', inst('m'), 'g')).success).toBe(true);
    expect(s.renamed).toHaveLength(1);
  });

  it('a guild served by Postgres moves nothing', async () => {
    setBackendKind('postgres');
    s.file = '{bad';
    await storePersistentPanel('p', inst('m'), 'g');
    expect(s.renamed).toEqual([]);
  });

  it('a file with a queued write is not moved', async () => {
    s.pending = true;
    s.file = '{bad';
    await storePersistentPanel('p', inst('m'), 'g');
    expect(s.renamed).toEqual([]);
  });

  it('a file that parses is not moved', async () => {
    s.file = '{}';
    await storePersistentPanel('p', inst('m'), 'g');
    expect(s.renamed).toEqual([]);
  });

  it('a failed move tells the operator the file could not be moved aside', async () => {
    s.file = '{bad';
    s.renameFails = true;
    await storePersistentPanel('p', inst('m'), 'g');
    expect(String(errors.mock.calls[0][0])).toMatch(/^\[Panels\] The panel registry .*persistent-panels\.json does not parse and could not be moved aside:$/);
  });
});

describe('the stored value an update starts from', () => {
  it.each([['null', null], ['a string', 'x']])('%s is replaced by records', async (_label, value) => {
    s.db.g = value;
    expect((await storePersistentPanel('p', inst('m'), 'g')).success).toBe(true);
    expect((s.db.g as any).p.messageId).toBe('m');
  });
});

describe('the not-saved log', () => {
  it('a saved update logs nothing', async () => {
    await storePersistentPanel('p', inst('m'), 'g');
    expect(errors).not.toHaveBeenCalled();
  });

  it('a refused update names the guild, or global', async () => {
    s.outcome = 'refused';
    expect((await storePersistentPanel('p', inst('m'), 'g1')).success).toBe(false);
    expect((await storePersistentPanel('p', inst('m'))).success).toBe(false);
    expect(errors.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      '[PersistentPanels] Panel records for g1 were not saved',
      '[PersistentPanels] Panel records for global were not saved',
    ]);
  });
});

describe('getPersistentPanel reads only well-formed records', () => {
  it('a null record is no panel, with or without a session', async () => {
    s.db.g = { p: null };
    expect(await getPersistentPanel('p', 'g', 's')).toBeNull();
  });

  it('a string record is no panel, with or without a session', async () => {
    s.db.g = { p: 'abc' };
    expect(await getPersistentPanel('p', 'g', 's')).toBeNull();
    expect(await getPersistentPanel('p', 'g')).toBeNull();
  });

  it('an object without a messageId is no panel', async () => {
    s.db.g = { p: { foo: 1 } };
    expect(await getPersistentPanel('p', 'g')).toBeNull();
  });
});

describe('removePersistentPanel removes only the instance it names', () => {
  const sessions = () => ({ p: { sessions: { s: inst('m'), t: inst('n') } } });

  it('a missing or null panel removes nothing', async () => {
    s.db.g = { p: null };
    expect(await removePersistentPanel('p', 'g')).toBe(false);
    expect(await removePersistentPanel('p', 'g', 's')).toBe(false);
    expect(await removePersistentPanel('none', 'g')).toBe(false);
  });

  it('a string panel removes nothing for a session', async () => {
    s.db.g = { p: 'abc' };
    expect(await removePersistentPanel('p', 'g', 's')).toBe(false);
  });

  it('a missing session removes nothing', async () => {
    s.db.g = sessions();
    expect(await removePersistentPanel('p', 'g', 'x')).toBe(false);
    expect(await removePersistentPanel('p', 'g', 'x', 'm')).toBe(false);
    expect(s.db.g).toEqual(sessions());
  });

  it('a session on another message stays', async () => {
    s.db.g = sessions();
    expect(await removePersistentPanel('p', 'g', 's', 'other')).toBe(false);
    expect(s.db.g).toEqual(sessions());
  });

  it('a session is removed with or without its message, and the panel stays while it has sessions', async () => {
    s.db.g = sessions();
    expect(await removePersistentPanel('p', 'g', 's')).toBe(true);
    expect(Object.keys((s.db.g as any).p.sessions)).toEqual(['t']);
    expect(await removePersistentPanel('p', 'g', 't', 'n')).toBe(true);
    expect(s.db.g).toEqual({});
  });

  it('a panel without sessions is removed without a message id', async () => {
    s.db.g = { q: inst('m') };
    expect(await removePersistentPanel('q', 'g')).toBe(true);
    expect(s.db.g).toEqual({});
  });
});

describe('storePersistentPanel with a session over a record that is not an object', () => {
  it('replaces a string record with sessions', async () => {
    s.db.g = { p: 'abc' };
    expect((await storePersistentPanel('p', inst('m'), 'g', 's')).success).toBe(true);
    expect((s.db.g as any).p.sessions.s.messageId).toBe('m');
  });
});
