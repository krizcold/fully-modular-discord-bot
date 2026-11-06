import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  confirm: null as null | ((ticket: unknown, ms: number) => Promise<string>),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    confirmFile: (ticket: any, ms: number) => (hooks.confirm ? hooks.confirm(ticket, ms) : real.confirmFile(ticket, ms)),
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fileTicketFailure, fileTicketState, flushAll, getPending, queuedFilePaths, type FileTicket } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { openLedger, runInLedger, runSealed, writesOf, carryWrites, NO_WRITES, type WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { appendDataTracked, reopenSharedWrites, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp, partialText } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { BotManager } from '../../src/webui/botManager';
import { webhookAnswer } from '../../src/webui/routes/hopFailure';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub, type Hold } from '../helpers/fileHandleStub';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, JOURNAL, linesOf, logged, paidSub, PREMIUM, settleQueue, state, writePremium } from './nb10PremiumRig';

// NB13 C6 to C9 and D1 to D4, D8, D10: every reader of a file ticket reads fileTicketState, and a ledger lists every
// earlier ticket not landed, so no reply or log names a line the disk did not confirm as saved or as lost.

let n = 0;
let stub: AppendStub;
const holds: Hold[] = [];
let category = '';
const opts = () => ({ scope: 'global' as const, category });
const stream = () => dataPath('global', category, 's.jsonl');

beforeEach(() => {
  setBackendKind('file');
  category = `nb13rd${Date.now() % 100000}${++n}`;
  fs.mkdirSync(dataPath('global', category), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  // A row that fails while a hold is set would leave its flush waiting, and the flushAll below with it.
  for (const name of ['holdSync', 'holdWrite', 'holdOpen'] as const) {
    const real = stub[name] as (...args: unknown[]) => Hold;
    (stub as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const hold = real(...args);
      holds.push(hold);
      return hold;
    };
  }
});
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  stub.restore();
  await flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

function ticketOf(tracked: ReturnType<typeof appendDataTracked> | ReturnType<typeof saveDataTracked>): FileTicket {
  if ((tracked.outcome !== 'appended' && tracked.outcome !== 'saved') || tracked.ticket.kind !== 'file') throw new Error(`not accepted: ${tracked.outcome}`);
  return tracked.ticket;
}

/** Line A's try holds its fsync; B is appended into the entry meanwhile; A's fsync then rejects EIO and B lands. */
async function aThenB(record: (fn: () => FileTicket) => FileTicket) {
  const hold = stub.holdSync(stream(), 'EIO');
  const a = record(() => ticketOf(appendDataTracked('s.jsonl', opts(), 'A\n')));
  await hold.reached;
  const b = record(() => ticketOf(appendDataTracked('s.jsonl', opts(), 'B\n')));
  return { a, b, release: () => hold.release() };
}

const errors = (): string[] => logged(console.error as unknown as { mock: { calls: unknown[][] } });
const OTHER = 5353;
const live = new Set<number>([process.pid, OTHER]);

/** Another live bot process writes the lock file, and this holder's check reads it: the deposition runs. */
function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** A take from depth 0 forgets the deposition; the release leaves the lock free for the next test. */
function forgetDeposition(): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  takeWriterLock();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  reopenSharedWrites();
}

const DEPOSED_WORDS = `another process (a bot process, pid ${OTHER}) took the data files' lock`;

describe('8.8 to 8.10: the ledger lists every ticket not landed', () => {
  it('8.8 two appends on one record: the second, then the first, and the verdict is unavailable in part', async () => {
    const ledger = openLedger('interaction');
    const { a, b, release } = await aThenB(fn => runInLedger(ledger, 'm', fn));
    release();
    await flushAll();
    expect(fileTicketState(a)).toBe('unconfirmed');
    expect(fileTicketState(b)).toBe('landed');
    expect(writesOf(ledger).tickets).toEqual([b, a]);
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'unavailable', partial: true });
  });

  it('8.9 a third line on a new record does not make the entry with the unconfirmed line give way', async () => {
    const ledger = openLedger('interaction');
    const { a, b, release } = await aThenB(fn => runInLedger(ledger, 'm', fn));
    release();
    await flushAll();
    const c = runInLedger(ledger, 'm', () => ticketOf(appendDataTracked('s.jsonl', opts(), 'C\n')));
    await flushAll();
    expect(c.record).not.toBe(a.record);
    expect(writesOf(ledger).tickets).toEqual([b, a, c]);
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'unavailable', partial: true });
  });

  it('8.10 (a) B recorded, then A: B, then A, and unavailable once B lands', async () => {
    const ledger = openLedger('interaction');
    const recorded: FileTicket[] = [];
    const { a, b, release } = await aThenB(fn => { const t = fn(); recorded.push(t); return t; });
    runInLedger(ledger, 'm', () => { ledger.noteTicket(b, 'm'); ledger.noteTicket(a, 'm'); });
    release();
    await flushAll();
    expect(ledger.tickets().map(e => e.ticket)).toEqual([b, a]);
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'unavailable', partial: true });
    expect(recorded).toHaveLength(2);
  });

  it("8.10 (b) A recorded while the verdict waits on B: still unavailable in part", async () => {
    const hold = stub.holdSync(stream(), 'EIO');
    const a = ticketOf(appendDataTracked('s.jsonl', opts(), 'A\n'));
    await hold.reached;
    const b = ticketOf(appendDataTracked('s.jsonl', opts(), 'B\n'));
    const ledger = openLedger('interaction');
    ledger.noteTicket(b, 'm');
    const verdict = verdictOf([ledger]);
    await new Promise(resolve => setTimeout(resolve, 20));
    ledger.noteTicket(a, 'm');
    hold.release();
    expect(await verdict).toEqual({ ok: false, answer: 'unavailable', partial: true });
  });

  it('8.11 partialText names a path only when every ticket of it listed landed', async () => {
    const ledger = openLedger('interaction');
    const { a, b, release } = await aThenB(fn => runInLedger(ledger, 'm', fn));
    release();
    await flushAll();
    const lead = 'The bot cannot confirm whether your change was saved in full. Please check before you try again.';
    expect(partialText(lead, ledger)).toBe("The bot cannot confirm whether your change was saved in full. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.");
    runInLedger(ledger, 'm', () => saveDataTracked('b.json', opts(), { v: 1 }));
    await flushAll();
    expect(partialText(lead, ledger)).toBe('The bot cannot confirm whether your change was saved in full. What was saved: b.json. Reload to see it before you try again: trying again could apply the saved part twice.');

    const manager = new BotManager() as any;
    manager.chainDeposed = { role: 'import', pid: 4242 };
    const entry = { label: 'x', provider: false, run: async () => undefined, again: async () => undefined, resolve: () => undefined };
    const reply = carryWrites({ ok: false, code: 'unconfirmed', answer: 'unavailable', partial: true, error: 'e' }, { ...NO_WRITES, tickets: [a, b] });
    expect(await manager.landOrCancel(entry, reply)).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: "Another process took the data files (a data bundle import, pid 4242) while your change was being saved; can't confirm whether it was saved in full. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.",
    });
    expect(path.basename(b.path)).toBe('s.jsonl');
  });
});

describe("8.1 to 8.6 and 8.12: the bot's exit and deposition lines read each line's state", () => {
  const role = process.env.BOT_PROCESS_ROLE;
  type Manager = ReturnType<typeof getPremiumManager>;

  beforeEach(async () => {
    hooks.confirm = null;
    process.env.BOT_PROCESS_ROLE = 'bot';
    await settleQueue();
    resetPremiumManager();
    reg.current = null;
    clearGlobal();
    freshWriterLock('bot', live);
    takeWriterLock();
  });
  afterEach(async () => {
    hooks.confirm = null;
    resetPremiumManager();
    reg.current = null;
    forgetDeposition();
    if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
    else process.env.BOT_PROCESS_ROLE = role;
  });

  function newProcess(): Manager {
    resetPremiumManager();
    reg.current = null;
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { supportsCancel: true }, isConfigured: () => true,
      handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString())); },
      cancelSubscription: async () => undefined,
    } as any);
    return getPremiumManager();
  }
  const created = (providerSubId: string, guildId = 'g1') => ({
    type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state(),
  });
  const expired = (providerSubId: string, guildId: string) => ({
    type: 'subscription.expired', providerId: 'discord', providerSubId, guildId,
    state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
  });
  const deliver = (event: object) => applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } });
  const exitLines = (pm: Manager): string[] => {
    vi.mocked(console.error).mockClear();
    pm.logLossesAtExit();
    return errors();
  };
  const journalHead = (event: { type: string; providerId: string; providerSubId: string; guildId: string }) =>
    `[PremiumManager] A ${event.type} event from ${event.providerId} (subscription ${event.providerSubId}, guild ${event.guildId}) was received while premium-tiers.json could not be read`;

  /** A bot whose premium-tiers.json cannot be read: each event it gets is journaled. */
  function brokenProcess(): Manager {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = newProcess();
    expect(pm.cacheState()).toBe('unreadable');
    return pm;
  }

  /** A replay whose marks' save landed while its watch still waits: afterDrain queues its audit line. */
  async function replayAwaitingAfterDrain(): Promise<Manager> {
    writePremium({ g1: { active: paidSub('sA', 'ps0', 'low', 'discord'), paused: [] } });
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: expired('ps0', 'g1') })}\n`);
    hooks.confirm = () => new Promise<string>(() => undefined);
    const pm = getPremiumManager();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await flushAll();
    return pm;
  }
  const afterDrainHead = /^\[PremiumManager\] The audit line subscription\.expire\.paid \(guild g1, [^)]+\) /;

  it('8.1 a journal line whose fsync failed, with no tail: the exit says it cannot confirm, not that it is lost', async () => {
    const pm = brokenProcess();
    stub.failSync(JOURNAL, 'EIO');
    const event = created('ps1');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(1);
    const lines = exitLines(pm);
    expect(lines).toEqual([`${journalHead(event)}; the disk did not confirm the sync of its journal line, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
    expect(lines.some(l => l.includes('is lost with this stop'))).toBe(false);
  });

  it('8.2 a second journal line lands after the first one failed: the exit still names the first and not the second', async () => {
    const pm = brokenProcess();
    const hold = stub.holdSync(JOURNAL, 'EIO');
    const first = created('ps1');
    const second = created('ps2', 'g2');
    getPaymentRegistry().emitEvent(first as any);
    await hold.reached;
    getPaymentRegistry().emitEvent(second as any);
    hold.release();
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(2);
    const [a, b] = (pm as any).journal.map((e: { ticket: FileTicket }) => e.ticket);
    expect(a.record).toBe(b.record);
    expect(a.record.landed).toBeGreaterThanOrEqual(a.seq);
    expect(exitLines(pm)).toEqual([`${journalHead(first)}; the disk did not confirm the sync of its journal line, so can't confirm whether it is stored: ${JSON.stringify(first)}`]);
  });

  it('8.3 an install line whose fsync failed stays queued: a redelivery answers 503 and the exit says it cannot confirm', async () => {
    writePremium();
    const pm = newProcess();
    const hold = stub.holdSync(AUDIT, 'EIO');
    const firstReply = deliver(created('ps1'));
    await hold.reached;
    // A later line to the audit file joins the entry as its tail and lands, so the record's landed passes the first.
    getPaymentRegistry().emitEvent(created('ps2', 'g2') as any);
    await vi.waitFor(() => expect(getPending(AUDIT)?.op === 'append' && (getPending(AUDIT) as { content: string }).content.includes('"guildId":"g2"')).toBe(true), { timeout: 5000, interval: 5 });
    hold.release();
    expect(webhookAnswer(await firstReply).status).toBe(503);
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid').map(l => l.guildId)).toEqual(['g1', 'g2']);
    const again = await deliver(created('ps1'));
    expect(again).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'unavailable' });
    expect(webhookAnswer(again).status).toBe(503);
    const install = exitLines(pm).filter(l => l.includes('subscription.install.paid'));
    expect(install).toHaveLength(1);
    expect(install[0].startsWith("[PremiumManager] The audit line subscription.install.paid (guild g1, subscription ps1) is in the file, but the disk did not confirm its sync; can't confirm whether it is stored; the webhook was answered 503")).toBe(true);
  });

  it('8.4 an after-drain audit line whose fsync failed: the exit logs its unconfirmed line, not "did not reach the disk"', async () => {
    const pm = await replayAwaitingAfterDrain();
    stub.failSync(AUDIT, 'EIO');
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    const lines = exitLines(pm);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(afterDrainHead);
    expect(lines[0]).toMatch(/\) is in the file, but the disk did not confirm its sync; can't confirm whether it is stored: \{/);
    expect(lines[0]).not.toContain('did not reach the disk');
  });

  describe('8.5 a write call on the wire reads as being written; an open on the wire as today', () => {
    it.each([
      ['write', true],
      ['open', false],
    ] as const)('a journal line held at its %s', async (_held, atWrite) => {
      const pm = brokenProcess();
      const hold = atWrite ? stub.holdWrite(JOURNAL, true) : stub.holdOpen(JOURNAL);
      const event = created('ps1');
      getPaymentRegistry().emitEvent(event as any);
      await hold.reached;
      expect(exitLines(pm)).toEqual([atWrite
        ? `${journalHead(event)}; its journal line was being written before this stop, so can't confirm whether it is stored: ${JSON.stringify(event)}`
        : `${journalHead(event)} and is lost with this stop: ${JSON.stringify(event)}`]);
      hold.release();
      await settleQueue();
    });

    it.each([
      ['write', true],
      ['open', false],
    ] as const)('a queued install line held at its %s', async (_held, atWrite) => {
      writePremium();
      const pm = newProcess();
      const hold = atWrite ? stub.holdWrite(AUDIT, true) : stub.holdOpen(AUDIT);
      getPaymentRegistry().emitEvent(created('psA') as any);
      await hold.reached;
      const install = exitLines(pm).filter(l => l.includes('subscription.install.paid'));
      expect(install).toHaveLength(1);
      expect(install[0].startsWith(atWrite
        ? "[PremiumManager] The audit line subscription.install.paid (guild g1, subscription psA) was being written before this stop; can't confirm whether it is stored: {"
        : '[PremiumManager] The audit line subscription.install.paid (guild g1, subscription psA) did not reach the disk before this stop and is lost: {')).toBe(true);
      hold.release();
      await settleQueue();
    });

    it.each([
      ['write', true],
      ['open', false],
    ] as const)('an after-drain audit line held at its %s', async (_held, atWrite) => {
      const pm = await replayAwaitingAfterDrain();
      const hold = atWrite ? stub.holdWrite(AUDIT, true) : stub.holdOpen(AUDIT);
      expect(pm.afterDrain()).toBe(true);
      await hold.reached;
      const lines = exitLines(pm);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(afterDrainHead);
      expect(lines[0]).toMatch(atWrite
        ? /\) was being written before this stop; can't confirm whether it is stored: \{/
        : /\) did not reach the disk before this stop and is lost: \{/);
      hold.release();
      await settleQueue();
    });
  });

  it("8.6 a deposition while the audit path holds failed lines and a tail: the unconfirmed line, and each ticket's own answer", async () => {
    const failed = openLedger('interaction');
    const tail = openLedger('interaction');
    const hold = stub.holdSync(AUDIT, 'EIO');
    const line = runInLedger(failed, 'm', () => ticketOf(appendDataTracked('premium-tiers.audit.jsonl', { scope: 'global' }, '{"a":1}\n')));
    await hold.reached;
    // The tail's own tries fail at the open, so it is still queued when the deposition comes.
    stub.rejectOpen(AUDIT, 'EIO', 1000);
    const later = runInLedger(tail, 'm', () => ticketOf(appendDataTracked('premium-tiers.audit.jsonl', { scope: 'global' }, '{"a":2}\n')));
    hold.release();
    await vi.waitFor(() => expect(stub.appendOpens.filter(p => p === AUDIT).length).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 5 });
    await vi.waitFor(() => expect(fileTicketState(line)).toBe('unconfirmed'), { timeout: 5000, interval: 5 });
    expect(queuedFilePaths()).toContain(AUDIT);
    deposeNow();
    await vi.waitFor(() => expect(errors().some(l => l.startsWith(`[Data] Can't confirm whether ${AUDIT} is saved`))).toBe(true), { timeout: 5000, interval: 5 });
    expect(errors().filter(l => l.includes(AUDIT) && (l.startsWith('[Data] Not saved') || l.startsWith("[Data] Can't confirm")))).toEqual([
      `[Data] Can't confirm whether ${AUDIT} is saved (EIO): some of its lines are in the file, but the disk did not confirm them; ${DEPOSED_WORDS}`,
    ]);
    expect(fileTicketState(later)).toBe('open');
    expect(await verdictOf([failed])).toEqual({ ok: false, answer: 'unavailable', partial: false });
    expect(await verdictOf([tail])).toEqual({ ok: false, answer: 'writer-lost', partial: false });
  });

  describe('8.12 a write cut inside its first line, then a deposition before the retry', () => {
    const cutInFirstLine = (text: string) => Math.floor(Buffer.byteLength(text.split('\n')[0]) / 2);
    const cutLine = (p: string) =>
      `[Data] Can't confirm whether ${p} is saved (short write): a write of its lines was cut short, so some of them may be in the file, whole or in part, and the disk did not confirm them; ${DEPOSED_WORDS}`;
    const noInTheFile = (lines: string[]) => expect(lines.filter(l => l.includes('is in the file') || l.includes('some of its lines are in the file'))).toEqual([]);

    async function cutThenDepose(p: string, start: () => void): Promise<void> {
      stub.shortWrite(p, cutInFirstLine);
      start();
      await vi.waitFor(() => expect(stub.writes.some(w => w.path === p)).toBe(true), { timeout: 5000, interval: 2 });
      deposeNow();
      await vi.waitFor(() => expect(errors()).toContain(cutLine(p)), { timeout: 5000, interval: 5 });
      noInTheFile(errors());
    }
    const isCut = (ticket: FileTicket) => {
      expect(fileTicketState(ticket)).toBe('unconfirmed');
      expect(fileTicketFailure(ticket)).toEqual({ errno: 'short write', cut: true });
    };

    it('a journal line', async () => {
      const pm = brokenProcess();
      const event = created('ps1');
      await cutThenDepose(JOURNAL, () => getPaymentRegistry().emitEvent(event as any));
      isCut((pm as any).journal[0].ticket);
      const lines = exitLines(pm);
      expect(lines).toEqual([`${journalHead(event)}; its journal line was being written before another process took the data files, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
      noInTheFile(lines);
    });

    it('a queued install line', async () => {
      writePremium();
      const pm = newProcess();
      await cutThenDepose(AUDIT, () => getPaymentRegistry().emitEvent(created('psA') as any));
      isCut([...(pm as any).installLines.values()][0].ticket);
      const lines = exitLines(pm);
      const install = lines.filter(l => l.includes('subscription.install.paid'));
      expect(install).toHaveLength(1);
      expect(install[0].startsWith("[PremiumManager] The audit line subscription.install.paid (guild g1, subscription psA) was being written before another process took the data files; can't confirm whether it is stored: {")).toBe(true);
      noInTheFile(lines);
    });

    it('an after-drain audit line', async () => {
      const pm = await replayAwaitingAfterDrain();
      await cutThenDepose(AUDIT, () => expect(pm.afterDrain()).toBe(true));
      isCut((pm as any).afterDrainLines[0].ticket);
      const lines = exitLines(pm);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(afterDrainHead);
      expect(lines[0]).toMatch(/\) was being written before another process took the data files; can't confirm whether it is stored: \{/);
      noInTheFile(lines);
    });
  });
});

describe("8.7, 8.13 and 8.14: the web UI chain's answer for lines the disk did not confirm", () => {
  const role = process.env.BOT_PROCESS_ROLE;
  const LEAD = `Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved;`;
  const other = () => dataPath('global', category, 'o.jsonl');

  beforeEach(async () => {
    delete process.env.BOT_PROCESS_ROLE;
    await flushAll();
    freshWriterLock('webui', live);
  });
  afterEach(() => {
    forgetDeposition();
    if (role !== undefined) process.env.BOT_PROCESS_ROLE = role;
  });

  /** A chain op that appends one line to each name and answers as applySharedOp answers, with its writes carried. */
  function appendOp(names: string[], during: (verdict: unknown) => void = () => undefined) {
    return () => runSealed('console', null, null, async ledger => {
      for (const name of names) appendDataTracked(name, opts(), 'X\n');
      const verdict = await verdictOf([ledger]);
      during(verdict);
      const reply = verdict.ok
        ? { ok: true as const, result: true }
        : { ok: false as const, code: 'unconfirmed' as const, answer: verdict.answer, partial: verdict.partial, error: truthText(verdict.answer, verdict.partial), result: true };
      return carryWrites(reply, writesOf(ledger));
    });
  }
  const webLines = () => errors().filter(l => l.startsWith('[Data] Not saved') || (l.startsWith("[Data] Can't confirm") && l.includes('the web UI')));

  it("8.7 a line whose fsync failed with no tail: 503 disk with the can't-confirm text, and no web UI line", async () => {
    stub.failSync(stream(), 'EIO');
    const reply = await new BotManager().runLocalOp('append', appendOp(['s.jsonl']));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: "The disk did not confirm the write of s.jsonl (EIO), so can't confirm whether your change was saved. Check the disk, then reload to check before you try again.",
    });
    expect(webLines()).toEqual([]);
  });

  it('8.7 the same with a second path whose open keeps failing: both named, the other one logged as not saved', async () => {
    stub.failSync(stream(), 'EIO');
    stub.rejectOpen(other(), 'EACCES', 1000);
    const reply = await new BotManager().runLocalOp('append', appendOp(['o.jsonl', 's.jsonl']));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: "The disk did not confirm the write of o.jsonl, s.jsonl (EACCES, EIO), so can't confirm whether your change was saved. Check the disk, then reload to check before you try again.",
    });
    expect(webLines()).toEqual([`[Data] Not saved: ${other()} (EACCES); the web UI dropped its write before releasing the data files' lock`]);
  });

  it('8.7 the first op when the chain is deposed meanwhile: it cannot confirm whether it was saved', async () => {
    stub.failSync(stream(), 'EIO');
    const reply = await new BotManager().runLocalOp('append', appendOp(['s.jsonl'], () => deposeNow()));
    expect(reply).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${LEAD} can't confirm whether it was saved. Reload to check before you try again.` });
  });

  it('8.13 a write cut inside the line, then ENOSPC: held, cancelled as unconfirmed and cut, logged with the cut line', async () => {
    let first = true;
    stub.onWrite(stream(), text => {
      if (!first) return 'ENOSPC';
      first = false;
      return Math.floor(Buffer.byteLength(text) / 2);
    });
    const verdicts: unknown[] = [];
    const reply = await new BotManager().runLocalOp('append', appendOp(['s.jsonl'], v => verdicts.push(v)));
    expect(verdicts).toEqual([{ ok: false, answer: 'held', partial: false }]);
    expect(webLines()).toEqual([
      `[Data] Can't confirm whether ${stream()} is saved (ENOSPC): a write of its lines was cut short, so some of them may be in the file, whole or in part, and the disk did not confirm them; the web UI writes no more of it before releasing the data files' lock`,
    ]);
    expect(reply).toEqual({
      ok: false, status: 503, code: 'disk',
      error: "The disk did not confirm the write of s.jsonl (ENOSPC), so can't confirm whether your change was saved. Check the disk, then reload to check before you try again.",
    });
  });

  describe('8.14 a change that may not be stored, with no deposition', () => {
    const entry = { label: 'x', provider: false, run: async () => undefined, again: async () => undefined, resolve: () => undefined };
    const unknowable = (answer: 'unavailable' | 'held') =>
      carryWrites({ ok: false, code: 'unconfirmed', answer, partial: false, error: 'e' }, { ...NO_WRITES, unknowable: true });

    it.each(['unavailable', 'held'] as const)('(a, b) answer %s, nothing queued: the answer is the reply', async answer => {
      expect(queuedFilePaths()).toEqual([]);
      const reply = unknowable(answer);
      expect(await (new BotManager() as any).landOrCancel(entry, reply)).toBe(reply);
    });

    it('(c) with an append whose open keeps failing: not saved in full, and no saved part claimed', async () => {
      stub.rejectOpen(stream(), 'EIO', 1000);
      appendDataTracked('s.jsonl', opts(), 'X\n');
      await flushAll();
      expect(queuedFilePaths()).toContain(stream());
      expect(await (new BotManager() as any).landOrCancel(entry, unknowable('unavailable'))).toEqual({
        ok: false, status: 503, code: 'disk',
        error: "The disk did not take the write of s.jsonl (EIO), so your change was not saved in full. Check the disk. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.",
      });
    });
  });
});

export type { WriteLedger };
