import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 9, the fixer's regression tests: a cancel whose subscription another op removed and saved
// answers ok after the stop though a later change is held (D1, T1); the deposed local chain words a landed, a partial
// and an unjudged op truthfully (D2); every partial answer ends with partialEnding, held, pending and unavailable
// included, in partialText and in BotManager's stop wording (T3).

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>(), stopping: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const guard = (filename: string, options: any) => {
    const cause = inject.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f, o); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f, o); return real.appendDataTracked(f, o, l); },
    isStopping: () => inject.stopping || real.isStopping(),
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
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { dataPath } from '../../src/utils/dataRoot';
import { BotManager } from '../../src/webui/botManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, partialText, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { cancelQueued, enqueueWrite, fileTicket, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { carryWrites, NO_WRITES, openLedger, runSealed, type OpWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { failFlushes } from '../helpers/configRig';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { clearGlobal, gate, paidSub, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000001066';
const H = '900000000000001067';
const role = process.env.BOT_PROCESS_ROLE;
const RELOAD = 'Reload to see it before you try again: trying again could apply the saved part twice.';
const UNKNOWN = "Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.";

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });

beforeEach(async () => {
  quiet();
  inject.refuse.clear();
  inject.stopping = false;
  delete process.env.BOT_PROCESS_ROLE;
  resetForks();
  freshWriterLock('webui', new Set([process.pid, 77]));
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  inject.refuse.clear();
  inject.stopping = false;
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('a removal that landed is judged by its own save after the stop, not by a later held one (D1, T1)', () => {
  it('answers ok while an unrelated change is held at the stop', async () => {
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => { await cancel.promise; },
    } as any);
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    await runSealed('console', null, null, async () => {
      const pm = getPremiumManager() as any;
      delete pm.config.subscriptions[G];
      pm.save();
    });
    await settleQueue();
    expect(JSON.parse(fs.readFileSync(PREMIUM, 'utf8')).subscriptions[G]).toBeUndefined();
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    await runSealed('console', null, null, async () => {
      const pm = getPremiumManager() as any;
      pm.config.subscriptions[H] = { active: paidSub('sH', 'pH', 'low', 'patreon'), paused: [] };
      pm.save();
    });
    const pm = getPremiumManager() as any;
    expect(pm.saveHeld).toBe(true);
    inject.stopping = true;
    pm.stopped = 'stopping';
    cancel.open();
    const reply: any = await answer;
    pm.stopped = null;
    expect(reply).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(PREMIUM, 'utf8')).subscriptions[G]).toBeUndefined();
  });
});

describe('the deposed local chain, judged by its own tickets and refusals after the wait (D2, NB10-R11-D1, NB10-R11-T1)', () => {
  const entry = { label: 'x', provider: true, run: async () => undefined, again: async () => undefined, resolve: () => undefined };
  const deposed = () => {
    const manager = new BotManager() as any;
    manager.chainDeposed = { role: 'cli', pid: 4242 };
    return manager;
  };
  const dir = dataPath('global', 'nb10fix10');
  const file = (name: string) => `${dir}/${name}`;
  const writes = (tickets: OpWrites['tickets'], more: Partial<OpWrites> = {}): OpWrites => ({ tickets, refused: false, unknowable: false, landedBefore: false, ...more });
  const lead = 'Another process took the data files (another process, pid 4242) while your change was being saved;';

  /** A write that lands on disk; its ticket. */
  async function landedWrite(name: string, body: string) {
    fs.mkdirSync(dir, { recursive: true });
    enqueueWrite(file(name), body);
    const ticket = fileTicket(file(name));
    await settleQueue();
    expect(fs.readFileSync(file(name), 'utf8')).toBe(body);
    return ticket;
  }

  /** A write whose flushes fail until the deposition's freeze drops it; its ticket. */
  async function droppedWrite(name: string) {
    fs.mkdirSync(dir, { recursive: true });
    const undo = failFlushes(file(name));
    try {
      enqueueWrite(file(name), '{"dropped":1}');
      const ticket = fileTicket(file(name));
      await tick(30);
      expect(await cancelQueued([file(name)], undefined, { freeze: true })).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
      return ticket;
    } finally {
      undo();
    }
  }

  it('answers saved when every ticket landed, whatever the reply said of pending or partial', async () => {
    const t = await landedWrite('a.json', '{"a":1}');
    expect(await deposed().landOrCancel(entry, carryWrites({ ok: true, result: 7 }, writes([t])))).toEqual({ ok: true, result: 7 });
    expect(await deposed().landOrCancel(entry, carryWrites({ ok: true, pending: true, note: 'n' }, writes([t])))).toEqual({ ok: true });
    const pending = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'unconfirmed', answer: 'pending', partial: false, error: 'e', result: true }, writes([t])));
    expect(pending).toEqual({ ok: true, result: true });
    const held = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'unconfirmed', answer: 'held', partial: true, error: 'e', result: true }, writes([t])));
    expect(held).toEqual({ ok: true, result: true });
    expect(fs.readFileSync(file('a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('a partial op names the files that landed, from its own tickets', async () => {
    const a = await landedWrite('premium-tiers.json', '{"p":1}');
    const b = await droppedWrite('audit.jsonl');
    const reply = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'unconfirmed', answer: 'writer-lost', partial: true, error: 'e' }, writes([a, b])));
    expect(reply).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: `${lead} it was not saved in full. What was saved: premium-tiers.json. ${RELOAD} ${PROVIDER_SENTENCE}`,
    });
    expect(fs.existsSync(file('audit.jsonl'))).toBe(false);
    expect(queuedFilePaths()).not.toContain(file('audit.jsonl'));
  });

  it('nothing landed and the deposition dropped the rest: nothing was saved, even for a reply that was ok and pending', async () => {
    const t = await droppedWrite('x.json');
    for (const reply of [{ ok: true, pending: true }, { ok: false, code: 'unconfirmed', answer: 'held', partial: false, error: 'e' }]) {
      const answer = await deposed().landOrCancel({ ...entry, provider: false }, carryWrites(reply, writes([t])));
      expect(answer).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} nothing was saved.` });
    }
    expect(fs.existsSync(file('x.json'))).toBe(false);
  });

  it("an op that threw, or whose reply carries no writes, answers can't confirm, never nothing was saved", async () => {
    for (const reply of [{ ok: false, code: 'failed', error: 'boom' }, { ok: true, pending: true }, { ok: true, result: 1 }]) {
      const answer = await deposed().landOrCancel({ ...entry, provider: false }, reply);
      expect(answer.error).toBe(`${lead} can't confirm whether it was saved. Reload to check before you try again.`);
    }
  });

  it("a refusal rewritten whole later, beside a landed write, answers can't confirm in full and names what landed", async () => {
    const t = await landedWrite('b.json', '{"b":1}');
    const answer = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'unconfirmed', answer: 'unavailable', partial: true, error: 'e' }, writes([t], { unknowable: true })));
    expect(answer.error).toBe(`${lead} can't confirm whether it was saved in full. What was saved: b.json. ${RELOAD} ${PROVIDER_SENTENCE}`);
  });

  it('a refused op says nothing was saved', async () => {
    const refused = await deposed().landOrCancel({ ...entry, provider: false }, carryWrites({ ok: false, code: 'unconfirmed', answer: 'writer-lost', partial: false, error: 'e' }, writes([], { refused: true })));
    expect(refused.error).toBe(`${lead} nothing was saved.`);
    const before = await deposed().landOrCancel({ ...entry, provider: false }, carryWrites({ ok: false, code: 'held-elsewhere', error: 'e' }, NO_WRITES));
    expect(before.error).toBe(`${lead} nothing was saved.`);
  });
});

describe('every partial answer ends with partialEnding (T3)', () => {
  it('held, pending and unavailable, worded by the bot process', () => {
    const ledger = openLedger('console');
    for (const answer of ['held', 'pending', 'unavailable'] as const) {
      const text = partialText(truthText(answer, true), ledger);
      expect(text.endsWith(UNKNOWN)).toBe(true);
      expect(text).not.toMatch(/Please/);
    }
    const file = dataPath('global', 'nb10fix10', 'shared.json');
    fs.mkdirSync(dataPath('global', 'nb10fix10'), { recursive: true });
    enqueueWrite(file, '{"a":1}');
    const ticket = fileTicket(file);
    ledger.noteTicket(ticket, 'm');
    (ticket.record as { landed: number }).landed = ticket.seq;
    expect(partialText(truthText('held', true), ledger)).toBe(
      `Your change is not saved in full yet: storage refused it for now, and the bot keeps retrying. What was saved: shared.json. ${RELOAD}`,
    );
  });

  it('held at a restart, in the stopping text', () => {
    inject.stopping = true;
    const text = partialText(truthText('held', true), openLedger('console'));
    expect(text).toBe(`The bot is restarting and could not confirm your change was saved in full; it may be lost. ${UNKNOWN}`);
  });

  it("BotManager's stop wording of a partial held or pending answer keeps the child's ending", () => {
    const manager = new BotManager() as any;
    manager.stopKind = 'stop';
    const child = `Your change is not saved in full yet: storage refused it for now, and the bot keeps retrying. What was saved: premium-tiers.json. ${RELOAD} ${PROVIDER_SENTENCE}`;
    for (const answer of ['held', 'pending']) {
      const reply = manager.wordedByStop('premium.grantManual', { ok: false, code: 'unconfirmed', answer, partial: true, error: child });
      expect(reply.stopWorded).toBe(true);
      expect(reply.error).toBe(`The bot is stopping and could not confirm your change was saved in full; it may be lost. What was saved: premium-tiers.json. ${RELOAD} ${PROVIDER_SENTENCE}`);
    }
    const bare = manager.wordedByStop('global.write', { ok: false, code: 'unconfirmed', answer: 'held', partial: true, error: 'no ending' });
    expect(bare.error).toBe(`The bot is stopping and could not confirm your change was saved in full; it may be lost. ${UNKNOWN}`);
  });
});
