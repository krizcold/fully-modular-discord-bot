import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 7 (findings NB10-R8-*), the fixer's regression tests: a partial answer to an op sent before
// a stop keeps the child's reload text (D1, O1, T1); a cancel whose subscription another op removed is judged after
// the stop by the state of that op's write (D2, O-D1, T5); a partial answer with no landed write claims no saved part
// (D3, O-D2); the local chain's partial disk answer asks for a reload, not a retry (T4).

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
const fb = vi.hoisted(() => ({ queued: null as string[] | null, cancel: null as unknown[] | null }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    queuedFilePaths: () => fb.queued ?? real.queuedFilePaths(),
    cancelQueued: (...a: Parameters<typeof real.cancelQueued>) => (fb.cancel ? Promise.resolve(fb.cancel as any) : real.cancelQueued(...a)),
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
import { enqueueWrite, fileTicket, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { openLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { failFlushes } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, resetForks, startedWith } from '../helpers/nb10Rig';
import { clearGlobal, gate, paidSub, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000866';
const role = process.env.BOT_PROCESS_ROLE;
const RELOAD = 'Reload to see it before you try again: trying again could apply the saved part twice.';
const UNKNOWN = "Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.";

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });

beforeEach(async () => {
  quiet();
  inject.refuse.clear();
  inject.stopping = false;
  fb.queued = null;
  fb.cancel = null;
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
  fb.queued = null;
  fb.cancel = null;
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe("a partial answer to an op sent before a stop keeps the child's reload text (D1, O1, T1)", () => {
  it('premium.grantManual answered node-stopping in part after a stop', async () => {
    const childText = `The bot is restarting, so your change was not saved in full. What was saved: premium-tiers.json. ${RELOAD} ${PROVIDER_SENTENCE}`;
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    answering(child, async m => {
      if (m.type === 'shared:op') {
        await held;
        return { ok: false, code: 'unconfirmed', answer: 'node-stopping', partial: true, error: childText };
      }
      return undefined;
    });
    const sent = manager.runSharedOp('premium.grantManual', { args: [] });
    await new Promise(resolve => setTimeout(resolve, 10));
    const stopping = manager.shutdown(false);
    release();
    const reply: any = await sent;
    exitChild(child, 0);
    await stopping.catch(() => undefined);
    expect(reply.error).toBe(`The bot is stopping, so your change was not saved in full. What was saved: premium-tiers.json. ${RELOAD} ${PROVIDER_SENTENCE}`);
    expect(reply.error).not.toContain('Save again');
  });
});

describe('a cancel whose subscription another op removed, after the stop (D2, O-D1, T5)', () => {
  const cancelling = () => {
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => { await cancel.promise; },
    } as any);
    return cancel;
  };
  // The final premium step sets stopped inside the process's stop, after the stop began.
  const stop = (pm: any) => { inject.stopping = true; pm.stopped = 'stopping'; };
  const removeElsewhere = () => runSealed('console', null, null, async () => {
    const pm = getPremiumManager() as any;
    delete pm.config.subscriptions[G];
    pm.save();
  });

  it("answers not saved when that op's save is held at the stop", async () => {
    const cancel = cancelling();
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    await removeElsewhere();
    const pm = getPremiumManager() as any;
    expect(pm.saveHeld).toBe(true);
    expect(JSON.parse(pm.lastRaw).subscriptions[G].active.id).toBe('sA');
    expect(JSON.parse(fs.readFileSync(PREMIUM, 'utf8')).subscriptions[G].active.id).toBe('sA');
    stop(pm);
    cancel.open();
    const reply: any = await answer;
    pm.stopped = null;
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'node-stopping' });
    expect(reply.error).toContain(PROVIDER_SENTENCE);
  });

  it("waits on that op's queued save and does not answer ok while the disk refuses it", async () => {
    const cancel = cancelling();
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    const undo = failFlushes(PREMIUM);
    try {
      await removeElsewhere();
      const pm = getPremiumManager() as any;
      stop(pm);
      cancel.open();
      const reply: any = await answer;
      pm.stopped = null;
      expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
      expect(reply.error).toContain('The bot is restarting and could not confirm your change was saved; it may be lost.');
      expect(reply.error).not.toContain('keeps retrying');
      expect(reply.error).not.toContain('was not saved.');
      expect(reply.error).toContain(PROVIDER_SENTENCE);
      expect(JSON.parse(fs.readFileSync(PREMIUM, 'utf8')).subscriptions[G].active.id).toBe('sA');
    } finally {
      undo();
    }
  }, 20_000);

  it('answers ok when that save had landed before the stop', async () => {
    const cancel = cancelling();
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    await removeElsewhere();
    await settleQueue();
    expect(queuedFilePaths()).not.toContain(PREMIUM);
    expect(JSON.parse(fs.readFileSync(PREMIUM, 'utf8')).subscriptions[G]).toBeUndefined();
    const pm = getPremiumManager() as any;
    stop(pm);
    cancel.open();
    const reply: any = await answer;
    pm.stopped = null;
    expect(reply).toMatchObject({ ok: true });
  });

  it('answers ok only once that save, still queued at the stop, landed', async () => {
    const cancel = cancelling();
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === PREMIUM) await new Promise(resolve => setTimeout(resolve, 300));
      return rename(from, to);
    }) as typeof fs.promises.rename);
    await removeElsewhere();
    expect(queuedFilePaths()).toContain(PREMIUM);
    const pm = getPremiumManager() as any;
    stop(pm);
    cancel.open();
    const { reply, raw } = await answer.then(r => ({ reply: r as any, raw: fs.readFileSync(PREMIUM, 'utf8') }));
    pm.stopped = null;
    expect(reply).toMatchObject({ ok: true });
    expect(JSON.parse(raw).subscriptions[G]).toBeUndefined();
  });
});

describe('a partial answer with no landed write claims no saved part (D3, O-D2)', () => {
  it('an unlanded ticket gives the can-not-confirm ending; a landed one is named', () => {
    const file = dataPath('global', 'nb10fix8', 'shared.json');
    fs.mkdirSync(dataPath('global', 'nb10fix8'), { recursive: true });
    enqueueWrite(file, '{"a":1}');
    const ticket = fileTicket(file);
    const ledger = openLedger('console');
    ledger.noteTicket(ticket, 'm');
    const head = 'The bot is restarting, so your change was not saved in full.';
    expect(partialText(truthText('node-stopping', true), ledger)).toBe(`${head} ${UNKNOWN}`);
    expect(partialText(truthText('node-stopping', true), ledger)).not.toContain('Part of it was saved');
    (ticket.record as { landed: number }).landed = ticket.seq;
    expect(partialText(truthText('node-stopping', true), ledger)).toBe(`${head} What was saved: shared.json. ${RELOAD}`);
  });
});

describe("the local chain's partial disk answer asks for a reload (T4)", () => {
  const entry = { label: 'x', provider: true, run: async () => undefined, again: async () => undefined, resolve: () => undefined };

  it('names the landed file and asks for no retry', async () => {
    const landing = dataPath('global', 'nb10fix8', 'landing.json');
    const refused = dataPath('global', 'nb10fix8', 'refused.json');
    fb.queued = [landing, refused];
    fb.cancel = [{ path: landing, outcome: 'landed' }, { path: refused, outcome: 'cancelled', errno: 'ENOSPC' }];
    const reply = await (new BotManager() as any).landOrCancel(entry, { ok: true, result: true });
    expect(reply).toMatchObject({ ok: false, code: 'disk' });
    expect(reply.error).toBe(`The disk did not take the write of refused.json (ENOSPC), so your change was not saved in full. Check the disk. What was saved: landing.json. ${RELOAD} ${PROVIDER_SENTENCE}`);
    expect(reply.error).not.toContain('then try again');
  });

  it('a partial reply with no path landed here claims no saved part', async () => {
    const refused = dataPath('global', 'nb10fix8', 'refused.json');
    fb.queued = [refused];
    fb.cancel = [{ path: refused, outcome: 'cancelled', errno: 'ENOSPC' }];
    const reply = await (new BotManager() as any).landOrCancel(entry, { ok: false, code: 'unconfirmed', answer: 'held', partial: true });
    expect(reply.error).toBe(`The disk did not take the write of refused.json (ENOSPC), so your change was not saved in full. Check the disk. ${UNKNOWN} ${PROVIDER_SENTENCE}`);
  });

  it('a change with nothing saved still asks for a retry', async () => {
    const refused = dataPath('global', 'nb10fix8', 'refused.json');
    fb.queued = [refused];
    fb.cancel = [{ path: refused, outcome: 'cancelled', errno: 'ENOSPC' }];
    const reply = await (new BotManager() as any).landOrCancel({ ...entry, provider: false }, { ok: true, result: true });
    expect(reply.error).toBe('The disk did not take the write of refused.json (ENOSPC), so your change was not saved. Check the disk, then try again.');
  });
});
