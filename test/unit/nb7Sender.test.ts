import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endGuildRequests, NB7_TEXTS, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { UNAPPLIED_REPLY } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { sendHopReply } from '../../src/webui/routes/config';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { fakeBot, fakeTime, GUILD, HANG, isInsert, isPoll, isSettleInsert, isSettleUpdate, nb7Rig, requestPlan, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

// NB7 decisions 6, 8 and 14: the sender's insert, follow and settle, each outcome with its answer, by the deadline.

const URL1 = 'postgres://one';
const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });
const poll = (state: string, over: Record<string, unknown> = {}) => ({ rows: [{ state, reply: null, pickup_over: false, answer_over: false, ...over }] });

let rig: Rig;
beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
});
afterEach(() => {
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function send(op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard' = 'write', payload: any = writeOf()) {
  const plan = await requestPlan(op);
  const started = performance.now();
  const answer = sendGuildChange(fakeBot().bot, plan, { ...payload, op });
  let value: any;
  let at = -1;
  void answer.then(v => { value = v; at = performance.now() - started; });
  return { plan, done: async (ms = 120_000) => { await vi.advanceTimersByTimeAsync(ms); return { value, at }; } };
}

const at = (script: (sql: string, values: unknown[]) => unknown) => { rig.script[URL1] = script; };
const by = (sql: string) => rig.statements.filter(s => s.sql === sql);

describe('the insert', () => {
  it('committed, then done: the holder\'s reply, with servedBy', async () => {
    at(sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n') ? { rows: [], rowCount: 1 } : poll('done', { reply: '{"ok":true}' })));
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    const insert = rig.statements.find(isInsert)!;
    expect(insert.boundMs).toBe(5000);
    expect(insert.values.slice(1, 8)).toEqual([GUILD, 2, 1, 'p-b', 'write', JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"a":1}', expectSha: 'absent' }), 'ALPHA']);
    expect(insert.values.slice(8)).toEqual([5, 20]);
  });

  it.each([
    ['28000', { code: 'maintenance' }],
    ['42P01', { code: 'backend-unavailable', error: 'This database has no table for changes sent between machines: it was created by an older version of the bot. Nothing was saved.' }],
    ['22P02', { code: 'backend-unavailable', error: 'The database refused the change (SQLSTATE 22P02: refused); nothing was saved.' }],
    ['57014', { code: 'backend-unavailable', error: 'The database refused the change (SQLSTATE 57014: refused); nothing was saved.' }],
  ])('a rollback SQLSTATE %s refuses with nothing sent after it', async (code, expected) => {
    at(sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n') ? pgError(code) : undefined));
    const { done } = await send();
    const { value } = await done(1000);
    expect(value).toMatchObject({ ok: false, ...expected });
    expect(rig.statements).toHaveLength(1);
  });

  it('a login refused at the connect (28000): the maintenance code, nothing sent', async () => {
    rig.connectFails[URL1] = pgError('28000', 'role is not permitted to log in');
    const { done } = await send();
    const { value } = await done(1000);
    expect(value).toMatchObject({ ok: false, code: 'maintenance' });
    expect(rig.statements).toHaveLength(0);
  });

  it('a connect failure: nothing sent', async () => {
    rig.connectFails[URL1] = new Error('connect ECONNREFUSED');
    const { done } = await send();
    const { value } = await done(1000);
    expect(value).toMatchObject({ ok: false, code: 'backend-unavailable', error: "Can't reach the database to send this change to BRAVO (connect ECONNREFUSED); nothing was saved. Try again in a moment." });
    expect(rig.statements).toHaveLength(0);
  });

  it.each([['57P01'], ['08006']])('%s at the insert goes to the insert-form settle; a returned row withdraws it', async code => {
    at(sql => (isInsert({ sql } as any) ? pgError(code) : isSettleInsert({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined));
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'backend-unavailable', error: 'The database did not confirm that the change was sent to BRAVO, so it was withdrawn; nothing was saved. Try again in a moment.' });
    const settle = rig.statements.find(isSettleInsert)!;
    const insert = rig.statements.find(isInsert)!;
    expect(settle.values).toEqual(insert.values.slice(0, 8));
  });

  it('ruling 2 (DL1): a settle that returns the row from another server instance behind the URL answers can\'t confirm', async () => {
    rig.server[URL1] = 'primary';
    at(sql => {
      if (isInsert({ sql } as any)) {
        rig.server[URL1] = 'promoted standby';
        return pgError('08006');
      }
      return isSettleInsert({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined;
    });
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', servedBy: 'BRAVO' });
    expect(String(value.error ?? '')).not.toMatch(/nothing was/);
    expect(rig.statements.filter(isSettleInsert)).toHaveLength(1);
  });

  it('ruling 2 (RS-2): a settle whose answer was lost, then a retry that finds no pending row, then the row expired: withdrawn, never not-taken', async () => {
    let settles = 0;
    at(sql => {
      if (isInsert({ sql } as any)) return pgError('08006');
      if (isSettleInsert({ sql } as any)) return ++settles === 1 ? new Error('Connection terminated unexpectedly') : { rows: [] };
      return poll('expired');
    });
    const { done } = await send();
    const { value } = await done(10_000);
    expect(value).toMatchObject({ ok: false, code: 'backend-unavailable', error: 'The database did not confirm that the change was sent to BRAVO, so it was withdrawn; nothing was saved. Try again in a moment.' });
    expect(settles).toBe(2);
  });

  it('ruling 2: the expired row read on another server instance than the insert\'s answers can\'t confirm', async () => {
    rig.server[URL1] = 'primary';
    let settles = 0;
    at(sql => {
      if (isInsert({ sql } as any)) return pgError('08006');
      if (isSettleInsert({ sql } as any)) {
        settles += 1;
        if (settles === 1) return new Error('Connection terminated unexpectedly');
        rig.server[URL1] = 'promoted standby';
        return { rows: [] };
      }
      return poll('expired');
    });
    const { done } = await send();
    const { value } = await done(10_000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', servedBy: 'BRAVO' });
    expect(String(value.error ?? '')).not.toMatch(/nothing was/);
  });

  it('an insert with no answer, a settle that returns nothing, then done: the reply', async () => {
    at(sql => (isInsert({ sql } as any) ? HANG : isSettleInsert({ sql } as any) ? { rows: [] } : poll('done', { reply: '{"ok":true,"pending":true}' })));
    const { done } = await send();
    const { value } = await done(10_000);
    expect(value).toMatchObject({ ok: true, pending: true, servedBy: 'BRAVO' });
  });
});

describe('the follow', () => {
  const acked = (after: (sql: string) => unknown) => at(sql => (isInsert({ sql } as any) ? { rows: [], rowCount: 1 } : after(sql)));

  it('pickup over, then the UPDATE-form settle\'s row: not-taken', async () => {
    acked(sql => (isPoll({ sql } as any) ? poll('pending', { pickup_over: true }) : isSettleUpdate({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined));
    const { done } = await send('delete', { guildId: GUILD, module: 'm', filename: 'a.json' });
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'not-taken', error: 'BRAVO did not take the change within 5 s; nothing was deleted. Try again in a moment; if it keeps happening, check the bot on BRAVO.' });
    expect(rig.statements.filter(isSettleInsert)).toHaveLength(0);
  });

  it('applying past answer_by + 5 s: can\'t confirm, timeout', async () => {
    acked(sql => (isPoll({ sql } as any) ? poll('applying', { answer_over: true }) : undefined));
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'timeout', servedBy: 'BRAVO' });
  });

  it('applying at T minus 5 s, before answer_over: timeout, never lost', async () => {
    acked(sql => (isPoll({ sql } as any) ? poll('applying') : undefined));
    const { done } = await send();
    const { value, at: when } = await done(120_000);
    expect(value).toMatchObject({ noAnswer: 'timeout' });
    expect(when).toBeLessThanOrEqual(60_000);
    expect(when).toBeGreaterThanOrEqual(54_000);
  });

  it('pending at T minus 5 s: one settle', async () => {
    acked(sql => (isPoll({ sql } as any) ? poll('pending') : isSettleUpdate({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined));
    const { done } = await send();
    const { value } = await done(120_000);
    expect(value).toMatchObject({ code: 'not-taken' });
    expect(rig.statements.filter(isSettleUpdate)).toHaveLength(1);
  });

  it('polls failing to T minus 5 s, then a settle that fails: can\'t confirm, lost', async () => {
    acked(sql => (isPoll({ sql } as any) ? new Error('Connection terminated unexpectedly') : isSettleUpdate({ sql } as any) ? new Error('Connection terminated unexpectedly') : undefined));
    const { done } = await send();
    const { value, at: when } = await done(120_000);
    expect(value).toMatchObject({ code: 'no-answer', noAnswer: 'lost' });
    expect(when).toBeLessThanOrEqual(60_000);
    expect(rig.statements.filter(isSettleUpdate).length).toBeGreaterThanOrEqual(1);
  });

  it('no row after an acknowledged insert: can\'t confirm, lost, with no settle', async () => {
    acked(sql => (isPoll({ sql } as any) ? { rows: [] } : undefined));
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ code: 'no-answer', noAnswer: 'lost' });
    expect(rig.statements.filter(s => isSettleInsert(s) || isSettleUpdate(s))).toHaveLength(0);
  });

  it('each poll is bounded at 2 s', async () => {
    acked(sql => (isPoll({ sql } as any) ? poll('done', { reply: '{"ok":true}' }) : undefined));
    const { done } = await send();
    await done(1000);
    expect(rig.statements.find(isPoll)!.boundMs).toBe(2000);
  });

  it.each([
    ['write', 60_000],
    ['delete', 60_000],
    ['delete-namespace', 90_000],
    ['restore-graveyard', 90_000],
  ] as const)('%s answers by T (%d ms) whatever the database does', async (op, t) => {
    at(() => HANG);
    const { done } = await send(op, op === 'write' ? writeOf() : { guildId: GUILD, module: '', filename: '' });
    const { value, at: when } = await done(200_000);
    expect(value).toBeDefined();
    expect(when).toBeLessThanOrEqual(t);
  });
});

describe('the holder\'s reply from a done row (decision 9)', () => {
  function hop(reply: any) {
    const out: { status?: number; body?: any } = {};
    sendHopReply({ status(code: number) { out.status = code; return this; }, json(body: any) { out.body = body; return this; } } as any, reply);
    return out;
  }
  const doneWith = (reply: string) => at(sql => (isInsert({ sql } as any) ? { rows: [], rowCount: 1 } : isPoll({ sql } as any) ? poll('done', { reply }) : undefined));

  it('not-held: the bot stopped serving, nothing was saved, 503 not-taken', async () => {
    doneWith('{"ok":false,"code":"not-held"}');
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.stoppedServing('BRAVO', 'saved'), servedBy: 'BRAVO' });
    expect(hop(value)).toEqual({ status: 503, body: { success: false, code: 'not-taken', error: 'On BRAVO: the bot stopped serving this server before it applied the change; nothing was saved. Try again in a moment.', servedBy: 'BRAVO' } });
  });

  it('the unapplied answer: did not apply, nothing was saved, 503 not-taken', async () => {
    doneWith(UNAPPLIED_REPLY);
    const { done } = await send('delete', { guildId: GUILD, module: 'm', filename: 'a.json' });
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.unapplied('BRAVO', 'deleted') });
    expect(hop(value)).toEqual({ status: 503, body: { success: false, code: 'not-taken', error: 'BRAVO did not apply the change; nothing was deleted. Try again in a moment.', servedBy: 'BRAVO' } });
  });

  it('a twin that changed: 409 with the holder\'s changed text', async () => {
    doneWith('{"ok":false,"code":"changed","which":"twin","error":"This file changed while the save was being made; nothing was saved. Reload it to see the current values."}');
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'changed', which: 'twin', error: 'This file changed while the save was being made; nothing was saved. Reload it to see the current values.', servedBy: 'BRAVO' });
    const out = hop(value);
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('On BRAVO: This file changed while the save was being made; nothing was saved. Reload it to see the current values.');
  });

  it('a target that changed: 409 with the reload text on the holder\'s name', async () => {
    doneWith('{"ok":false,"code":"changed","which":"target","error":"This file changed while the save was being made; nothing was saved. Reload it to see the current values."}');
    const { done } = await send();
    const { value } = await done(2000);
    expect(hop(value)).toEqual({ status: 409, body: { success: false, error: 'On BRAVO: This file changed while the save was being made; nothing was saved. Reload it to see the current values.', servedBy: 'BRAVO' } });
  });

  it('a reply that is not JSON: can\'t confirm, lost', async () => {
    doneWith('not json');
    const { done } = await send();
    const { value } = await done(2000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'lost', servedBy: 'BRAVO' });
  });
});

describe('the deadline and the rules', () => {
  it('a plan that leaves less than the span plus 15 s sends no insert', async () => {
    const plan = await requestPlan('write');
    vi.advanceTimersByTime(60_000 - 34_000);
    const reply = await sendGuildChange(fakeBot().bot, plan, writeOf());
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: 'The database answered too slowly to send this change to BRAVO in time; nothing was saved. Try again in a moment.' });
    expect(rig.statements).toHaveLength(0);
  });

  it('NB12\'s rules refuse a write before any statement', async () => {
    const plan = await requestPlan('write');
    const reply = await sendGuildChange(fakeBot().bot, plan, writeOf({ contentJson: `{"a":"${String.fromCharCode(0)}"}` }));
    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect(String(reply.error)).toMatch(/^The data was not saved: /);
    expect(rig.statements).toHaveLength(0);
    expect(rig.connects).toHaveLength(0);
  });
});

describe('the pinned URL', () => {
  it('a reader URL change during the follow keeps the insert\'s pool; the old pool ends after the request', async () => {
    let polls = 0;
    at(sql => {
      if (isInsert({ sql } as any)) return { rows: [], rowCount: 1 };
      if (isPoll({ sql } as any) && ++polls < 3) return poll('applying');
      return poll('done', { reply: '{"ok":true}' });
    });
    const { done } = await send();
    await vi.advanceTimersByTimeAsync(100);
    rig.url = 'postgres://two';
    const { value } = await done(5000);
    expect(value).toMatchObject({ ok: true });
    expect(rig.statements.every(s => s.url === URL1)).toBe(true);
    expect(rig.ended).toEqual([URL1]);
  });
});

describe('the web UI\'s exit', () => {
  it('an exit during the holder check sends no insert and answers NB10\'s shutting-down text', async () => {
    let release!: () => void;
    rig.holder = () => new Promise(resolve => { release = () => resolve({ rows: [{ n: 2, shard: 1, holder_process: 'p-b', holder_node: 'n-b', holder_name: 'BRAVO', claim: '4', released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000', renewed_ago_ms: 1, up_ms: '1000', node_process_id: 'p-b', node_takeover_seconds: 30, node_seen_ago_ms: 1 }] }); });
    const planned = requestPlan('write');
    await vi.advanceTimersByTimeAsync(10);
    await endGuildRequests();
    release();
    const plan = await planned;
    const reply = await sendGuildChange(fakeBot().bot, plan, writeOf());
    expect(reply).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
    expect(rig.statements.filter(isInsert)).toHaveLength(0);
  });

  it('an exit while the insert is on the wire settles it with the insert form; one settle and one log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    at(sql => (isInsert({ sql } as any) ? HANG : isSettleInsert({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined));
    const { done } = await send();
    await vi.advanceTimersByTimeAsync(100);
    await endGuildRequests();
    await done(10_000);
    expect(rig.statements.filter(isSettleInsert)).toHaveLength(1);
    expect(log.mock.calls.filter(c => String(c[0]).startsWith('[Main] Exiting'))).toEqual([[`[Main] Exiting: withdrew the write of server ${GUILD} sent to BRAVO; nothing was saved`]]);
  });

  it('an exit while the row applies logs can\'t confirm', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    at(sql => (isInsert({ sql } as any) ? { rows: [], rowCount: 1 } : isPoll({ sql } as any) ? poll('applying') : { rows: [] }));
    const { done } = await send();
    await vi.advanceTimersByTimeAsync(600);
    await endGuildRequests();
    await done(1000);
    expect(error).toHaveBeenCalledWith(`[Main] Exiting while BRAVO applies the write of server ${GUILD}; can't confirm whether it was saved`);
  });
});
