import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NB7_TEXTS, planGuildChange, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { readServedGuild } from '../../src/webui/utils/servedRead';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { setBackendKind } from '../helpers/backendKind';
import { BOT_DOWN, fakeBot, GUILD, heldRow, isInsert, nb7Rig, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

// NB7 decision 3 and 4: the plan decides a change's route once, before its read; a not-held reply from the local
// route runs the holder check; every refusal of the check comes before anything is sent.

const STARTING = { ok: false, status: 503, code: 'starting', error: ROUTE_TEXT.starting };
const STOPPING = { ok: false, status: 503, code: 'stopping', error: ROUTE_TEXT.stopping };
const EXITING = { ok: false, status: 503, code: 'stopping', error: ROUTE_TEXT.exiting };
const HELD_ELSEWHERE = { ok: false, status: 503, code: 'held-elsewhere', error: 'Another process holds the data files; nothing was saved.' };
const pgError = (code: string, message = 'refused') => Object.assign(new Error(message), { code });

const SHARD = 'shard 1 of 2';
const STATES: Array<[string, () => unknown, string]> = [
  ['no shard count', () => ({ rows: [] }), "No machine has taken this bot's shards on this database yet; nothing was saved. Start the bot, then try again."],
  ['no claim row', () => ({ rows: [heldRow({ holder_process: null, holder_node: null, holder_name: null, claim: null, released: null, reserved: null, ttl_ms: null, expires_up_ms: null, renewed_ago_ms: null, node_process_id: null, node_takeover_seconds: null, node_seen_ago_ms: null })] }), `No machine runs this server's shard (${SHARD}) right now; nothing was saved. Try again once a machine has taken it; the Usage tab's Claims table on a machine whose bot runs shows who holds each shard.`],
  ['expired', () => ({ rows: [heldRow({ expires_up_ms: '100' })] }), `No machine runs this server's shard (${SHARD}) right now; nothing was saved. Try again once a machine has taken it; the Usage tab's Claims table on a machine whose bot runs shows who holds each shard.`],
  ['expired-deferred', () => ({ rows: [heldRow({ expires_up_ms: '100', node_process_id: 'p-b2' })] }), `This server's shard (${SHARD}) waits for BRAVO to restart; nothing was saved. Try again once BRAVO runs it.`],
  ['kept', () => ({ rows: [heldRow({ released: true })] }), `This server's shard (${SHARD}) is kept for BRAVO while its bot restarts; nothing was saved. Try again once BRAVO runs it.`],
  ['reserved', () => ({ rows: [heldRow({ released: true, reserved: true })] }), `BRAVO is restarting to take this server's shard (${SHARD}); nothing was saved. Try again in a moment.`],
];
const FAILURES: Array<[string, () => unknown, Record<string, unknown>]> = [
  ['28000', () => pgError('28000'), { code: 'maintenance' }],
  ['another SQLSTATE', () => pgError('42501', 'permission denied'), { code: 'backend-unavailable', error: 'The database refused the lookup of the machine that runs this server (SQLSTATE 42501: permission denied); nothing was saved.' }],
  ['a connect failure', () => new Error('connect ECONNREFUSED'), { code: 'backend-unavailable', error: "Can't get an answer from the database to find the machine that runs this server (connect ECONNREFUSED); nothing was saved. Try again in a moment." }],
  ['the hand-out timing out', () => new Error('every connection of the web UI\'s reader pool was in use for 5 s'), { code: 'backend-unavailable', error: "Can't get an answer from the database to find the machine that runs this server (every connection of the web UI's reader pool was in use for 5 s); nothing was saved. Try again in a moment." }],
];

let rig: Rig;
beforeEach(() => { rig = nb7Rig(); });
afterEach(() => {
  resetNb7();
  vi.restoreAllMocks();
});

describe('the plan', () => {
  it('a JSON bot keeps NB10\'s route: no holder check, no table', async () => {
    setBackendKind('file');
    const { bot } = fakeBot({ route: BOT_DOWN });
    expect((await planGuildChange(bot, GUILD, 'write')).kind).toBe('json');
    expect(rig.holderCalls).toHaveLength(0);
  });

  it.each(['write', 'delete', 'delete-namespace', 'restore-graveyard'] as const)('a guild id above the bigint range answers 400 for %s, nothing sent', async op => {
    const plan = await planGuildChange(fakeBot().bot, '9223372036854775808', op);
    expect(plan).toMatchObject({ kind: 'refuse', reply: { code: 'invalid', error: 'Invalid guild ID format' } });
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('the web UI exiting: NB10\'s refusal, no holder check', async () => {
    const plan = await planGuildChange(fakeBot({ route: EXITING }).bot, GUILD, 'write');
    expect(plan).toMatchObject({ kind: 'refuse', reply: EXITING });
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('a child that serves guilds: plan local, no holder check', async () => {
    expect((await planGuildChange(fakeBot().bot, GUILD, 'write')).kind).toBe('local');
    expect(rig.holderCalls).toHaveLength(0);
  });

  describe.each([
    ['bot-down', BOT_DOWN],
    ['starting', STARTING],
    ['stopping', STOPPING],
    ['held-elsewhere', HELD_ELSEWHERE],
  ])('NB10 refused (%s): the holder check decides', (_what, route) => {
    it('a row held by another node: plan request, carrying the check\'s answer', async () => {
      const plan = await planGuildChange(fakeBot({ route }).bot, GUILD, 'write');
      expect(plan).toMatchObject({ kind: 'request', holder: { shardCount: 2, shardId: 1, processId: 'p-b', name: 'BRAVO', url: 'postgres://one' } });
      expect(rig.holderCalls[0].boundMs).toBeLessThanOrEqual(10_000);
    });

    it('a row held by this node: NB10\'s refusal', async () => {
      rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
      expect(await planGuildChange(fakeBot({ route }).bot, GUILD, 'write')).toMatchObject({ kind: 'refuse', reply: route });
    });

    it.each(STATES)('%s: the check\'s refusal, 503 no-holder', async (_s, answer, text) => {
      rig.holder = answer;
      expect(await planGuildChange(fakeBot({ route }).bot, GUILD, 'write')).toMatchObject({ kind: 'refuse', reply: { ok: false, code: 'no-holder', error: text } });
    });

    it.each(FAILURES)('a check that fails (%s): NB10\'s refusal, as before', async (_s, answer) => {
      rig.holder = answer;
      expect(await planGuildChange(fakeBot({ route }).bot, GUILD, 'write')).toMatchObject({ kind: 'refuse', reply: route });
    });
  });

  it('a this-machine id that is null matches no row', async () => {
    rig.nodeId = null;
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a' })] });
    expect((await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'write')).kind).toBe('request');
  });
});

describe('the local route answering not-held', () => {
  const notHeld = () => fakeBot({ write: () => ({ ok: false, code: 'not-held' }) });

  it('goes to the request route even when the row names this node', async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA', holder_process: 'p-old' })] });
    rig.script['postgres://one'] = sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n') ? { rows: [], rowCount: 1 } : { rows: [{ state: 'done', reply: '{"ok":true}', pickup_over: false, answer_over: false }] });
    const { bot, writes } = notHeld();
    const plan = await planGuildChange(bot, GUILD, 'write');
    const reply = await sendGuildChange(bot, plan, writeOf());
    expect(writes).toHaveLength(1);
    expect(rig.statements.find(isInsert)!.values[4]).toBe('p-old');
    expect(reply).toMatchObject({ ok: true, servedBy: 'ALPHA' });
  });

  it.each(STATES)('%s: the check\'s refusal', async (_s, answer, text) => {
    rig.holder = answer;
    const { bot } = notHeld();
    const reply = await sendGuildChange(bot, await planGuildChange(bot, GUILD, 'write'), writeOf());
    expect(reply).toMatchObject({ ok: false, code: 'no-holder', error: text });
    expect(rig.statements).toHaveLength(0);
  });

  it.each(FAILURES)('a check that fails (%s) answers its own text; a SQLSTATE never reads as unreachable', async (_s, answer, expected) => {
    rig.holder = answer;
    const { bot } = notHeld();
    const reply = await sendGuildChange(bot, await planGuildChange(bot, GUILD, 'write'), writeOf());
    expect(reply).toMatchObject({ ok: false, ...expected });
    if (_s !== 'a connect failure' && _s !== 'the hand-out timing out') expect(String(reply.error ?? '')).not.toMatch(/Can't get an answer/);
    expect(rig.statements).toHaveLength(0);
  });

  describe('on the read (decision 3: a not-held reply to the read or the send)', () => {
    const target = { guildId: GUILD, module: 'm', filename: 'a.json', path: '/data/x/m/a.json' };
    const notHeldRead = () => fakeBot({ read: () => ({ ok: false, code: 'not-held' }) });

    it('the plan becomes the request: the read comes from the database, and the send inserts once with nothing sent to the child', async () => {
      rig.docs.set(`${GUILD}/m/a.json`, '{"a":1}');
      rig.script['postgres://one'] = sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n') ? { rows: [], rowCount: 1 } : { rows: [{ state: 'done', reply: '{"ok":true}', pickup_over: false, answer_over: false }] });
      const { bot, reads, writes } = notHeldRead();
      const plan = await planGuildChange(bot, GUILD, 'write');
      expect(plan.kind).toBe('local');
      const read = await readServedGuild(bot, target, { plan });
      expect(plan).toMatchObject({ kind: 'request', holder: { name: 'BRAVO', processId: 'p-b' } });
      expect(read).toEqual({ ok: true, content: '{"a":1}', notice: NB7_TEXTS.heldNotice('BRAVO') });
      expect(reads).toHaveLength(1);
      const reply = await sendGuildChange(bot, plan, writeOf());
      expect(writes).toHaveLength(0);
      expect(rig.statements.filter(isInsert)).toHaveLength(1);
      expect(rig.holderCalls).toHaveLength(1);
      expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    });

    it('no holder: the read fails with the no-holder text and nothing is read from the database or inserted', async () => {
      rig.holder = STATES[2][1];
      const { bot, writes } = notHeldRead();
      const plan = await planGuildChange(bot, GUILD, 'write');
      const read = await readServedGuild(bot, target, { plan });
      expect(read).toMatchObject({ ok: false, status: 503, error: STATES[2][2] });
      expect(plan.kind).toBe('refuse');
      const reply = await sendGuildChange(bot, plan, writeOf());
      expect(reply).toMatchObject({ ok: false, code: 'no-holder', error: STATES[2][2] });
      expect(rig.readDocCalls).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(rig.statements).toHaveLength(0);
    });
  });

  it('any other reply of the local route is the answer, with no holder check', async () => {
    const { bot } = fakeBot({ write: () => ({ ok: false, code: 'frozen' }) });
    const reply = await sendGuildChange(bot, await planGuildChange(bot, GUILD, 'write'), writeOf());
    expect(reply).toEqual({ ok: false, code: 'frozen' });
    expect(rig.holderCalls).toHaveLength(0);
  });
});
