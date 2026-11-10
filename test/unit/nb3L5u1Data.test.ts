import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotFromPgRows, stageSnapshot, watchSession, type PgSession, type Snapshot } from '../../src/bot/internalSetup/utils/dataMigration';
import { root, wipeRoot } from '../helpers/migrationRig';

// NB3 mutation gate, round u1: the staging folder's handle closed after its fsync, a statement split over several
// spaces or lines named by its first two words, and a live guild's shadow row carrying no retired_at.

const G = '670000000000000001';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the staging folder fsync', () => {
  beforeEach(() => wipeRoot());

  it('closes every handle it opened, the staging folder\'s included, when its fsync succeeds or fails; a failed fsync fails the stage (NB19)', async () => {
    for (const failSync of [false, true]) {
      const staging = path.join(root, failSync ? '.migrate-u1b' : '.migrate-u1a');
      const opened: string[] = [];
      const closed: string[] = [];
      const realOpen = fs.promises.open;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
        const where = path.resolve(String(p));
        opened.push(where);
        if (where === path.resolve(staging)) {
          return {
            stat: async () => ({ dev: 1n, ino: 2n, birthtimeNs: 3n }),
            sync: async () => { if (failSync) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
            close: async () => { closed.push(where); },
          };
        }
        const handle = await (realOpen as any)(p, flags, ...rest);
        const realClose = handle.close.bind(handle);
        handle.close = async () => { closed.push(where); return realClose(); };
        return handle;
      }) as any);
      const snap: Snapshot = {
        items: [{ guildId: G, grave: false, module: 'm', filename: 'a.json', kind: 'doc', bytes: Buffer.from('{"a":1}') }],
        graves: [], guilds: [G], leftOut: [], shadow: [],
      };
      const staged = stageSnapshot(snap, staging);
      // Windows opens no folder for its sync (NB19 decision 1).
      const posix = process.platform !== 'win32';
      if (failSync && posix) await expect(staged).rejects.toThrow("the migration's folders can't be confirmed as stored: the disk did not confirm the sync of");
      else await staged;
      spy.mockRestore();
      if (posix) expect(opened).toContain(path.resolve(staging));
      expect(closed.sort()).toEqual(opened.sort());
      expect(fs.readFileSync(path.join(staging, G, 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
    }
  });
});

describe('the watchdog names a statement split over several spaces or lines', () => {
  function rig(boundMs = 100) {
    const stream = Object.assign(new EventEmitter(), { destroyed: 0, bytesWritten: 0, writableLength: 0, destroy() { this.destroyed += 1; } });
    const session = {
      query: () => new Promise(() => undefined),
      end: async () => undefined,
      connection: { stream },
    } as unknown as PgSession;
    return watchSession(session, boundMs);
  }

  async function errorOf(sql: string): Promise<string> {
    vi.useFakeTimers();
    const w = rig();
    let error = 'none';
    w.query(sql).then(() => { error = 'answered'; }, (e: Error) => { error = e.message; });
    await vi.advanceTimersByTimeAsync(100);
    return error;
  }

  it('a LOCK with two spaces before TABLE is the LOCK TABLE', async () => {
    expect(await errorOf('LOCK  TABLE smdb_data.guild_data IN SHARE MODE')).toBe('The LOCK TABLE got no answer from the database within 0.1 s');
  });

  it('an ALTER whose TABLE starts an indented second line is the ALTER TABLE', async () => {
    expect(await errorOf('ALTER\n    TABLE x ADD COLUMN y int')).toBe('The ALTER TABLE got no answer from the database within 0.1 s');
  });
});

describe('a live guild\'s shadow row', () => {
  it('carries no retired_at, so it names the guild and not a graveyard entry', () => {
    const snap = snapshotFromPgRows([
      { guild_id: G, module: '', filename: 'm/a.json', doc: '{"old":1}' },
      { guild_id: G, module: 'm', filename: 'a.json', doc: '{"new":1}' },
    ], [], []);
    expect(snap.shadow).toHaveLength(1);
    expect(Object.keys(snap.shadow[0]).sort()).toEqual(['bytes', 'filename', 'guildId', 'module']);
    expect(snap.shadow[0]).toStrictEqual({ guildId: G, module: '', filename: 'm/a.json', bytes: Buffer.from('{"old":1}') });
  });
});
