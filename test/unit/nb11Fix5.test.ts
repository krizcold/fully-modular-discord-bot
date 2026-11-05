import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { BotManager } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { createGraveyardRoutes, graveyardRouteRefusal } from '../../src/webui/routes/graveyard';
import { call, startApp } from '../helpers/configRig';
import { type Answer, isBatch, isFenced, isGraveInsert, isLive, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';

// NB11 fix round 5: a FATAL or PANIC ends the session and is no answer (NB11-R5-data-1), a given batch that does not
// exist answers no-entry before the live check (NB11-R5-data-2, NB11-R5-T1), a refusal while the bot waits for another
// process keeps who holds the files (NB11-R5-run-1), and the outage line says the connection failed.

const SECOND = 1000;
const G = '123456789012345678';
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
const isExists = (s: string) => /^SELECT 1 FROM smdb_data\.guild_data_graveyard WHERE guild_id = \$1 AND retired_at = \$2/.test(s);
const serverError = (code: string, severity: string) => Object.assign(new Error(`scripted ${severity}`), { code, severity });
const panic = () => serverError('58030', 'PANIC');
const fatal = () => serverError('XX000', 'FATAL');

function scripted(answer: (sql: string) => Answer) {
  const rig = scriptedPg(answer);
  backends.push(rig.backend);
  return rig;
}

function happy(override: (sql: string) => Answer | null = () => null, batchFound = true) {
  return (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isExists(sql)) return batchFound ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    return undefined;
  };
}

const isCommit = (s: string) => s === 'COMMIT';
const restore = (backend: PostgresBackend, retiredAt: number | null = null) => backend.restoreGuild('1', retiredAt, token, () => null, monoIn(40 * SECOND));
const retire = (backend: PostgresBackend) => backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
const retireAnswers = (override: (sql: string) => Answer | null) => (sql: string): Answer => override(sql) ?? (isFenced(sql) ? { rows: [], rowCount: 1 } : undefined);

describe('a FATAL or PANIC ends the session and is no answer', () => {
  it.each([['PANIC 58030', panic], ['FATAL XX000', fatal]] as const)('%s on COMMIT: the restore and the retire answer unknown', async (_name, make) => {
    const restored = scripted(happy(sql => (isCommit(sql) ? make() : null)));
    expect(await restore(restored.backend)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
    expect(restored.backend.connectionState().state).toBe('outage');
    const retired = scripted(retireAnswers(sql => (isCommit(sql) ? make() : null)));
    expect(await retire(retired.backend)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it.each([['PANIC 58030', panic], ['FATAL XX000', fatal]] as const)('%s before COMMIT: the restore and the retire answer unavailable, no COMMIT sent', async (_name, make) => {
    const restored = scripted(happy(sql => (isMove(sql) ? make() : null)));
    const answer: any = await restore(restored.backend);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(answer.timedOut).toBeUndefined();
    expect(restored.statements()).not.toContain('COMMIT');
    const retired = scripted(retireAnswers(sql => (isGraveInsert(sql) ? make() : null)));
    expect(await retire(retired.backend)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(retired.statements()).not.toContain('COMMIT');
  });

  it('an ERROR with the same SQLSTATE on COMMIT is still an answer: refused', async () => {
    const { backend } = scripted(happy(sql => (isCommit(sql) ? serverError('58030', 'ERROR') : null)));
    expect(await restore(backend)).toMatchObject({ ok: false, reason: 'refused', code: '58030' });
    expect(backend.connectionState().state).toBe('ready');
  });
});

describe('a given batch is checked before the live check', () => {
  it('a batch that does not exist on a guild with live rows answers no-entry; no live check, no move, ROLLBACK, no COMMIT', async () => {
    const { backend, statements } = scripted(happy(sql => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : null), false));
    expect(await restore(backend, 5)).toEqual({ ok: false, reason: 'no-entry' });
    const sent = statements();
    expect(sent.filter(isExists)).toHaveLength(1);
    expect(sent.filter(isLive)).toEqual([]);
    expect(sent.filter(isMove)).toEqual([]);
    expect(sent).toContain('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });

  it('the existence read runs after the fenced update, with the guild and the batch', async () => {
    const { backend, sent } = scripted(happy());
    expect(await restore(backend, 9)).toMatchObject({ ok: true, retiredAt: 9 });
    const order = sent.map(s => s.sql);
    const at = order.findIndex(isExists);
    expect(at).toBeGreaterThan(order.findIndex(isFenced));
    expect(at).toBeLessThan(order.findIndex(isLive));
    expect(order.filter(isBatch)).toEqual([]);
  });

  it('an existing batch on a guild with live rows still answers live-rows naming it', async () => {
    const { backend } = scripted(happy(sql => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : null)));
    expect(await restore(backend, 5)).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
  });

  it('no batch given: no existence read', async () => {
    const { backend, statements } = scripted(happy());
    expect(await restore(backend)).toMatchObject({ ok: true, retiredAt: 5 });
    expect(statements().filter(isExists)).toEqual([]);
  });
});

describe('the outage line', () => {
  it('says the database connection failed', async () => {
    const { backend } = scripted(happy(sql => (isMove(sql) ? new Error('Connection terminated unexpectedly') : null)));
    await restore(backend);
    const lines: string[] = error.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
    expect(lines.some(line => line.startsWith('[PostgresBackend] Database connection failed; entering outage:'))).toBe(true);
    expect(lines.some(line => line.includes('Operation failed'))).toBe(false);
  });
});

describe('a refusal while the bot waits for another process', () => {
  const waiting = 'The bot is waiting for a data bundle import (pid 4321) to release the data files; nothing was saved. Try again once it has.';
  const restoreText = 'The bot is waiting for a data bundle import (pid 4321) to release the data files; nothing was restored. Try again once it has.';
  const deleteText = 'The bot is waiting for a data bundle import (pid 4321) to release the data files; nothing was removed. Try again once it has.';

  it('keeps the holder and names what was not done', async () => {
    expect(graveyardRouteRefusal('starting', waiting, 'restore')).toBe(restoreText);
    expect(graveyardRouteRefusal('starting', waiting, 'guild-delete')).toBe(deleteText);
    expect(graveyardRouteRefusal('starting', undefined, 'restore')).toBe('the bot is starting; nothing was restored; try again once the bot has started');
    const reply = { ok: false, code: 'starting', error: waiting };
    const manager = { writeGuildData: async () => reply, isRunning: () => true, writeRefusal: () => null } as unknown as BotManager;
    const app = await startApp(a => {
      a.use('/api/data/graveyard', createGraveyardRoutes(manager));
      a.use('/api/config', createConfigRoutes(manager));
    });
    try {
      const restored = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: G, retiredAt: 5 });
      expect(restored.status).toBe(503);
      expect(restored.body).toEqual({ success: false, error: restoreText });
      const deleted = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(deleted.status).toBe(503);
      expect(deleted.body).toEqual({ success: false, error: deleteText });
    } finally {
      await app.close();
    }
  });
});
