import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NB7_TEXTS,
  _setGuildRequestDeps,
  inGuildIdRange,
  planGuildChange,
  remoteRestoreNoAnswerCause,
  runHolderCheck,
  sendGuildChange,
  switchOnNotHeld,
  type Plan,
} from '../../src/webui/utils/guildRequests';
import { MAX_GUILD_ID, REQUEST_INSERT_SQL, REQUEST_POLL_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { BOT_DOWN, GUILD, fakeBot, heldRow, nb7Rig, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });

let rig: Rig;
beforeEach(() => { rig = nb7Rig(); });
afterEach(() => {
  resetNb7();
  vi.restoreAllMocks();
});

describe("the restore's can't confirm cause", () => {
  it('names each cause in its own words', () => {
    expect(remoteRestoreNoAnswerCause('timeout', 'BRAVO')).toBe('BRAVO did not answer in time');
    expect(remoteRestoreNoAnswerCause('lost', 'BRAVO')).toBe('the answer from BRAVO could not be read from the database');
    expect(remoteRestoreNoAnswerCause('stopped', 'BRAVO')).toBe('this web panel shut down before it read the answer from BRAVO');
    expect(remoteRestoreNoAnswerCause('unsettled', 'BRAVO')).toBe('the database could not show that the restore sent to BRAVO was withdrawn before BRAVO took it');
  });
});

describe('the guild id range', () => {
  it('refuses an id with text before or after its digits, and takes the largest bigint', async () => {
    expect(inGuildIdRange('x1')).toBe(false);
    expect(inGuildIdRange('1x')).toBe(false);
    expect(inGuildIdRange(String(MAX_GUILD_ID))).toBe(true);
    expect(inGuildIdRange(String(MAX_GUILD_ID + 1n))).toBe(false);
  });

  it.each(['x1', '1x'])('a plan for %s answers 400 with ok false and asks nothing', async id => {
    const plan = await planGuildChange(fakeBot().bot, id, 'write');
    expect(plan.kind).toBe('refuse');
    expect(plan.reply).toEqual({ ok: false, code: 'invalid', error: 'Invalid guild ID format' });
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('the largest bigint id is planned like any other', async () => {
    expect((await planGuildChange(fakeBot().bot, String(MAX_GUILD_ID), 'write')).kind).toBe('local');
  });
});

describe('the route the plan asks for', () => {
  it('asks the bot manager for the Postgres guild route', async () => {
    const asked: unknown[][] = [];
    const bot = { writerRoute: (...args: unknown[]) => { asked.push(args); return { route: 'child' }; } } as any;
    await planGuildChange(bot, GUILD, 'write');
    expect(asked).toEqual([['guild', { postgresGuild: true }]]);
  });

  it("a refusal in the exit's words but with another code still runs the holder check", async () => {
    const route = { ok: false, status: 503, code: 'bot-down', error: ROUTE_TEXT.exiting };
    const plan = await planGuildChange(fakeBot({ route }).bot, GUILD, 'write');
    expect(plan.kind).toBe('request');
    expect(rig.holderCalls).toHaveLength(1);
  });

  it("a route other than the child's, on a server this machine holds, answers that the bot is down", async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
    const plan = await planGuildChange(fakeBot({ route: { route: 'local' } }).bot, GUILD, 'write');
    expect(plan.kind).toBe('refuse');
    expect(plan.reply).toEqual({ ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' });
  });
});

describe('the holder check', () => {
  it('with no deadline given, waits up to 10 s for the holder', async () => {
    await runHolderCheck(GUILD);
    expect(rig.holderCalls).toHaveLength(1);
    expect(rig.holderCalls[0].boundMs).toBeGreaterThan(9000);
    expect(rig.holderCalls[0].boundMs).toBeLessThanOrEqual(10_000);
  });

  it('waits only for the time left to the deadline', async () => {
    await runHolderCheck(GUILD, performance.now() + 5000);
    await runHolderCheck(GUILD, performance.now() + 3000);
    expect(rig.holderCalls[0].boundMs).toBeGreaterThan(4000);
    expect(rig.holderCalls[0].boundMs).toBeLessThanOrEqual(5000);
    expect(rig.holderCalls[1].boundMs).toBeGreaterThan(2000);
    expect(rig.holderCalls[1].boundMs).toBeLessThanOrEqual(3000);
  });

  it('with no database and no refusal, names "no database" to the operator', async () => {
    _setGuildRequestDeps({ currentUrl: () => null, currentRefusal: () => null });
    const check = await runHolderCheck(GUILD);
    expect(check.kind).toBe('failed');
    expect((check as { error: Error }).error.message).toBe('no database');
    const plan: Plan = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    await switchOnNotHeld(plan, GUILD);
    expect(plan.reply).toEqual({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.lookupUnreachable('no database', 'saved'), sender: true });
  });

  it('a this-machine id that is null is not a row with no node', async () => {
    rig.nodeId = null;
    rig.holder = () => ({ rows: [heldRow({ holder_node: null })] });
    const check = await runHolderCheck(GUILD);
    expect(check).toMatchObject({ kind: 'held', thisNode: false });
  });
});

describe("the sender's own refusals carry sender true", () => {
  const notHeld = () => fakeBot({ write: () => ({ ok: false, code: 'not-held' }) });

  it('a check that finds no holder', async () => {
    rig.holder = () => ({ rows: [heldRow({ released: true })] });
    const plan = await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'write');
    expect(plan.reply).toMatchObject({ ok: false, code: 'no-holder', sender: true });
  });

  it.each([
    ['28000', () => pgError('28000'), 'maintenance'],
    ['another SQLSTATE', () => pgError('42501', 'permission denied'), 'backend-unavailable'],
    ['a connect failure', () => new Error('connect ECONNREFUSED'), 'backend-unavailable'],
  ])('a check that fails (%s)', async (_what, answer, code) => {
    rig.holder = answer;
    const { bot } = notHeld();
    const reply = await sendGuildChange(bot, await planGuildChange(bot, GUILD, 'write'), writeOf());
    expect(reply).toMatchObject({ ok: false, code, sender: true });
    expect(rig.statements).toHaveLength(0);
  });
});

describe('the local route', () => {
  it("a child that answers nothing: the send answers nothing, never a crash", async () => {
    const { bot, writes } = fakeBot({ write: () => undefined });
    const plan = await planGuildChange(bot, GUILD, 'write');
    expect(plan.kind).toBe('local');
    await expect(sendGuildChange(bot, plan, writeOf())).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(rig.holderCalls).toHaveLength(0);
  });
});

describe('the request pool of a database the web UI no longer uses', () => {
  it('stays open while another request still uses it, and ends after the last', async () => {
    const OTHER = 'postgres://two';
    const GUILD_B = String(3n << 22n);
    const guildOf = new Map<string, unknown>();
    let holdB = true;
    rig.holder = () => ({ rows: [heldRow()], url: OTHER });
    rig.script[OTHER] = (sql, values) => {
      if (sql === REQUEST_INSERT_SQL) {
        guildOf.set(String(values[0]), values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql === REQUEST_POLL_SQL) {
        if (guildOf.get(String(values[0])) === GUILD_B && holdB) return { rows: [{ state: 'pending', pickup_over: false, answer_over: false }] };
        return { rows: [{ state: 'done', reply: '{"ok":true}', pickup_over: false, answer_over: false }] };
      }
      return undefined;
    };
    const { bot } = fakeBot({ route: BOT_DOWN });
    const planA = await planGuildChange(bot, GUILD, 'write');
    const planB = await planGuildChange(bot, GUILD_B, 'write');
    expect([planA.kind, planB.kind]).toEqual(['request', 'request']);
    const sentA = sendGuildChange(bot, planA, writeOf());
    const sentB = sendGuildChange(bot, planB, writeOf({ guildId: GUILD_B }));
    expect(await sentA).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(rig.ended).toEqual([]);
    holdB = false;
    expect(await sentB).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(rig.ended).toEqual([OTHER]);
  });
});
