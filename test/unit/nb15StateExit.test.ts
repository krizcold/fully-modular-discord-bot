import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const { stubs } = await import('../helpers/nb15Stubs');
  return { ...real, getPanelManager: () => stubs.manager };
});
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', async () => {
  const { stubs } = await import('../helpers/nb15Stubs');
  return { default: () => stubs.commands };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  const { premiumStub } = await import('../helpers/nb15Stubs');
  return { ...real, getPremiumManager: () => premiumStub };
});

import { ANSWER_SQL, REQUEST_CLAIM_SQL, REQUEST_INSERT_SQL, REPLY_READ_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { planGuildRequest, runGuildRequest } from '../../src/webui/utils/guildRequests';
import { fakeModelTime, flush, quietLogs } from '../helpers/nb7World';
import { GUILD } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { ranTruthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import { NOT_HELD } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { resetWorld15, World15, type Sent15 } from '../helpers/nb15World';

// NB15 test 7: every cell of section 5's state x exit table but row LV (test 14), on test 6's world: the real sender,
// the real holder's sweep and the model store. Each cell gives the route's answer and how many times module code ran:
// 0, 1, or 0 or 1 only together with can't confirm (or no answer at all when nobody is told).

const COLUMNS = ['continue', 'cancel', 'resume', 'sender stop', 'sender crash', 'holder stop', 'holder crash', 'takeover', 'switch', 'database away', 'maintenance'] as const;
type Column = typeof COLUMNS[number];
const PHASES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'H1', 'H2', 'H3', 'H4', 'L', 'J'] as const;
type Phase = typeof PHASES[number];

interface Want {
  /** The answer's code; null: no code; 'success': success true. */
  code?: string | null | 'success';
  text?: RegExp;
  runs: 0 | 1 | '0or1';
  /** Nobody is told: the route has no answer to give. */
  none?: boolean;
  /** No request row was inserted. */
  noInsert?: boolean;
  /** Fields the reply carries. */
  fields?: Record<string, unknown>;
  /** The browser went away at this phase: the route still goes on to its answer, and nothing withdraws the row. */
  goesOn?: boolean;
}

type Setup = (w: World15) => Promise<Sent15 | Sent15[]>;

const NOTHING = /nothing was run/;
const UNSURE = /can't confirm/;
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const HOLDER_MAINTENANCE = { code: null, text: exactly(`On BRAVO: ${DEFAULT_MAINTENANCE_MESSAGE}`), fields: { maintenance: true } } as const;
const DEPOSED = exactly(`On BRAVO: ${ranTruthText({ answer: 'deposed', partial: false }).replace(/^The/, 'the')}`);
const UNSETTLED = exactly("The database could not show that the panel action sent to BRAVO was withdrawn before BRAVO took it; can't confirm whether the panel action ran. Check the server before you run it again.");
const NOT_TAKEN = exactly('BRAVO did not take the panel action within 5 s; nothing was run. Try again in a moment; if it keeps happening, look for [GuildRequests] lines in the bot log on BRAVO.');

let world: World15 | undefined;

/** The route goes on: the holder passes and finishes each action ok, until the answer or 75 s. */
async function follow(w: World15, sent: Sent15, finish = true): Promise<void> {
  for (let i = 0; i < 75 && !sent.answer && !sent.crashed; i++) {
    if (finish) while (w.running.some(r => r.gen === w.gen)) await w.finish('ok');
    await w.pass();
    await w.advance(1000);
  }
}

/** The browser tab or the CLI goes away: nothing in the route takes it, so the world only notes the time. */
const gone = (w: World15) => { cancelledAt = w.model.now; };
let cancelledAt: number | null = null;

const button = (w: World15, between?: () => void) => w.send('panel:button', 'owner', 'p', between);
async function pending(w: World15) { return button(w); }
async function applying(w: World15) { const s = await button(w); await w.pass(); expect(w.runsOf(s)).toBe(1); return s; }
async function onWire(w: World15) { w.model.forceSql(REQUEST_INSERT_SQL, 'wire'); return button(w); }
async function settleOnWire(w: World15) {
  const s = await button(w);
  w.model.forceSql(SETTLE_UPDATE_SQL, 'wire');
  for (let i = 0; i < 24 && w.model.wire.length === 0; i++) await w.advance(250);
  expect(w.model.wire.length).toBe(1);
  return s;
}
async function claimOnWire(w: World15) {
  const s = await button(w);
  w.model.forceSql(REQUEST_CLAIM_SQL, 'wire');
  void w.sweep.pass();
  await flush();
  expect(w.model.wire.length).toBe(1);
  return s;
}
async function answerOnWire(w: World15) {
  const s = await applying(w);
  w.model.forceSql(ANSWER_SQL, 'wire');
  await w.finish('ok');
  return s;
}
async function resume(w: World15, first: Sent15): Promise<Sent15[]> {
  const second = await button(w);
  await follow(w, first);
  await follow(w, second);
  return [first, second];
}

/** The local route: a child at its guild report whose answer the cell scripts; runs counts the child's module starts. */
async function local(w: World15, reply: () => Promise<any>, ran = 0): Promise<Sent15> {
  const bot = { writerRoute: () => ({ route: 'child' }), isRunning: () => true } as any;
  const sent: Sent15 = { op: 'panel:button', audience: 'owner', tag: `local-${w.sends.length}`, sentAt: w.model.now };
  w.sends.push(sent);
  const plan = await planGuildRequest(bot, GUILD, 'panel:button', 'owner');
  void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: { via: 'owner', userId: 'web-ui-owner' } }, async () => {
    if (ran) w.runs.set(sent.tag, [{ pid: 'local', serving: true, scope: 'guild' }]);
    const answer = await reply();
    if (ran && answer?.success === true) w.outcomes.set(sent.tag, 'ok');
    return answer;
  }).then(a => { if (!sent.crashed) { sent.answer = a; sent.answeredAt = w.model.now; } });
  await w.advance(100);
  return sent;
}

/** A JSON bot: today's routes, no request; the child answers as scripted. */
async function json(w: World15, reply: any, ran = 0): Promise<Sent15> {
  setBackendKind('file');
  return local(w, async () => reply, ran);
}

const STOPPED_SERVING = 'This bot process stopped serving this server; nothing was run. Try again in a moment.';

const CELLS: Array<[Phase, Column, Setup, Want]> = [
  ['S1', 'continue', async w => { const s = await button(w); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S1', 'cancel', async w => { const s = await button(w, () => gone(w)); await follow(w, s); return s; }, { code: 'success', runs: 1, goesOn: true }],
  ['S1', 'resume', async w => resume(w, await button(w)), { code: 'success', runs: 1 }],
  ['S1', 'sender stop', async w => { await w.exit(); return button(w); }, { code: 'stopping', text: /shutting down; nothing was run/, runs: 0, noInsert: true }],
  ['S1', 'sender crash', async w => { w.crashSender(); const s: Sent15 = { op: 'panel:button', audience: 'owner', tag: 'never', sentAt: 0, crashed: true }; return s; }, { runs: 0, none: true, noInsert: true }],
  ['S1', 'holder stop', async w => { w.stopping = true; const s = await button(w); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S1', 'holder crash', async w => { w.kill(); const s = await button(w); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S1', 'takeover', async w => { w.crash(); const s = await button(w); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S1', 'switch', async w => { w.latched = true; const s = await button(w); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S1', 'database away', async w => { w.away(); return button(w); }, { code: 'backend-unavailable', text: NOTHING, runs: 0, noInsert: true }],
  ['S1', 'maintenance', async w => { w.refuseLogin(); return button(w); }, { code: 'maintenance', text: /in maintenance; nothing was run/, runs: 0, noInsert: true }],

  ['S2', 'continue', async w => { const s = await onWire(w); w.model.deliver(); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S2', 'cancel', async w => { const s = await onWire(w); gone(w); w.model.deliver(); await follow(w, s); return s; }, { code: 'success', runs: 1, goesOn: true }],
  ['S2', 'resume', async w => { const s = await onWire(w); w.model.deliver(); return resume(w, s); }, { code: 'success', runs: 1 }],
  ['S2', 'sender stop', async w => { const s = await onWire(w); await w.exit(); w.model.deliver(); await follow(w, s, false); await w.advance(10_000); return s; }, { code: 'backend-unavailable', text: exactly('The database refused the panel action (SQLSTATE 23505: duplicate key value violates unique constraint "guild_requests_pkey"); nothing was run.'), runs: 0 }],
  ['S2', 'sender crash', async w => { const s = await onWire(w); w.crashSender(); w.model.deliver(); await w.pass(); await w.drain(); return s; }, { runs: '0or1', none: true }],
  ['S2', 'holder stop', async w => { const s = await onWire(w); w.model.deliver(); await flush(); await w.stop(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S2', 'holder crash', async w => { const s = await onWire(w); w.model.deliver(); await flush(); w.kill(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S2', 'takeover', async w => { const s = await onWire(w); w.model.deliver(); await flush(); w.takeover(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S2', 'switch', async w => { const s = await onWire(w); w.switchMain(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSETTLED, fields: { noAnswer: 'unsettled' }, runs: 0 }],
  ['S2', 'database away', async w => { const s = await onWire(w); w.away(); w.model.cut(false); await w.advance(3000); w.back(); await follow(w, s); return s; }, { code: 'backend-unavailable', text: exactly('The database did not confirm that the panel action was sent to BRAVO, so it was withdrawn; nothing was run. Try again in a moment.'), runs: 0 }],
  ['S2', 'maintenance', async w => button(w, () => w.refuseLogin()), { code: 'maintenance', text: /in maintenance; nothing was run/, runs: 0, noInsert: true }],

  ['S3', 'continue', async w => { const s = await pending(w); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S3', 'cancel', async w => { const s = await pending(w); expect(w.model.rows.get(s.id!)?.state).toBe('pending'); gone(w); await follow(w, s); return s; }, { code: 'success', runs: 1, goesOn: true }],
  ['S3', 'resume', async w => resume(w, await pending(w)), { code: 'success', runs: 1 }],
  ['S3', 'sender stop', async w => { const s = await pending(w); await w.exit(); await w.advance(3000); await w.drain(); return s; }, { code: 'no-answer', text: exactly("This web panel shut down before it read the answer from BRAVO; can't confirm whether the panel action ran. Check the server before you run it again."), fields: { noAnswer: 'stopped' }, runs: 0 }],
  ['S3', 'sender crash', async w => { const s = await pending(w); w.crashSender(); await w.drain(); return s; }, { runs: '0or1', none: true }],
  ['S3', 'holder stop', async w => { const s = await pending(w); await w.stop(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S3', 'holder crash', async w => { const s = await pending(w); w.kill(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S3', 'takeover', async w => { const s = await pending(w); w.takeover(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S3', 'switch', async w => { const s = await pending(w); w.switchMain(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 0 }],
  ['S3', 'database away', async w => { const s = await pending(w); w.away(); await w.advance(54_000); w.back(); await follow(w, s); return s; }, { code: 'not-taken', text: NOT_TAKEN, runs: 0 }],
  ['S3', 'maintenance', async w => { const s = await pending(w); w.maintenance = true; await follow(w, s); return s; }, { ...HOLDER_MAINTENANCE, runs: 0 }],

  ['S4', 'continue', async w => { const s = await settleOnWire(w); w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'cancel', async w => { const s = await settleOnWire(w); w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'resume', async w => { const s = await settleOnWire(w); w.model.deliver(); await follow(w, s); return [s]; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'sender stop', async w => { const s = await settleOnWire(w); const ended = w.exit(); w.model.deliver(); await ended; await follow(w, s, false); return s; }, { code: 'not-taken', text: NOT_TAKEN, runs: 0 }],
  ['S4', 'sender crash', async w => { const s = await settleOnWire(w); w.crashSender(); w.model.deliver(); await w.drain(); return s; }, { runs: 0, none: true }],
  ['S4', 'holder stop', async w => { const s = await settleOnWire(w); w.stopping = true; w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'holder crash', async w => { const s = await settleOnWire(w); w.kill(); w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'takeover', async w => { const s = await settleOnWire(w); w.takeover(); w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['S4', 'switch', async w => { const s = await settleOnWire(w); w.switchMain(); await follow(w, s); return s; }, { code: 'no-answer', text: exactly("The answer from BRAVO could not be read from the database; can't confirm whether the panel action ran. Check the server before you run it again."), fields: { noAnswer: 'lost' }, runs: 0 }],
  ['S4', 'database away', async w => { const s = await settleOnWire(w); w.away(); w.model.cut(false); await follow(w, s); w.back(); return s; }, { code: 'no-answer', text: UNSURE, runs: 0 }],
  ['S4', 'maintenance', async w => { const s = await settleOnWire(w); w.refuseLogin(); w.model.cut(false); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 0 }],

  ['S5', 'continue', async w => { const s = await applying(w); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S5', 'cancel', async w => { const s = await applying(w); gone(w); await follow(w, s); return s; }, { code: 'success', runs: 1, goesOn: true }],
  ['S5', 'resume', async w => resume(w, await applying(w)), { code: 'success', runs: 1 }],
  ['S5', 'sender stop', async w => { const s = await applying(w); await w.exit(); await w.advance(3000); await w.drain(); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['S5', 'sender crash', async w => { const s = await applying(w); w.crashSender(); await w.drain(); return s; }, { runs: 1, none: true }],
  ['S5', 'holder stop', async w => { const s = await applying(w); const stopped = w.stop(); await w.finish('ok'); await stopped; await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S5', 'holder crash', async w => { const s = await applying(w); w.crash(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['S5', 'takeover', async w => { const s = await applying(w); w.takeover(); await w.finish('refused'); await follow(w, s); return s; }, { code: null, text: DEPOSED, runs: 1 }],
  ['S5', 'switch', async w => { const s = await applying(w); w.switchMain(); await w.finish('ok'); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['S5', 'database away', async w => { const s = await applying(w); w.away(); await w.finish('pending'); await follow(w, s); w.back(); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['S5', 'maintenance', async w => { const s = await applying(w); w.maintenance = true; await w.finish('ok'); await follow(w, s); return s; }, { code: 'success', runs: 1 }],

  ['S6', 'continue', async w => { const s = await applying(w); await w.finish('ok'); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['S6', 'cancel', async w => { const s = await applying(w); await w.finish('ok'); await follow(w, s); expect(s.answer).toBeDefined(); gone(w); await w.advance(5000); return s; }, { code: 'success', runs: 1, goesOn: true }],
  ['S6', 'resume', async w => { const s = await applying(w); await w.finish('ok'); return resume(w, s); }, { code: 'success', runs: 1 }],

  ['H1', 'continue', async w => { const s = await claimOnWire(w); w.model.deliver(); await flush(); expect(w.model.row(s.id!)?.body).toBe(''); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['H1', 'holder stop', async w => { const s = await claimOnWire(w); w.stopping = true; w.model.deliver(); await flush(); await follow(w, s); return s; }, { code: 'not-taken', text: /could not start it; nothing was run/, runs: 0 }],
  ['H1', 'holder crash', async w => { const s = await claimOnWire(w); w.kill(); w.model.cut(true); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 0 }],
  ['H1', 'takeover', async w => { const s = await claimOnWire(w); w.takeover(); w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['H1', 'switch', async w => { const s = await claimOnWire(w); w.model.ship(); w.switchMain(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSETTLED, fields: { noAnswer: 'unsettled' }, runs: 0 }],
  ['H1', 'database away', async w => { const s = await claimOnWire(w); w.away(); w.model.cut(true); await w.advance(2000); w.back(); await follow(w, s); return s; }, { code: 'not-taken', text: /could not start it; nothing was run/, runs: 0 }],
  ['H1', 'maintenance', async w => { const s = await claimOnWire(w); w.maintenance = true; w.model.deliver(); await follow(w, s); return s; }, { ...HOLDER_MAINTENANCE, runs: 0 }],

  ['H2', 'continue', async w => { const s = await w.send('panel:button', 'owner', 'sys'); await follow(w, s); return s; }, { code: 'not-allowed', text: /runs only from the web panel of its own machine; nothing was run/, runs: 0 }],
  ['H2', 'holder stop', async w => { const s = await claimOnWire(w); w.stopping = true; w.model.deliver(); await follow(w, s); return s; }, { code: 'not-taken', text: NOTHING, runs: 0 }],
  ['H2', 'takeover', async w => { const s = await button(w); w.leaseLost = true; await follow(w, s); return s; }, { code: 'not-taken', text: /stopped serving this server before it ran the panel action; nothing was run/, runs: 0 }],
  ['H2', 'switch', async w => { const s = await claimOnWire(w); w.latched = true; w.model.deliver(); await follow(w, s); return s; }, { code: 'no-answer', text: exactly("BRAVO did not answer in time; can't confirm whether the panel action ran. Check the server before you run it again."), fields: { noAnswer: 'timeout' }, runs: 0 }],
  ['H2', 'maintenance', async w => { const s = await button(w); w.maintenance = true; await follow(w, s); return s; }, { ...HOLDER_MAINTENANCE, runs: 0 }],

  ['H3', 'continue', async w => { const s = await applying(w); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['H3', 'holder stop', async w => { const s = await applying(w); const stopped = w.stop(); await w.finish('ok'); await stopped; await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['H3', 'holder crash', async w => { const s = await applying(w); w.crash(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H3', 'takeover', async w => { const s = await applying(w); w.takeover(); await w.finish('refused'); await follow(w, s); return s; }, { code: null, text: DEPOSED, runs: 1 }],
  ['H3', 'switch', async w => { const s = await applying(w); w.switchMain(); await w.finish('ok'); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H3', 'database away', async w => { const s = await applying(w); w.away(); await w.finish('pending'); await follow(w, s); w.back(); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H3', 'maintenance', async w => { const s = await applying(w); w.maintenance = true; await w.finish('ok'); await follow(w, s); return s; }, { code: 'success', runs: 1 }],

  ['H4', 'continue', async w => { const s = await answerOnWire(w); w.model.deliver(); await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['H4', 'holder stop', async w => { const s = await answerOnWire(w); const stopped = w.stop(); w.model.deliver(); await stopped; await follow(w, s); return s; }, { code: 'success', runs: 1 }],
  ['H4', 'holder crash', async w => { const s = await answerOnWire(w); w.crash(); w.model.cut(false); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H4', 'takeover', async w => { const s = await applying(w); w.model.forceSql(ANSWER_SQL, 'wire'); await w.finish('refused'); expect(w.model.wire.length).toBe(1); w.takeover(); w.model.deliver(); await follow(w, s); return s; }, { code: null, text: DEPOSED, runs: 1 }],
  ['H4', 'switch', async w => { const s = await answerOnWire(w); w.switchMain(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H4', 'database away', async w => { const s = await answerOnWire(w); w.away(); w.model.cut(false); await w.advance(15_000); w.back(); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],
  ['H4', 'maintenance', async w => { const s = await answerOnWire(w); w.refuseLogin(); w.model.cut(false); await follow(w, s); return s; }, { code: 'no-answer', text: UNSURE, runs: 1 }],

  ['L', 'continue', async w => local(w, async () => ({ success: true, data: {} }), 1), { code: 'success', runs: 1, noInsert: true }],
  ['L', 'cancel', async w => local(w, async () => ({ success: true, data: {} }), 1), { code: 'success', runs: 1, noInsert: true }],
  ['L', 'resume', async w => [await local(w, async () => ({ success: true }), 1), await local(w, async () => ({ success: true }), 1)], { code: 'success', runs: 1, noInsert: true }],
  ['L', 'sender stop', async w => { await w.exit(); return local(w, async () => ({ success: true })); }, { code: 'stopping', text: /shutting down; nothing was run/, runs: 0, noInsert: true }],
  ['L', 'sender crash', async w => { const s = await local(w, () => new Promise(() => undefined), 1); w.crashSender(); return s; }, { runs: '0or1', none: true, noInsert: true }],
  ['L', 'holder stop', async w => local(w, async () => ({ success: false, error: 'bot process exited before replying', noAnswer: 'stopped' })), { code: 'no-answer', text: /^The bot stopped before it answered; can't confirm whether the panel action ran\. Check the server before you run it again\.$/, runs: 0, noInsert: true }],
  ['L', 'holder crash', async w => local(w, async () => ({ success: false, error: 'IPC request timed out', noAnswer: 'timeout' })), { code: 'no-answer', text: /^The bot did not answer in time; can't confirm whether the panel action ran\./, runs: 0, noInsert: true }],
  ['L', 'takeover', async w => local(w, async () => ({ success: false, error: STOPPED_SERVING })), { code: null, text: /stopped serving this server; nothing was run/, runs: 0, noInsert: true }],
  ['L', 'switch', async w => local(w, async () => ({ success: false, code: 'backend-unavailable', error: 'This bot process stopped writing to its database; nothing was run.' })), { code: 'backend-unavailable', text: NOTHING, runs: 0, noInsert: true }],
  ['L', 'database away', async w => local(w, async () => ({ success: false, ran: true, truth: 'unavailable', error: "The action ran, but the database did not answer; can't confirm whether its changes were saved. Check the server before you run it again." }), 1), { code: null, text: UNSURE, runs: 1, noInsert: true }],
  ['L', 'maintenance', async w => local(w, async () => ({ success: false, code: 'maintenance', error: 'The bot is in maintenance; nothing was run.' })), { code: 'maintenance', text: NOTHING, runs: 0, noInsert: true }],

  ['J', 'continue', async w => json(w, { success: true }, 1), { code: 'success', runs: 1, noInsert: true }],
  ['J', 'cancel', async w => json(w, { success: true }, 1), { code: 'success', runs: 1, noInsert: true }],
  ['J', 'resume', async w => [await json(w, { success: true }, 1), await json(w, { success: true }, 1)], { code: 'success', runs: 1, noInsert: true }],
  ['J', 'sender stop', async w => json(w, { success: false, error: 'The web panel is stopping' }), { code: null, text: /stopping/, runs: 0, noInsert: true }],
  ['J', 'sender crash', async w => { setBackendKind('file'); const s = await local(w, () => new Promise(() => undefined), 1); w.crashSender(); return s; }, { runs: '0or1', none: true, noInsert: true }],
  ['J', 'holder stop', async w => json(w, { success: false, noAnswer: 'stopped' }), { code: 'no-answer', text: UNSURE, runs: 0, noInsert: true }],
  ['J', 'holder crash', async w => json(w, { success: false, noAnswer: 'timeout' }), { code: 'no-answer', text: UNSURE, runs: 0, noInsert: true }],
  ['J', 'takeover', async w => json(w, { success: true }, 1), { code: 'success', runs: 1, noInsert: true }],
  ['J', 'switch', async w => json(w, { success: true }, 1), { code: 'success', runs: 1, noInsert: true }],
  ['J', 'database away', async w => json(w, { success: true }, 1), { code: 'success', runs: 1, noInsert: true }],
  ['J', 'maintenance', async w => json(w, { success: false, code: 'maintenance', error: 'The bot is in maintenance; nothing was run.' }), { code: 'maintenance', text: NOTHING, runs: 0, noInsert: true }],
];

/** Cells the table marks n/a: nothing can happen there. */
const NOT_APPLICABLE: Array<[Phase, Column]> = [
  ...(['sender stop', 'sender crash', 'holder stop', 'holder crash', 'takeover', 'switch', 'database away', 'maintenance'] as Column[]).map(c => ['S6', c] as [Phase, Column]),
  ...(['cancel', 'resume', 'sender stop', 'sender crash'] as Column[]).flatMap(c => (['H1', 'H2', 'H3', 'H4'] as Phase[]).map(p => [p, c] as [Phase, Column])),
  ['H2', 'holder crash'], ['H2', 'database away'],
];

beforeEach(() => {
  fakeModelTime();
  quietLogs();
  cancelledAt = null;
  world = new World15();
});
afterEach(() => {
  resetWorld15(world);
  world = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB15 test 7: the state x exit table', () => {
  it('covers every cell of section 5 but row LV, each once', () => {
    const keys = [...CELLS.map(([p, c]) => `${p}|${c}`), ...NOT_APPLICABLE.map(([p, c]) => `${p}|${c}`)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(PHASES.length * COLUMNS.length);
  });

  it.each(CELLS)('%s x %s', async (_phase, _column, setup, want) => {
    const w = world!;
    const out = await setup(w);
    const sents = Array.isArray(out) ? out : [out];
    for (const sent of sents) {
      const runs = w.runsOf(sent);
      if (want.runs === '0or1') expect(runs).toBeLessThanOrEqual(1);
      else expect(runs, `module code runs of ${sent.tag}`).toBe(want.runs);
      if (want.noInsert) expect(w.model.sentInserts).toHaveLength(0);
      if (want.none) {
        expect(sent.answer, 'nobody is told').toBeUndefined();
        continue;
      }
      expect(sent.answer, 'the route answered').toBeDefined();
      const reply = sent.answer!.reply;
      if (want.code === 'success') expect(reply.success, JSON.stringify(reply)).toBe(true);
      else if (want.code !== undefined) {
        expect(reply.success).not.toBe(true);
        expect(reply.code ?? null, JSON.stringify(reply)).toBe(want.code);
      }
      if (want.text) expect(String(reply.error ?? reply.note ?? ''), JSON.stringify(reply)).toMatch(want.text);
      if (want.fields) expect(reply).toMatchObject(want.fields);
      if (want.goesOn) {
        expect(cancelledAt, 'the cell sent the browser away').not.toBeNull();
        expect(w.model.sentSql.filter(q => q === SETTLE_INSERT_SQL || q === SETTLE_UPDATE_SQL), 'a cancel withdraws nothing').toEqual([]);
        expect(w.model.rows.get(sent.id!)?.state, 'the route went on to the answered row').toBe('done');
      }
      if (runs === 1 || want.runs === '0or1') expect(String(reply.error ?? '')).not.toMatch(NOTHING);
      if (reply.code === 'no-answer') expect(String(reply.error)).toMatch(UNSURE);
    }
    w.check();
  }, 60_000);

  it('S6: the reply is read by its own statement once, and the done row is deleted about 2 minutes later', async () => {
    const w = world!;
    const s = await applying(w);
    await w.finish('ok');
    await follow(w, s);
    expect(s.answer?.reply.success).toBe(true);
    expect(w.model.sentSql.filter(q => q === REPLY_READ_SQL)).toHaveLength(1);
    expect(w.model.rows.get(s.id!)?.state).toBe('done');
    expect(w.model.row(s.id!)?.body).toBe('');
    for (let i = 0; i < 4; i++) { await w.advance(61_000); await w.pass(); }
    expect(w.model.rows.has(s.id!)).toBe(false);
  }, 60_000);

  it('S1 x maintenance through the hook: the holder answers NB2\'s text and runs nothing', async () => {
    const w = world!;
    w.maintenance = true;
    const s = await button(w);
    await follow(w, s);
    expect(w.runsOf(s)).toBe(0);
    expect(s.answer?.reply).toMatchObject({ success: false, maintenance: true, error: `On BRAVO: ${DEFAULT_MAINTENANCE_MESSAGE}`, servedBy: 'BRAVO' });
    expect(s.answer?.reply).not.toHaveProperty('code');
  }, 60_000);

  it('L x continue with not-held: the local answer turns to S1\'s holder check and runs once on the holder', async () => {
    const w = world!;
    const bot = { writerRoute: () => ({ route: 'child' }), isRunning: () => true } as any;
    const sent: Sent15 = { op: 'panel:button', audience: 'owner', tag: 'lh', sentAt: w.model.now };
    w.sends.push(sent);
    const plan = await planGuildRequest(bot, GUILD, 'panel:button', 'owner');
    void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: { via: 'owner', userId: 'web-ui-owner' }, tag: 'lh' }, async () => ({ success: false, code: 'not-held' }))
      .then(a => { sent.answer = a; sent.answeredAt = w.model.now; });
    await flush();
    sent.id = w.model.sentInserts[0];
    await follow(w, sent);
    expect(w.model.sentInserts).toHaveLength(1);
    expect(w.runsOf(sent)).toBe(1);
    expect(sent.answer?.reply).toMatchObject({ success: true, servedBy: 'BRAVO' });
  }, 60_000);
});

describe('NB15 test 7: the start through the real answerPanelMessage and answerInvokeMessage', () => {
  it("H2 x switch: the latch turns stoppedServing() true, so the holder's answer is NB4's text and no handler runs", async () => {
    const w = world!;
    const s = await claimOnWire(w);
    w.latched = true;
    w.model.deliver();
    await flush();
    await w.pass();
    expect(w.runsOf(s)).toBe(0);
    expect(w.model.rows.get(s.id!)?.reply ?? null).toBeNull();
    const errors = vi.mocked(console.error).mock.calls.map(c => String(c[0]));
    expect(errors.some(line => line.includes(`The answer was: ${STOPPED_SERVING_TEXT}`)), errors.join('\n')).toBe(true);
  }, 60_000);

  it('an owner invoke runs its command once through the real dispatcher and answers its transcript', async () => {
    const w = world!;
    const s = await w.send('command:invoke', 'owner', 'p');
    await follow(w, s);
    expect(w.runsOf(s)).toBe(1);
    expect(s.answer?.reply).toMatchObject({ success: true, ran: true, command: 'ping', captured: [], servedBy: 'BRAVO' });
    expect(JSON.parse(w.model.rows.get(s.id!)!.reply!)).toMatchObject({ success: true, ran: true, command: 'ping' });
  }, 60_000);

  it("an invoke under the maintenance gate answers NB2's text and runs nothing; one after the lease lost the shard answers not-taken", async () => {
    const w = world!;
    w.maintenance = true;
    const gated = await w.send('command:invoke', 'owner', 'p');
    await follow(w, gated);
    expect(w.runsOf(gated)).toBe(0);
    expect(gated.answer?.reply).toMatchObject({ success: false, maintenance: true, error: `On BRAVO: ${DEFAULT_MAINTENANCE_MESSAGE}` });
    w.maintenance = false;
    const s = await w.send('command:invoke', 'owner', 'p');
    w.leaseLost = true;
    await follow(w, s);
    expect(w.runsOf(s)).toBe(0);
    expect(JSON.parse(w.model.rows.get(s.id!)!.reply!)).toEqual(NOT_HELD);
    expect(s.answer?.reply).toMatchObject({ code: 'not-taken', error: expect.stringMatching(/stopped serving this server before it ran the command; nothing was run/) });
  }, 60_000);
});
