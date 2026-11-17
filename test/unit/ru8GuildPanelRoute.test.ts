import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NB7_TEXTS,
  PANEL_TEXTS,
  actorFor,
  planGuildRequest,
  remotePanelAnswer,
  runGuildRequest,
  sendMembership,
  type Outcome,
  type RemoteHolder,
} from '../../src/webui/utils/guildRequests';
import { MAX_BODY_BYTES } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { REQUEST_INSERT_SQL, changeDeadlineMs } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { BOT_DOWN, GUILD, fakeBot, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const owner = (reply: Record<string, any>, op: Parameters<typeof remotePanelAnswer>[0] = 'panel:execute') =>
  remotePanelAnswer(op, { k: 'reply', reply } as Outcome, 'owner', 'BRAVO');

describe('ru8 a holder reply worded for the owner', () => {
  it('a not-taken reply that is not marked unapplied keeps its own text', () => {
    const answer = owner({ success: false, code: 'not-taken', error: 'Queue Full' });
    expect(answer.status).toBeNull();
    expect(answer.reply.error).toBe('On BRAVO: Queue Full');
  });

  it('an empty error text is replaced by the sheet words for a refusal', () => {
    const answer = owner({ success: false, ran: false, error: '' });
    expect(answer.reply.error).toBe('On BRAVO: the bot refused the request; nothing was run.');
  });

  it("a module's text with a truth but ran false keeps its case", () => {
    expect(owner({ success: false, ran: false, truth: 'unsaved', error: 'Module Error' }).reply.error).toBe('On BRAVO: Module Error');
  });

  it("a module's text that ran with no truth keeps its case", () => {
    expect(owner({ success: false, ran: true, error: 'Module Error' }).reply.error).toBe('On BRAVO: Module Error');
  });
});

describe('ru8 a command answer with captured replies left out', () => {
  const omitted = { count: 1, bytes: 10 };

  it('a failed command names the holder before its text and keeps the note', () => {
    const answer = owner({ success: false, error: 'Boom', capturedOmitted: omitted }, 'command:invoke');
    expect(answer.status).toBeNull();
    expect(answer.reply.error).toBe('On BRAVO: Boom');
    expect(answer.reply.note).toBe(PANEL_TEXTS.capturedOmitted('BRAVO', omitted));
    expect(answer.reply.servedBy).toBe('BRAVO');
  });

  it('a command that succeeded gets no error text', () => {
    const answer = owner({ success: true, capturedOmitted: omitted }, 'command:invoke');
    expect(answer.reply.success).toBe(true);
    expect(answer.reply.error).toBeUndefined();
    expect(answer.reply.note).toBe(PANEL_TEXTS.capturedOmitted('BRAVO', omitted));
  });
});

describe('ru8 the actor of a request', () => {
  it('an owner with no user id is sent as web-ui-owner', () => {
    expect(actorFor('owner', null)).toEqual({ via: 'owner', userId: 'web-ui-owner' });
    expect(actorFor('owner', '')).toEqual({ via: 'owner', userId: 'web-ui-owner' });
  });
});

describe('ru8 the plan of a panel request', () => {
  let rig: Rig;
  beforeEach(() => { rig = nb7Rig(); });
  afterEach(() => { resetNb7(); });

  it('an invalid guild id answers 400 with the invalid code and asks nothing', async () => {
    const plan = await planGuildRequest(fakeBot().bot, 'x1', 'panel:execute', 'owner');
    expect(plan.kind).toBe('refuse');
    expect(plan.answer).toEqual({ status: 400, reply: { success: false, code: 'invalid', error: 'Invalid guild ID format' } });
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('the plan takes the local route only on the Postgres guild route', async () => {
    const bot = { writerRoute: (_scope: string, opts?: { postgresGuild?: boolean }) => (opts?.postgresGuild === true ? { route: 'child' } : BOT_DOWN) } as any;
    const plan = await planGuildRequest(bot, GUILD, 'panel:execute', 'owner');
    expect(plan.kind).toBe('local');
    expect(rig.holderCalls).toHaveLength(0);
  });

  it("a route refused with the exit's code and words answers shutting down without a holder check", async () => {
    const route = { ok: false, status: 503, code: 'stopping', error: ROUTE_TEXT.exiting };
    const plan = await planGuildRequest(fakeBot({ route }).bot, GUILD, 'panel:execute', 'owner');
    expect(plan.kind).toBe('refuse');
    expect(plan.answer).toEqual({ status: 503, reply: { success: false, code: 'stopping', error: PANEL_TEXTS.shuttingDown('panel:execute') } });
    expect(rig.holderCalls).toHaveLength(0);
  });

  it("the exit's words under another code still run the holder check", async () => {
    const route = { ok: false, status: 503, code: 'bot-down', error: ROUTE_TEXT.exiting };
    const plan = await planGuildRequest(fakeBot({ route }).bot, GUILD, 'panel:execute', 'owner');
    expect(plan.kind).toBe('request');
    expect(rig.holderCalls).toHaveLength(1);
  });

  it('a holder check that fails gives the owner its cause and the member the plain text', async () => {
    rig.holder = () => new Error('connect ECONNREFUSED');
    const ownerPlan = await planGuildRequest(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'panel:execute', 'owner');
    expect(ownerPlan.answer?.reply).toEqual({ success: false, code: 'backend-unavailable', error: NB7_TEXTS.lookupUnreachable('connect ECONNREFUSED', 'run') });
    const memberPlan = await planGuildRequest(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'panel:execute', 'member');
    expect(memberPlan.answer?.reply).toEqual({ success: false, code: 'backend-unavailable', error: PANEL_TEXTS.unreachableMember });
  });
});

describe('ru8 the size of a request body', () => {
  let rig: Rig;
  beforeEach(() => { rig = nb7Rig(); });
  afterEach(() => { resetNb7(); });

  const padFor = (bytes: number) => {
    const base = Buffer.byteLength(JSON.stringify({ pad: '', guildId: GUILD }), 'utf8');
    return 'a'.repeat(bytes - base);
  };

  it('a body of exactly 16 KiB is sent', async () => {
    rig.connectFails[rig.url] = new Error('connect ECONNREFUSED');
    const plan = await planGuildRequest(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'panel:execute', 'owner');
    expect(plan.kind).toBe('request');
    const answer = await runGuildRequest(plan, { pad: padFor(MAX_BODY_BYTES) }, async () => ({}));
    expect(answer.status).toBe(503);
    expect(answer.reply.code).toBe('backend-unavailable');
    expect(rig.connects).toHaveLength(1);
  });

  it('a body one byte over 16 KiB is refused unsent with success false', async () => {
    const plan = await planGuildRequest(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'panel:execute', 'owner');
    const answer = await runGuildRequest(plan, { pad: padFor(MAX_BODY_BYTES + 1) }, async () => ({}));
    expect(answer).toEqual({ status: 400, reply: { success: false, code: 'invalid', error: PANEL_TEXTS.tooLarge(MAX_BODY_BYTES + 1) } });
    expect(rig.connects).toHaveLength(0);
  });
});

describe('ru8 the membership row', () => {
  let rig: Rig;
  beforeEach(() => { rig = nb7Rig(); });
  afterEach(() => { resetNb7(); });

  it('carries the ids, the first id as its guild and the member as its actor', async () => {
    const holder: RemoteHolder = { shardCount: 2, shardId: 1, processId: 'p-b', name: 'BRAVO', url: rig.url };
    const ids = [GUILD, String(3n << 22n)];
    await sendMembership(holder, ids, 'user-7', performance.now() + changeDeadlineMs('guild:membership'));
    const insert = rig.statements.find(s => s.sql === REQUEST_INSERT_SQL);
    expect(insert).toBeDefined();
    expect(insert!.values[1]).toBe(GUILD);
    expect(JSON.parse(String(insert!.values[6]))).toEqual({ ids, guildId: GUILD, actor: { via: 'member', userId: 'user-7' } });
  });
});
