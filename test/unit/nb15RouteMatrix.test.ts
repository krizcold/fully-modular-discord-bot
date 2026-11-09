import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 2's matrix (decision 9): child stage x holder check x the insert client's class, and the child's answer at
// its guild report x holder check, each over every op and the three audiences (owner route, member route, CLI). For
// each: which path ran (IPC or insert), whether the holder check ran, the status, the code and that no refusal before
// a send says can't confirm.
import { planGuildRequest, runGuildRequest } from '../../src/webui/utils/guildRequests';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PANEL_REQUEST_OPS, isReadOp } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { setBackendKind } from '../helpers/backendKind';
import { BOT_DOWN, GUILD, fakeTime, heldRow, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
let rig: Rig;

const STAGES: Array<[string, any]> = [
  ['none', BOT_DOWN],
  ['starting', { ok: false, status: 503, code: 'starting', error: 'The bot is starting; nothing was run. Try again in a moment.' }],
  ['waiting', { ok: false, status: 503, code: 'waiting', error: 'The bot is waiting for its data files; nothing was run.' }],
  ['stopping', { ok: false, status: 503, code: 'stopping', error: 'The bot is stopping; nothing was run.' }],
  ['guild', { route: 'child' }],
];
const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'FATAL' });
/** Each holder check's answer, with whether it reads 'held' written by hand from the row's name. */
const HOLDERS: Array<[string, () => unknown, { held: boolean }]> = [
  ['no shard count', () => ({ rows: [{ n: null }] }), { held: false }],
  ['no row', () => ({ rows: [{ n: 2, shard: 1, holder_process: null }] }), { held: false }],
  ['reserved', () => ({ rows: [heldRow({ released: true, reserved: true })] }), { held: false }],
  ['kept', () => ({ rows: [heldRow({ released: true })] }), { held: false }],
  ['expired', () => ({ rows: [heldRow({ renewed_ago_ms: 10_000_000, up_ms: '20000000', node_seen_ago_ms: 10_000_000 })] }), { held: false }],
  ['held by this node', () => ({ rows: [heldRow({ holder_node: 'n-a' })] }), { held: true }],
  ['held by another node', () => ({ rows: [heldRow()] }), { held: true }],
  ['28000', () => sqlError('28000', 'role "bot" is not permitted to log in'), { held: false }],
  ['another SQLSTATE', () => sqlError('42501', 'permission denied for table shard_claims'), { held: false }],
  ['a connect failure', () => new Error('connect ECONNREFUSED 10.0.0.2:5432'), { held: false }],
];
const CLASSES = ['verified', 'local', 'unprotected'] as const;
const AUDIENCES: Array<['owner route' | 'member route' | 'CLI', 'owner' | 'member', string]> = [
  ['owner route', 'owner', 'web-ui-owner'], ['member route', 'member', '123456789012345678'], ['CLI', 'owner', '123456789012345678'],
];

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 }
    : sql.includes('WHERE id = $1') && !sql.includes('AND state') ? { rows: [{ state: 'done', reply: JSON.stringify({ success: true, data: { v: 1 } }), pickup_over: true, answer_over: false }] } : undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  resetNb7();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the plan over every axis (test 2)', () => {
  it.each(STAGES.flatMap(([stage, route]) => HOLDERS.flatMap(([holder, answer, expected]) => CLASSES.map(cls => [stage, holder, cls, route, answer, expected] as const))))(
    'child %s, holder check %s, client %s', async (stage, holderName, cls, route, holderAnswer, expected) => {
      const bot = { writerRoute: () => route, isRunning: () => stage === 'guild' } as any;
      for (const op of PANEL_REQUEST_OPS) {
        for (const [who, audience, userId] of AUDIENCES) {
          rig.statements.length = 0;
          rig.holderCalls.length = 0;
          rig.holder = holderAnswer;
          rig.transport[URL1] = cls;
          let localSends = 0;
          const plan = await planGuildRequest(bot, GUILD, op, audience);
          let answer: any;
          void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: { via: audience, userId } }, async () => { localSends += 1; return { success: true, data: { local: true } }; }).then(a => { answer = a; });
          await vi.advanceTimersByTimeAsync(2000);
          const label = `${op} ${who}`;
          expect(answer, label).toBeDefined();
          const inserts = rig.statements.filter(s => s.sql === REQUEST_INSERT_SQL);
          const reply = answer.reply;
          if (stage === 'guild') {
            expect([localSends, inserts.length, rig.holderCalls.length], label).toEqual([1, 0, 0]);
            expect(reply, label).toEqual({ success: true, data: { local: true } });
            continue;
          }
          expect(localSends, label).toBe(0);
          expect(rig.holderCalls, label).toHaveLength(1);
          const raw = holderAnswer() as any;
          const failed = raw instanceof Error;
          const held = expected.held;
          const here = held && raw.rows[0].holder_node === 'n-a';
          const sent = held && !here && cls !== 'unprotected';
          expect(inserts.length, label).toBe(sent ? 1 : 0);
          if (sent) {
            expect(reply.success, label).toBe(true);
            expect(reply.servedBy, label).toBe(audience === 'owner' ? 'BRAVO' : undefined);
            expect(JSON.parse(inserts[0].values[6] as string).actor, label).toEqual({ via: audience, userId });
            continue;
          }
          expect(answer.status, label).toBe(503);
          expect(reply.success, label).toBe(false);
          expect(String(reply.error ?? ''), label).not.toMatch(/can't confirm/);
          if (failed) expect(reply.code, label).toBe(holderName === '28000' ? 'maintenance' : 'backend-unavailable');
          else if (!held) expect(reply.code, label).toBe('no-holder');
          else if (here) {
            if (stage === 'none') expect(reply, label).toEqual({ success: false, error: 'Bot is not running' });
            else expect(reply, label).toEqual({ success: false, code: route.code, error: route.error });
          } else {
            expect(reply.code, label).toBe('insecure-transport');
            expect(String(reply.error), label).toMatch(/nothing was run/);
          }
          if (audience === 'member') expect(String(reply.error ?? ''), label).not.toContain('BRAVO');
        }
      }
    },
    60_000,
  );
});

const CHILD_ANSWERS: Array<[string, unknown]> = [
  ['ok', { success: true, data: { local: true } }],
  ['a refusal', { success: false, ran: false, code: 'invalid', error: 'The request for this server was malformed; nothing was run.' }],
  ['not-held', { success: false, code: 'not-held', error: "This machine's bot does not run this server." }],
  ['not-ready', { success: false, ran: false, code: 'not-ready', error: 'This server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.' }],
  ['no answer', undefined],
  ['timeout', { success: false, error: 'IPC request timed out', noAnswer: 'timeout' }],
  ['exit', { success: false, error: 'bot process exited before replying', noAnswer: 'stopped' }],
  ['stopped', { success: false, error: 'The bot is stopping', noAnswer: 'stopped' }],
];
const CHILD_HOLDERS: Array<[string, () => unknown]> = [
  ['held by another node', () => ({ rows: [heldRow()] })],
  ['kept', () => ({ rows: [heldRow({ released: true })] })],
];

describe("the child's answer at its guild report (test 2)", () => {
  it.each(CHILD_ANSWERS.flatMap(([child, reply]) => CHILD_HOLDERS.map(([holder, answer]) => [child, holder, reply, answer] as const)))(
    'child answers %s, holder check %s', async (child, holderName, childReply, holderAnswer) => {
      const bot = { writerRoute: () => ({ route: 'child' }), isRunning: () => true } as any;
      for (const op of PANEL_REQUEST_OPS) {
        for (const [who, audience, userId] of AUDIENCES) {
          rig.statements.length = 0;
          rig.holderCalls.length = 0;
          rig.holder = holderAnswer;
          rig.transport[URL1] = 'verified';
          let localSends = 0;
          const plan = await planGuildRequest(bot, GUILD, op, audience);
          let answer: any;
          void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: { via: audience, userId } }, async () => { localSends += 1; return childReply; }).then(a => { answer = a; });
          await vi.advanceTimersByTimeAsync(2000);
          const label = `${op} ${who}`;
          expect(answer, label).toBeDefined();
          expect(localSends, label).toBe(1);
          const inserts = rig.statements.filter(s => s.sql === REQUEST_INSERT_SQL);
          if (child !== 'not-held') {
            expect([rig.holderCalls.length, inserts.length], `${label}: a local answer goes nowhere else`).toEqual([0, 0]);
            const reply = childReply as any;
            if (child === 'ok' || child === 'a refusal') expect(answer, label).toEqual({ status: null, reply });
            else if (child === 'not-ready') expect(answer, label).toEqual({ status: 503, reply });
            else {
              const cause = child === 'no answer' || child === 'timeout' ? 'timeout' : 'stopped';
              expect(answer.status, label).toBe(503);
              expect(answer.reply, label).toMatchObject({ success: false, code: 'no-answer', noAnswer: cause });
              expect(String(answer.reply.error), label).toMatch(isReadOp(op) ? /nothing was changed/ : /can't confirm/);
            }
            continue;
          }
          expect(rig.holderCalls, label).toHaveLength(1);
          if (holderName === 'kept') {
            expect(inserts, `${label}: a kept row takes no request`).toHaveLength(0);
            expect(answer.status, label).toBe(503);
            expect(answer.reply, label).toMatchObject({ success: false, code: 'no-holder' });
            if (audience === 'owner') expect(String(answer.reply.error), label).toMatch(/^This server's shard \(shard 1 of 2\) is kept for BRAVO while its bot restarts; nothing was [a-z ]+\. Try again once BRAVO runs it\.$/);
            else expect(String(answer.reply.error), label).not.toContain('BRAVO');
            expect(String(answer.reply.error), label).toMatch(/nothing was/);
          } else {
            expect(inserts, label).toHaveLength(1);
            expect(answer.reply, label).toMatchObject({ success: true, data: { v: 1 } });
          }
        }
      }
    },
    60_000,
  );
});
