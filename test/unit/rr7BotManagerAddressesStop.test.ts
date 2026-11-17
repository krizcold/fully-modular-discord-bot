import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotManager, LATE_ADDRESSES_LINE, addressesTiming } from '../../src/webui/botManager';
import { addressListInUse, resetAddressesForTests } from '../../src/utils/databaseAddress';

const P = BotManager.prototype as any;
const logs: string[] = [];
const realAckMs = addressesTiming.ackMs;
const ONE = 'postgres://bot:pw@a.example:5432/bot';
const TWO = 'postgres://bot:pw@a.example:5432/bot,postgres://bot:pw@w.example:5432/bot';

beforeEach(() => {
  logs.length = 0;
  resetAddressesForTests();
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  addressesTiming.ackMs = realAckMs;
  resetAddressesForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A manager with a running bot process whose send runs onSend; the ack goes through the real noteAddressesAck. */
function addressesRig(onSend: (m: any, ack: (data: any) => void) => void) {
  const sent: any[] = [];
  const self: any = {
    isRunning: () => true,
    addressesSeq: 0,
    newestAddresses: null,
    addressesWaiters: new Map(),
  };
  const ack = (data: any) => P.noteAddressesAck.call(self, data);
  self.botProcess = { send: (m: any) => { sent.push(m); onSend(m, ack); return true; } };
  const apply = (url: string) => P.applyAddressList.call(self, url) as Promise<{ status: number; body: any }>;
  return { self, sent, ack, apply };
}

describe('the addresses hook in the web UI process', () => {
  it('numbers each call addresses-1, addresses-2 on the wire', async () => {
    const r = addressesRig((m, ack) => ack({ id: m.data.id, accepted: true }));
    await r.apply(ONE);
    await r.apply(TWO);
    expect(r.sent.map(m => m.data.id)).toEqual(['addresses-1', 'addresses-2']);
    expect(r.sent.every(m => /^addresses-[1-9][0-9]*$/.test(m.data.id))).toBe(true);
  });

  it('an ack inside the bound answers applied and logs no late-ack line', async () => {
    const r = addressesRig((m, ack) => ack({ id: m.data.id, accepted: true }));
    expect(await r.apply(TWO)).toEqual({ status: 200, body: { success: true, applied: true } });
    expect(addressListInUse()).toBe(TWO);
    expect(logs).not.toContain(LATE_ADDRESSES_LINE);
  });

  it('a finished call leaves no timer and no waiter behind', async () => {
    vi.useFakeTimers();
    const r = addressesRig((m, ack) => ack({ id: m.data.id, accepted: true }));
    expect((await r.apply(TWO)).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(r.self.addressesWaiters.size).toBe(0);
  });

  it('a send that throws logs why, and the call answers unknown at the bound', async () => {
    addressesTiming.ackMs = 20;
    const r = addressesRig(() => { throw new Error('channel closed'); });
    const answer = await r.apply(TWO);
    expect(answer.status).toBe(502);
    expect(answer.body.unknown).toBe(true);
    expect(logs).toContain('[WebUI] The address list could not be sent to the bot process: channel closed');
    expect(addressListInUse()).not.toBe(TWO);
  });

  it('a refusal without an error text answers the default refusal', async () => {
    const r = addressesRig((m, ack) => ack({ id: m.data.id, accepted: false }));
    expect(await r.apply(TWO)).toEqual({ status: 400, body: { success: false, error: 'the bot process refused the address list' } });
  });

  it('a refusal whose error is not a string answers the default refusal', async () => {
    const r = addressesRig((m, ack) => ack({ id: m.data.id, accepted: false, error: 42 }));
    expect(await r.apply(TWO)).toEqual({ status: 400, body: { success: false, error: 'the bot process refused the address list' } });
    expect(addressListInUse()).not.toBe(TWO);
  });

  it('an ack message without data or without a string id is ignored without throwing', () => {
    const self: any = { newestAddresses: { id: 'addresses-1', url: TWO, answered: false }, addressesWaiters: new Map() };
    const waiter = vi.fn();
    self.addressesWaiters.set('addresses-1', waiter);
    expect(() => P.noteAddressesAck.call(self, undefined)).not.toThrow();
    expect(() => P.noteAddressesAck.call(self, null)).not.toThrow();
    expect(waiter).not.toHaveBeenCalled();
    expect(addressListInUse()).not.toBe(TWO);
  });
});

describe('owner channel write marks', () => {
  it('a second end of the same mark changes nothing', () => {
    const self: any = { migrationRunning: () => null, ownerChannelWrites: 0 };
    const a = P.ownerChannelWriteStart.call(self);
    const b = P.ownerChannelWriteStart.call(self);
    expect(a.ok && b.ok).toBe(true);
    a.end();
    a.end();
    expect(P.ownerChannelWriteSettled.call(self)).toBe(false);
    b.end();
    expect(P.ownerChannelWriteSettled.call(self)).toBe(true);
    b.end();
    expect(P.ownerChannelWriteSettled.call(self)).toBe(true);
  });
});

describe('migrationBotState names unsaved files', () => {
  it('a maintenance answer with 0 guilds and 3 unsaved files names the 3 files', () => {
    const self: any = {
      operationInProgress: false, stoppingRestart: false, queuedRestart: null,
      isRunning: () => true, childMaintenanceBoot: false, childModeReported: true, childMode: 'maintenance',
      childEnterAnswer: { saved: false, unsavedGuilds: 0, unsavedFiles: 3 },
    };
    expect(P.migrationBotState.call(self)).toEqual({ ok: false, error: 'The bot holds unsaved changes (0 guilds, 3 files); a stop or restart drops them' });
  });
});

/** A shutdown rig: the child outlives every wait; within() runs onWait before it answers false. */
function stopRig(onWait: (self: any) => void = () => undefined) {
  const child: any = { exitCode: null, signalCode: null, kill: vi.fn(), once: () => undefined };
  const failed: Error[] = [];
  const self: any = {
    operationInProgress: false,
    cancelCrashRestart: () => undefined,
    stopsRequested: 0,
    stopStandby: vi.fn(),
    botProcess: child,
    retiring: { child },
    exitOf: P.exitOf,
    within: async () => { onWait(self); return false; },
    addLog: () => undefined,
    emitEvent: () => undefined,
    promote: vi.fn(),
    currentChildGone: P.currentChildGone,
    failPendingIpc: P.failPendingIpc,
    pendingIpcRejects: new Set([(e: Error) => { failed.push(e); }]),
  };
  return { self, child, failed };
}

describe('shutdown during a retire', () => {
  it('a stop with a retiring child that is not the current one stops the standby', async () => {
    const stopStandby = vi.fn();
    const self: any = {
      operationInProgress: false, cancelCrashRestart: () => undefined, stopsRequested: 0,
      retiring: { child: { pid: 1 } }, botProcess: null, stopStandby,
    };
    await P.shutdown.call(self, false, 'stop');
    expect(stopStandby).toHaveBeenCalledWith('the bot process stopped');
    expect(logs).toContain('[BotManager] Bot is not running');
  });

  it('a retiring child that outlives its kill fails the pending requests with the stop text', async () => {
    const r = stopRig();
    await P.shutdown.call(r.self, false, 'stop');
    expect(r.self.botProcess).toBeNull();
    expect(r.failed.map(e => e.message)).toEqual(['bot process was stopped before replying']);
    expect(r.self.promote).toHaveBeenCalledWith(true);
  });

  it('a retiring child that outlives its kill after another became current leaves the current one', async () => {
    const other: any = { exitCode: null, signalCode: null };
    const r = stopRig(self => { self.botProcess = other; });
    await P.shutdown.call(r.self, false, 'stop');
    expect(r.self.botProcess).toBe(other);
    expect(r.failed).toEqual([]);
    expect(r.self.promote).toHaveBeenCalledWith(true);
  });
});

describe('enterMaintenance maps the held counts', () => {
  const enter = (reply: any) => P.enterMaintenance.call({
    isRunning: () => true, botProcess: {}, childStage: 'shared', stageReached: () => true, sendIPCMessage: vi.fn(async () => reply),
  }, 'm');
  const NO_RESULT = '[BotManager] The bot process answered the maintenance request without a save result';

  it('saved false keeps unanswered guilds and unconfirmed files in the answer', async () => {
    const answer = await enter({ saved: false, unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 2, unconfirmedFiles: 3 });
    expect(answer.saved).toBe(false);
    expect(answer.unansweredGuilds).toBe(2);
    expect(answer.unconfirmedFiles).toBe(3);
  });

  it('saved null with no counts warns and answers can\'t confirm', async () => {
    expect(await enter({ saved: null })).toEqual({ saved: null, note: "can't confirm whether the held changes were saved" });
    expect(logs).toContain(NO_RESULT);
  });

  it.each([
    ['unansweredGuilds', { unansweredGuilds: 1 }],
    ['unconfirmedFiles', { unconfirmedFiles: 2 }],
    ['unansweredFiles', { unansweredFiles: 3 }],
  ])('saved null with only %s keeps the count and does not warn', async (_name, counts) => {
    const answer = await enter({ saved: null, ...counts });
    expect(answer.saved).toBeNull();
    for (const [k, v] of Object.entries(counts)) expect(answer[k]).toBe(v);
    expect(answer.note).toMatch(/; can't confirm whether the held changes were saved$/);
    expect(answer.note).not.toBe("can't confirm whether the held changes were saved");
    expect(logs).not.toContain(NO_RESULT);
  });

  it('saved null because work still runs, with nothing held: the note names the running work and has no empty clause (NX5 G8-14)', async () => {
    const running = 'premium: 1 member notice(s) not sent and recorded yet';
    const answer = await enter({ saved: null, unansweredGuilds: 0, unconfirmedFiles: 0, running });
    expect(answer).toEqual({
      saved: null, unansweredGuilds: 0, unconfirmedFiles: 0,
      note: `still running and may save changes: ${running}; can't confirm that every change is saved`,
    });
    expect(logs).not.toContain(NO_RESULT);
  });

  it('saved null with a held count and work running: the held clause, then the running work, then the held changes (NX5 G8-14)', async () => {
    const running = 'premium: 1 change(s) waiting for a payment provider';
    const answer = await enter({ saved: null, unansweredGuilds: 1, unconfirmedFiles: 0, running });
    expect(answer.note).toBe(`1 guild(s) hold a save the database did not answer, which may have landed; still running and may save changes: ${running}; can't confirm whether the held changes were saved`);
  });

  it('saved false with work running: the note adds the running work after the held clauses (NX5 G8-14)', async () => {
    const running = 'premium: 1 change(s) waiting for a payment provider';
    const answer = await enter({ saved: false, unsavedGuilds: 0, unsavedFiles: 1, unansweredGuilds: 0, unconfirmedFiles: 0, running });
    expect(answer).toEqual({
      saved: false, unsavedGuilds: 0, unsavedFiles: 1,
      note: `0 guild(s) and 1 file(s) hold changes that could not be saved; still running and may save changes: ${running}`,
    });
  });

  it('saved false with nothing running: the note is the held clauses alone', async () => {
    const answer = await enter({ saved: false, unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 });
    expect(answer.note).toBe('1 guild(s) and 0 file(s) hold changes that could not be saved');
  });
});

describe('the local op chain', () => {
  it('a reconcile that throws answers that nothing was saved', async () => {
    const resolve = vi.fn();
    const run = vi.fn();
    const self: any = {
      chainQueue: [{ run, resolve }], chainCurrent: null, chainDeposed: null, chainHolds: false,
      reconcileAfterTake: async () => { throw new Error('db down'); },
    };
    await P.pumpChain.call(self);
    expect(run).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      ok: false, status: 503, code: 'backend-unavailable',
      error: "Can't reach the database to read the shared files (db down); nothing was saved. Try again in a moment.",
    });
  });
});
