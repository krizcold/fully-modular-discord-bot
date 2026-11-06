import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { placeGuildWrite, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';

// NB12 code review round 1 fixes (wip-redesign/sheets/NB12.md): DL-4, OPS-1, OPS-4 with DL-5.

const MIB = 1024 * 1024;
const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];
let guilds = 9_300_000_000;

afterEach(async () => {
  setGuildViewCache(false);
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
};

function scripted(answer: (sql: string) => unknown = () => undefined) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  let sent = 0;
  (backend.getPool() as unknown as { connect: unknown }).connect = async () => ({
    query: async (sql: string) => {
      sent += 1;
      if (/INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) return { rows: [], rowCount: 1 };
      const res = await answer(sql);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  return { backend, sent: () => sent };
}

describe('a cached folder record another process wrote into (DL-4)', () => {
  it('a save of the folder name is refused unstorable, not io', () => {
    quiet();
    setGuildViewCache(true);
    const guildId = String(++guilds);
    const folder = dataPath(guildId, 'm', 'a');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'y.json.99999999.1.tmp'), '{}');
    expect(placeGuildWrite(guildId, 'm/a')).toMatchObject({ ok: false, cause: 'io' });
    fs.writeFileSync(path.join(folder, 'x.json'), '{"v":1}');
    const answer = placeGuildWrite(guildId, 'm/a');
    expect(answer).toMatchObject({ ok: false, cause: 'unstorable' });
    expect((answer as { reason: string }).reason).toContain('m/a names a folder');
    expect(fs.readFileSync(path.join(folder, 'x.json'), 'utf8')).toBe('{"v":1}');
  });

  it('a folder emptied since the failed removal is removed and the write placed', () => {
    quiet();
    setGuildViewCache(true);
    const guildId = String(++guilds);
    const folder = dataPath(guildId, 'm', 'a');
    fs.mkdirSync(folder, { recursive: true });
    const temp = path.join(folder, 'y.json.99999999.1.tmp');
    fs.writeFileSync(temp, '{}');
    expect(placeGuildWrite(guildId, 'm/a')).toMatchObject({ ok: false, cause: 'io' });
    fs.unlinkSync(temp);
    expect(placeGuildWrite(guildId, 'm/a')).toEqual({ ok: true });
    expect(fs.existsSync(folder)).toBe(false);
  });
});

describe('a flush of very many statements (OPS-1)', () => {
  it('200,000 append buffers answer ok, and nothing throws out of flushGuild', async () => {
    quiet();
    const { backend, sent } = scripted();
    const appends: GuildFlushBatch['appends'] = Array.from({ length: 200_000 }, (_, i) => ({ key: { module: 'm', filename: `l${i}.jsonl` }, chunk: 'a\n' }));
    await expect(backend.flushGuild('1', { upserts: [], deletes: [], appends }, token)).resolves.toEqual({ ok: true });
    expect(sent()).toBeGreaterThanOrEqual(200_000);
  }, 60_000);
});

describe('the 57014 log counts to the failure, not past the ROLLBACK (OPS-4, DL-5)', () => {
  it('a cancel 1 s before the bound with a slow ROLLBACK is logged as a cancel', async () => {
    const error = quiet();
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { backend } = scripted(sql => {
      if (sql.startsWith('INSERT INTO smdb_data.guild_data')) {
        now += 670_000;
        return Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
      }
      if (sql === 'ROLLBACK') now += 5_000;
      return undefined;
    });
    const upserts = [{ key: { module: 'm', filename: 'd.json' }, doc: 'x'.repeat(4 * MIB - 100) }];
    expect(await backend.flushGuild('7', { upserts, deletes: [], appends: [] }, token)).toMatchObject({ ok: false, reason: 'unavailable' });
    const line = error.mock.calls.map(c => String(c[0])).find(l => l.includes('SQLSTATE 57014'))!;
    expect(line).toContain("was cancelled after 670 s, before the flush's 671 s bound");
    expect(line).not.toContain('did not finish within');
  });
});
