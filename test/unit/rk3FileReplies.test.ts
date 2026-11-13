import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({
  restore: null as null | (() => Promise<unknown>),
  sync: { failed: false } as { failed: false } | { failed: true; dir: string; code: string; kind: 'sync' | 'open' },
  forgotten: [] as string[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    guildDirExists: () => true,
    flushGuild: async () => {},
    guildHasQueuedOps: () => false,
    graveyardGuildDir: async () => true,
    fsyncDataDirs: async () => files.sync,
    forgetGuildDurableFiles: (guildId: string) => { files.forgotten.push(guildId); real.forgetGuildDurableFiles(guildId); },
    restoreGuildDirFromGraveyard: async () => (files.restore ? files.restore() : { ok: false, why: 'no-entry' }),
  };
});

import { RESTORE_TEXTS, deleteGuildNamespace, restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { freshGuild } from '../helpers/gateRig';

// The JSON backend's retire after a failed folder sync, and the restore's replies built from the file outcome.

let errors: string[];
beforeEach(() => {
  errors = [];
  files.restore = null;
  files.sync = { failed: false };
  files.forgotten = [];
  setBackendKind('file');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe('a JSON retire whose folder sync failed', () => {
  it('answers ok with the code unconfirmed, forgets the guild durable names and logs the power-cut risk', async () => {
    const g = freshGuild();
    files.sync = { failed: true, dir: '/data/_graveyard', code: 'EIO', kind: 'sync' };
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: true, moveUnconfirmed: 'EIO' });
    expect(files.forgotten).toEqual([g]);
    expect(errors).toContain(`[DataManager] Guild ${g} moved to graveyard, but the disk did not confirm the sync of /data/_graveyard (EIO), so a power cut can bring its folder back live`);
  });

  it('a sync that held forgets nothing and logs nothing', async () => {
    const g = freshGuild();
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: true });
    expect(files.forgotten).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('the JSON restore reply', () => {
  const restoring = (outcome: unknown) => { files.restore = async () => outcome; };

  it('a plain restore with its sync confirmed answers neither replaced nor moveUnconfirmed', async () => {
    restoring({ ok: true, retiredAt: 5, reason: 'left', usedAt: 100 });
    const reply = await restoreGuildFromGraveyard(freshGuild(), 5);
    expect(reply).toMatchObject({ ok: true, retiredAt: 5, reason: 'left' });
    expect(Object.keys(reply)).not.toContain('replaced');
    expect(Object.keys(reply)).not.toContain('moveUnconfirmed');
  });

  it('a restore whose move was not confirmed by the disk answers its code, and a replace its batch', async () => {
    restoring({ ok: true, retiredAt: 5, reason: 'left', usedAt: 100, replaced: { retiredAt: 8 }, moveUnconfirmed: 'EIO' });
    expect(await restoreGuildFromGraveyard(freshGuild(), 5, undefined, true)).toMatchObject({ ok: true, replaced: { retiredAt: 8 }, moveUnconfirmed: 'EIO' });
  });

  it('a copy the disk did not confirm answers the copy-sync text', async () => {
    restoring({ ok: false, why: 'copy-sync', x: 5, code: 'EIO', kind: 'sync', dir: '/data' });
    expect(await restoreGuildFromGraveyard(freshGuild(), 5)).toEqual({ ok: false, code: 'io-error', error: RESTORE_TEXTS.copySync(5, 'EIO', 'sync', '/data') });
  });

  it('an undo with its sync confirmed adds no clause', async () => {
    restoring({ ok: false, why: 'undone', x: 5, r: 6, code: 'EXDEV' });
    expect(await restoreGuildFromGraveyard(freshGuild(), 5)).toEqual({ ok: false, code: 'io-error', error: RESTORE_TEXTS.undo(5, 'EXDEV') });
    restoring({ ok: false, why: 'undone-taken', x: 5, r: 6, code: 'EXDEV' });
    expect(await restoreGuildFromGraveyard(freshGuild(), 5)).toEqual({ ok: false, code: 'io-error', error: RESTORE_TEXTS.undoTaken(5, 'EXDEV') });
  });

  it('an undo the disk did not confirm adds the clause', async () => {
    const g = freshGuild();
    restoring({ ok: false, why: 'undone-taken', x: 5, r: 6, code: 'EXDEV', syncCode: 'EIO' });
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'io-error', error: RESTORE_TEXTS.undoTaken(5, 'EXDEV') + RESTORE_TEXTS.undoUnconfirmed(g, 6, 'EIO') });
  });
});
