import path from 'path';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { listGraveyardEntries } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { flushAll, guildDataOpOf, restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { type Answer, batchExistsAnswer, isBatch, isBatchExists, isFenced, isGraveInsert, isLive, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';

// NB11 fix round 6: class 58 and XX under a localized severity are no answer (NB11-R6-run-1, NB11-R7-T1), the outage line
// names an answered error as one (NB11-R6-data-1, NB11-R6-run-2), and a note that cannot be read refuses the JSON
// restore before anything is removed (NB11-R6-data-2).

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const serverError = (code: string, severity: string, message = `scripted ${severity}`) => Object.assign(new Error(message), { code, severity });
const isCommit = (s: string) => s === 'COMMIT';

function scripted(answer: (sql: string) => Answer) {
  const rig = scriptedPg(answer);
  backends.push(rig.backend);
  return rig;
}

function happy(override: (sql: string) => Answer | null = () => null) {
  return (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true);
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    return undefined;
  };
}

const restore = (backend: PostgresBackend) => backend.restoreGuild('1', null, token, () => null, monoIn(40 * SECOND));
const retire = (backend: PostgresBackend) => backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
const retireAnswers = (override: (sql: string) => Answer | null) => (sql: string): Answer => override(sql) ?? (isFenced(sql) ? { rows: [], rowCount: 1 } : undefined);
const lines = (): string[] => error.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

describe('a PANIC or FATAL sent under a localized severity is no answer', () => {
  const localized = [
    ['PANIK 58030', () => serverError('58030', 'PANIK')],
    ['FEHLER 58030', () => serverError('58030', 'FEHLER')],
    ['localized FATAL XX000', () => serverError('XX000', 'VAZHNO')],
  ] as const;

  it.each(localized)('%s on COMMIT: the restore and the retire answer unknown', async (_name, make) => {
    const restored = scripted(happy(sql => (isCommit(sql) ? make() : null)));
    expect(await restore(restored.backend)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
    const retired = scripted(retireAnswers(sql => (isCommit(sql) ? make() : null)));
    expect(await retire(retired.backend)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it.each(localized)('%s before COMMIT: the restore and the retire answer unavailable, no COMMIT sent', async (_name, make) => {
    const restored = scripted(happy(sql => (isMove(sql) ? make() : null)));
    expect(await restore(restored.backend)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(restored.statements()).not.toContain('COMMIT');
    const retired = scripted(retireAnswers(sql => (isGraveInsert(sql) ? make() : null)));
    expect(await retire(retired.backend)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(retired.statements()).not.toContain('COMMIT');
  });

  it('an answered ERROR in another class on COMMIT is still refused', async () => {
    const { backend } = scripted(happy(sql => (isCommit(sql) ? serverError('40001', 'ERROR') : null)));
    expect(await restore(backend)).toMatchObject({ ok: false, reason: 'refused', code: '40001' });
  });
});

describe('the outage line names what failed', () => {
  const emptyBatch = { upserts: [], deletes: [], appends: [] } as any;

  it('a flush the database answered with 57014 does not say the connection failed', async () => {
    const { backend } = scripted(sql => (isFenced(sql) ? serverError('57014', 'ERROR', 'canceling statement due to statement timeout') : undefined));
    expect(await backend.flushGuild('1', emptyBatch, token)).toMatchObject({ ok: false, reason: 'unavailable' });
    const said = lines();
    expect(said.some(line => line.startsWith('[PostgresBackend] Database operation failed (SQLSTATE 57014); entering outage:'))).toBe(true);
    expect(said.some(line => line.includes('connection failed'))).toBe(false);
  });

  it('a flush that lost its connection says the connection failed', async () => {
    const { backend } = scripted(sql => (isFenced(sql) ? new Error('Connection terminated unexpectedly') : undefined));
    await backend.flushGuild('1', emptyBatch, token);
    expect(lines().some(line => line.startsWith('[PostgresBackend] Database connection failed; entering outage:'))).toBe(true);
  });
});

describe('a JSON restore whose note cannot be read', () => {
  let guilds = 810_000_000_000_000_000n;
  const freshGuild = () => String(++guilds);
  const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);
  const errno = (code: string) => Object.assign(new Error(code), { code });

  beforeEach(() => setBackendKind('file'));
  afterEach(async () => { await flushAll(); });

  function bury(g: string, ms: number): string {
    const dir = entryDir(g, ms);
    fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
    const note = JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2);
    fs.writeFileSync(path.join(dir, '.graveyard.json'), note);
    return note;
  }

  it.each(['EMFILE', 'EACCES'])('%s on the read refuses before the unlink: no unlink, no rename, the note kept', async code => {
    const g = freshGuild();
    const note = bury(g, 1000);
    const notePath = path.join(entryDir(g, 1000), '.graveyard.json');
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: any[]) => {
      if (path.resolve(String(args[0])) === path.resolve(notePath)) throw errno(code);
      return (readFile as any)(...args);
    }) as any);
    const unlink = vi.spyOn(fs.promises, 'unlink');
    const rename = vi.spyOn(fs.promises, 'rename');
    expect(await restoreGuildFromGraveyard(g)).toEqual({
      ok: false,
      code: 'io-error',
      error: `the graveyard entry's note could not be read (${code}); nothing was restored; try again in a moment`,
    });
    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(notePath, 'utf8')).toBe(note);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(guildDataOpOf(g)).toBeUndefined();
    vi.mocked(fs.promises.readFile).mockRestore();
    expect((await listGraveyardEntries()).filter(e => e.guildId === g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
  });

  it('a note that is missing still restores, with an empty reason', async () => {
    const g = freshGuild();
    bury(g, 2000);
    fs.unlinkSync(path.join(entryDir(g, 2000), '.graveyard.json'));
    expect(await restoreGuildFromGraveyard(g)).toEqual({ ok: true, retiredAt: 2000, reason: '' });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });
});
