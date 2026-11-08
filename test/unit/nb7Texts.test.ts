import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendHopReply } from '../../src/webui/routes/config';
import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { RESTORE_TEXTS, restoreNoAnswerEnding } from '../../src/bot/internalSetup/utils/dataManager';
import { REQUEST_INSERT_SQL, REQUEST_POLL_SQL, SETTLE_UPDATE_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { endGuildRequests, NB7_TEXTS, OP_WORDS, remoteNoAnswerText, remoteRestoreNoAnswerCause } from '../../src/webui/utils/guildRequests';
import { call, startApp } from '../helpers/configRig';
import { BOT_DOWN, fakeBot, GUILD, isInsert, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

// The restore route reads the guild's newest entry through the reader before it sends (NB14 decision 13); the rig
// scripts the request database only, so the reader answers that this guild has no entry.
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const actual = await orig<typeof import('../../src/webui/utils/webuiDataReader')>();
  let reader: ReturnType<typeof actual.getWebuiDataReader> | null = null;
  return {
    ...actual,
    getWebuiDataReader: () => {
      reader ??= Object.assign(Object.create(actual.getWebuiDataReader()), { listGuildGraveyard: async () => [] });
      return reader!;
    },
  };
});

// NB7 decision 9 and 11: the answers of the request route, as sendHopReply and the graveyard route give them.

afterEach(() => {
  resetNb7();
  vi.restoreAllMocks();
});

function answer(reply: any, what: 'write' | 'delete' | 'guild-delete' = 'write') {
  const out: { status?: number; body?: any } = {};
  const res = { status(code: number) { out.status = code; return this; }, json(body: any) { out.body = body; return this; } } as any;
  sendHopReply(res, reply, {}, what);
  return out;
}

describe('sendHopReply with servedBy', () => {
  it('ok: the route\'s own success', () => {
    expect(answer({ ok: true, servedBy: 'BRAVO' })).toEqual({ status: 200, body: { success: true, servedBy: 'BRAVO' } });
  });

  it('pending: 202, prefixed, with the note when there is one', () => {
    expect(answer({ ok: true, pending: true, servedBy: 'BRAVO' })).toMatchObject({ status: 202, body: { message: 'On BRAVO: not confirmed as saved yet; reload in a moment to check' } });
    expect(answer({ ok: true, pending: true, note: 'it is not saved yet', servedBy: 'BRAVO' })).toMatchObject({ status: 202, body: { message: 'On BRAVO: it is not saved yet' } });
  });

  it.each([
    ['frozen', 503],
    ['not-owner', 503],
    ['backend-unavailable', 503],
    ['maintenance', 503],
    ['invalid', 400],
    ['changed', 409],
    ['changed-since-open', 409],
    ['io-error', 500],
    ['held-elsewhere', 503],
  ])('a holder\'s %s: its status, the local text with the prefix', (code, status) => {
    const local = answer({ ok: false, code, error: code === 'frozen' ? undefined : 'the local text' });
    const remote = answer({ ok: false, code, error: code === 'frozen' ? undefined : 'the local text', servedBy: 'BRAVO' });
    expect(remote.status).toBe(status);
    expect(remote.body.error).toBe(`On BRAVO: ${local.body.error}`);
  });

  it('a sender\'s own answer carries no prefix', () => {
    expect(answer({ ok: false, code: 'not-taken', error: 'X', servedBy: 'BRAVO', sender: true })).toEqual({ status: 503, body: { success: false, code: 'not-taken', error: 'X', servedBy: 'BRAVO' } });
    expect(answer({ ok: false, code: 'no-holder', error: 'Y', sender: true })).toEqual({ status: 503, body: { success: false, code: 'no-holder', error: 'Y' } });
  });

  it.each([
    ['write', 'timeout', "BRAVO did not answer in time; can't confirm whether the change was saved. Reload to check."],
    ['write', 'lost', "The answer from BRAVO could not be read from the database; can't confirm whether the change was saved. Reload to check."],
    ['delete', 'timeout', "BRAVO did not answer in time; can't confirm whether the file was deleted. Reload to check."],
    ['guild-delete', 'lost', "The answer from BRAVO could not be read from the database; can't confirm whether this server's data was deleted. Within a minute, `smdb graveyard list` lists a new entry for this server with the reason webui-operator-delete if it was deleted; if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main."],
  ] as const)('%s with noAnswer %s: 503 no-answer naming the machine', (what, cause, text) => {
    expect(answer({ ok: false, code: 'no-answer', noAnswer: cause, servedBy: 'BRAVO', sender: true }, what)).toEqual({ status: 503, body: { success: false, code: 'no-answer', error: text, servedBy: 'BRAVO' } });
  });
});

describe('the guild delete text after no answer (NB5 H7, H8)', () => {
  const TAIL = "can't confirm whether this server's data was deleted. Within a minute, `smdb graveyard list` lists a new entry for this server with the reason webui-operator-delete if it was deleted; if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.";
  it.each([
    ['timeout', 'BRAVO did not answer in time'],
    ['unsettled', 'The database could not show that the change sent to BRAVO was withdrawn before BRAVO took it'],
    ['stopped', 'This web panel shut down before it read the answer from BRAVO'],
  ])('%s: the lead, then the text', (cause, lead) => {
    expect(remoteNoAnswerText(cause, 'BRAVO', 'guild-delete')).toBe(`${lead}; ${TAIL}`);
  });
});

describe('the graveyard restore through the request route', () => {
  async function restoreWith(reply: unknown, polls: (sql: string) => unknown = () => ({ rows: [{ state: 'done', reply: JSON.stringify(reply), pickup_over: false, answer_over: false }] })) {
    const rig = nb7Rig();
    rig.script['postgres://one'] = sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n') ? { rows: [], rowCount: 1 } : polls(sql));
    const app = await startApp(a => a.use('/api/data/graveyard', createGraveyardRoutes(fakeBot({ route: BOT_DOWN }).bot)));
    try {
      return await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: GUILD });
    } finally {
      await app.close();
    }
  }

  it('ok: the restore\'s answer', async () => {
    expect(await restoreWith({ ok: true, retiredAt: 5, reason: 'r', copied: 2 })).toEqual({ status: 200, body: { success: true, retiredAt: 5, reason: 'r', copied: 2, servedBy: 'BRAVO' } });
  });

  it('a refusal: the restore\'s own text with the prefix', async () => {
    expect(await restoreWith({ ok: false, code: 'not-owner' })).toEqual({ status: 503, body: { success: false, error: "On BRAVO: another bot process now serves this server's data; nothing was restored", servedBy: 'BRAVO' } });
    expect(await restoreWith({ ok: false, code: 'invalid', error: 'no entry' })).toEqual({ status: 409, body: { success: false, error: 'On BRAVO: no entry', servedBy: 'BRAVO' } });
  });

  async function restoreLocally(reply: unknown) {
    const local = fakeBot({ write: () => reply });
    const app = await startApp(a => a.use('/api/data/graveyard', createGraveyardRoutes(local.bot)));
    try {
      const out = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: GUILD });
      expect(local.writes).toHaveLength(1);
      return out;
    } finally {
      await app.close();
    }
  }

  it.each([
    [{ ok: false, code: 'frozen' }],
    [{ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.outOfTime }],
    [{ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.nodeStopping }],
    [{ ok: false, code: 'maintenance', error: 'Back soon' }],
    [{ ok: false, code: 'held-elsewhere', error: 'x' }],
    [{ ok: false, code: 'io-error', error: 'boom' }],
  ])('NB7-R4-T2: a holder\'s %o: the local status and text, prefixed with the machine, with servedBy', async reply => {
    const local = await restoreLocally(reply);
    expect(local.body.servedBy).toBeUndefined();
    expect(local.body.error).not.toMatch(/^On /);
    const remote = await restoreWith(reply);
    expect(remote.status).toBe(local.status);
    expect(remote.body).toEqual({ ...local.body, error: `On BRAVO: ${local.body.error}`, servedBy: 'BRAVO' });
  });

  it.each([
    ['timeout', (_rig: Rig) => (sql: string) => (sql === REQUEST_POLL_SQL ? { rows: [{ state: 'applying', reply: null, pickup_over: true, answer_over: true }] } : undefined)],
    ['lost', (_rig: Rig) => (sql: string) => (sql === REQUEST_POLL_SQL ? { rows: [{ state: 'done', reply: 'not json', pickup_over: true, answer_over: false }] } : undefined)],
    ['unsettled', (rig: Rig) => {
      rig.server['postgres://one'] = 'server-2';
      return (sql: string) => (sql === REQUEST_POLL_SQL ? { rows: [{ state: 'expired', reply: null, pickup_over: true, answer_over: false }] } : undefined);
    }],
    ['stopped', (_rig: Rig) => (sql: string) => {
      if (sql === REQUEST_POLL_SQL) {
        void endGuildRequests();
        return { rows: [{ state: 'applying', reply: null, pickup_over: true, answer_over: false }] };
      }
      return sql === SETTLE_UPDATE_SQL ? { rows: [], rowCount: 0 } : undefined;
    }],
  ] as const)('noAnswer %s: 503 can\'t confirm naming the machine, with servedBy, never "nothing was"', async (cause, afterInsert) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rig = nb7Rig();
    rig.server['postgres://one'] = 'server-1';
    let polls: ((sql: string) => unknown) | null = null;
    rig.script['postgres://one'] = sql => {
      if (sql === REQUEST_INSERT_SQL) {
        polls = afterInsert(rig);
        return { rows: [], rowCount: 1 };
      }
      return polls ? polls(sql) : undefined;
    };
    const app = await startApp(a => a.use('/api/data/graveyard', createGraveyardRoutes(fakeBot({ route: BOT_DOWN }).bot)));
    let out: { status: number; body: any };
    try {
      out = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: GUILD });
    } finally {
      await app.close();
    }
    expect(rig.statements.filter(isInsert)).toHaveLength(1);
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ success: false, error: `can't confirm whether server ${GUILD} was restored: ${remoteRestoreNoAnswerCause(cause, 'BRAVO')}. ${restoreNoAnswerEnding(GUILD, undefined, undefined, false)}`, servedBy: 'BRAVO' });
    expect(out.body.error).toMatch(/BRAVO/);
    expect(out.body.error).not.toMatch(/nothing was/);
    expect(out.body.error).not.toMatch(/the bot did not answer within 50 s/);
  });

  it('a guild id above the bigint range: 400', async () => {
    const rig = nb7Rig();
    const app = await startApp(a => a.use('/api/data/graveyard', createGraveyardRoutes(fakeBot({ route: BOT_DOWN }).bot)));
    try {
      expect(await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: '99999999999999999999' })).toEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' } });
      expect(rig.holderCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('every NB7 text', () => {
  const name = 'BRAVO';
  const all = Object.values(OP_WORDS).flatMap(saved => [
    NB7_TEXTS.noCount(saved),
    NB7_TEXTS.noRow(1, 2, saved),
    NB7_TEXTS.deferred(1, 2, name, saved),
    NB7_TEXTS.kept(1, 2, name, saved),
    NB7_TEXTS.reserved(1, 2, name, saved),
    NB7_TEXTS.lookupRefused('42501', 'denied', saved),
    NB7_TEXTS.lookupUnreachable('connect ECONNREFUSED', saved),
    NB7_TEXTS.tooSlow(name, saved),
    NB7_TEXTS.noTable(saved),
    NB7_TEXTS.insertRefused('22P02', 'bad', saved),
    NB7_TEXTS.unreachable(name, 'ECONNREFUSED', saved),
    NB7_TEXTS.notTaken(name, saved),
    NB7_TEXTS.withdrawnAtExit(name, saved),
    NB7_TEXTS.withdrawn(name, saved),
    NB7_TEXTS.stoppedServing(name, saved),
    NB7_TEXTS.unapplied(name, saved),
  ]);
  const unknown = [NB7_TEXTS.heldNotice(name), NB7_TEXTS.noHolderNotice, NB7_TEXTS.readLookupFailed('x')];

  it('is ASCII with no long dash', () => {
    for (const text of [...all, ...unknown]) {
      expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    }
  });

  it('every refusal before anything was applied says nothing was, and none says can\'t confirm', () => {
    for (const text of all) {
      expect(text).toMatch(/nothing was (saved|deleted|removed|restored)/i);
      expect(text).not.toMatch(/can't confirm/);
    }
  });
});
