import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 6 (findings NB10-R7-*), the fixer's regression tests: an install line refused after the stop
// keeps its webhook ending (D1); a cancel whose subscription another op removed is judged by a save of its own (D2,
// O2); a ticket that landed counts toward "not saved in full" after a deposition (D3, O3); due migrations are read
// again before each one is applied, and a stop ends the run (O1, O4); a partial answer names what was saved and asks
// for a reload, not a retry (the gatekeeper's ruling).

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>() }));
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
import { getPremiumManager, MigrationBusy, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, partialEnding, partialText } from '../../src/bot/internalSetup/utils/sharedOps';
import { truthText, verdictOf, type TruthAnswer } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { cancelQueued, enqueueWrite, fileTicket } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { openLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { sharedOpFailure } from '../../src/webui/routes/hopFailure';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, gate, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000766';
const G2 = '900000000000000767';
const role = process.env.BOT_PROCESS_ROLE;
const BUSY = 'This migration is being applied right now, so nothing was changed. Its outcome shows here when the run ends; reload later to see it.';

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });

let spies: ReturnType<typeof quiet>;
beforeEach(async () => {
  spies = quiet();
  inject.refuse.clear();
  delete process.env.BOT_PROCESS_ROLE;
  resetForks();
  freshWriterLock('webui', new Set([process.pid, 77]));
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  inject.refuse.clear();
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('an install line refused after the stop (D1)', () => {
  const installLine = (webhook: boolean) => {
    const entry = { timestamp: new Date().toISOString(), actor: 'provider', action: 'subscription.install.paid', guildId: G, subscriptionId: 'sW' };
    return { line: `${JSON.stringify(entry)}\n`, entry, install: { state: 'queued', webhook, line: `${JSON.stringify(entry)}\n`, entry, providerSubId: 'pW' } };
  };

  it("a webhook's line is logged with the redelivery ending, never as lost", () => {
    const pm = getPremiumManager() as any;
    pm.installLines.set('sW', installLine(true).install);
    pm.stopped = 'stopping';
    pm.placeLine(installLine(true));
    pm.stopped = null;
    const lines = logged(spies.error);
    expect(lines.some(l => l.includes('it is lost'))).toBe(false);
    expect(lines.filter(l => l.includes("the webhook was answered 503, and the provider's next delivery of it writes this line"))).toHaveLength(1);
    expect(pm.installLines.has('sW')).toBe(false);
  });

  it("a line that no provider delivers again is logged as lost", () => {
    const pm = getPremiumManager() as any;
    pm.stopped = 'deposed';
    pm.placeLine(installLine(false));
    pm.stopped = null;
    expect(logged(spies.error).filter(l => l.includes('was not written before another process took the data files and is lost'))).toHaveLength(1);
  });
});

describe('expire now whose subscription another op removed during the provider call (D2, O2)', () => {
  it("answers held when that op's save is held, and ok once the disk took the save", async () => {
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => { await cancel.promise; },
    } as any);
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    const other = await runSealed('console', null, null, async ledger => {
      const pm = getPremiumManager() as any;
      delete pm.config.subscriptions[G];
      pm.save();
      return verdictOf([ledger]);
    });
    expect(other).toMatchObject({ ok: false, answer: 'held' });
    cancel.open();
    const reply: any = await answer;
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(sharedOpFailure(reply)).not.toBeNull();
    expect(reply.error).toContain('the bot keeps retrying');
    inject.refuse.clear();
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions[G]).toBeUndefined(), { timeout: 5000, interval: 50 });
  });
});

describe('a landed ticket after a deposition counts toward not saved in full (D3, O3)', () => {
  it('a refused op with a landed write answers partial; one whose only write was cancelled does not', async () => {
    const file = dataPath('global', 'nb10fix7', 'shared.json');
    fs.mkdirSync(dataPath('global', 'nb10fix7'), { recursive: true });
    enqueueWrite(file, '{"a":1}');
    const first = fileTicket(file);
    enqueueWrite(file, '{"a":2}');
    const second = fileTicket(file);
    expect(second.record).toBe(first.record);
    (first.record as { landed: number }).landed = first.seq;
    await cancelQueued([file], undefined, { freeze: true });

    const withLanded = openLedger('console');
    withLanded.noteTicket(first, 'm');
    withLanded.noteRefusal('writer-lost', 'm', 'global:/other.json');
    expect(await verdictOf([withLanded])).toEqual({ ok: false, answer: 'writer-lost', partial: true });

    const cancelledOnly = openLedger('console');
    cancelledOnly.noteTicket(second, 'm');
    cancelledOnly.noteRefusal('writer-lost', 'm', 'global:/other.json');
    expect(await verdictOf([cancelledOnly])).toEqual({ ok: false, answer: 'writer-lost', partial: false });
  });
});

type MigrateProvider = { migrates: string[]; cancels: string[]; open: (id: string) => void };

function migrateProvider(): MigrateProvider {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const of = (id: string) => {
    if (!gates.has(id)) gates.set(id, gate());
    return gates.get(id)!;
  };
  const p: MigrateProvider = { migrates: [], cancels: [], open: id => of(id).open(undefined) };
  getPaymentRegistry().register({
    id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
    cancelSubscription: async (id: string) => { p.cancels.push(id); },
    pauseSubscription: async () => undefined,
    migrateSubscriptionPrice: async (id: string) => { p.migrates.push(id); await of(id).promise; },
  } as any);
  return p;
}

function migration(id: string, decisions: unknown[]) {
  return {
    id, providerId: 'patreon', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'low', targetOfferingId: 'o1', targetVariantId: 'v2', effectiveDate: new Date(Date.now() - 1000).toISOString(),
    message: '', scheduledAt: new Date().toISOString(), scheduledBy: 'admin', status: 'pending', decisions,
  };
}

const silent = (guildId: string, subscriptionId: string, providerSubId: string) =>
  ({ guildId, subscriptionId, providerSubId, decision: 'pending', notifiedAt: new Date().toISOString() });

const onV1 = (id: string, providerSubId: string) => ({ ...paidSub(id, providerSubId, 'low', 'patreon'), variantId: 'v1' });

describe('due migrations are read again before each one, and a stop ends the run (O1, O4)', () => {
  it('a migration cancelled while an earlier one runs stays cancelled, and none of its subscribers is called', async () => {
    writePremium(
      { [G]: { active: onV1('s1', 'p1'), paused: [] }, [G2]: { active: onV1('s2', 'p2'), paused: [] } },
      { migrationSilencePolicy: 'continue', migrations: [migration('m1', [silent(G, 's1', 'p1')]), migration('m2', [silent(G2, 's2', 'p2')])] },
    );
    const provider = migrateProvider();
    const run = getPremiumManager().processDueMigrations();
    await tick();
    expect(provider.migrates).toEqual(['p1']);
    const busy: any = await op('premium.cancelMigration', 'm1');
    expect(busy).toEqual({ ok: false, code: 'changed', error: BUSY });
    expect(new MigrationBusy().message).toBe(BUSY);
    expect(await op('premium.cancelMigration', 'm2')).toEqual({ ok: true, result: true });
    provider.open('p1');
    provider.open('p2');
    await run;
    await settleQueue();
    expect(provider.migrates).toEqual(['p1']);
    expect(provider.cancels).toEqual([]);
    const stored = jsonOf(PREMIUM);
    expect(stored.migrations.map((m: any) => [m.id, m.status])).toEqual([['m1', 'applied'], ['m2', 'cancelled']]);
    expect(stored.subscriptions[G2].active.variantId).toBe('v1');
    expect(linesOf(AUDIT).filter(l => l.action === 'migration.applied').map(l => l.migrationId)).toEqual(['m1']);
  });

  it('a stop during a run makes no further provider call and does not mark the migration applied', async () => {
    writePremium(
      { [G]: { active: onV1('s1', 'p1'), paused: [] }, [G2]: { active: onV1('s2', 'p2'), paused: [] } },
      { migrationSilencePolicy: 'continue', migrations: [migration('m1', [silent(G, 's1', 'p1'), silent(G2, 's2', 'p2')])] },
    );
    const provider = migrateProvider();
    const pm = getPremiumManager() as any;
    const run = pm.processDueMigrations();
    await tick();
    expect(provider.migrates).toEqual(['p1']);
    pm.stopped = 'stopping';
    provider.open('p1');
    provider.open('p2');
    await run;
    expect(provider.migrates).toEqual(['p1']);
    expect(pm.config.migrations[0].status).toBe('pending');
    pm.stopped = null;
    await settleQueue();
    expect(jsonOf(PREMIUM).migrations[0].status).toBe('pending');
  });
});

describe('a partial answer names what was saved and asks for a reload (ruling)', () => {
  // NB6 decision 63 (sheet 2606-2608): the grant's line and notice go out with the save before the pause, so the stop
  // during the pause leaves nothing unsaved and the op answers ok (NB10 answered partial, its grant line written after
  // the pause). The partial texts stay pinned by the next row.
  it('a grant stopped during the pause answers ok: its save before the pause stored the grant and both lines', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const pause = gate();
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
      cancelSubscription: async () => undefined,
      pauseSubscription: async () => { await pause.promise; },
    } as any);
    const answer = op('premium.grantManual', G, 'high', 5);
    await tick();
    await settleQueue();
    (getPremiumManager() as any).stopped = 'stopping';
    pause.open();
    const reply: any = await answer;
    (getPremiumManager() as any).stopped = null;
    expect(reply).toMatchObject({ ok: true, result: true });
    expect(reply.error).toBeUndefined();
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[G].active.source).toBe('manual');
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.pause']);
  });

  it('ends every partial answer with the reload sentence, held, pending and unavailable included (NB10-R10-T3)', () => {
    const ledger = openLedger('console');
    const answers: TruthAnswer[] = [
      'pending', 'held', 'deposed', 'unavailable', 'frozen', 'not-ready', 'io', 'writer-lost', 'database-unreachable',
      'database-backlog', 'guild-fenced', 'node-stopping', 'storage-failing', 'maintenance',
    ];
    for (const answer of answers) {
      const text = partialText(truthText(answer, true), ledger);
      expect(text.endsWith(` ${partialEnding([])}`), `${answer}: ${text}`).toBe(true);
      expect(text, answer).not.toMatch(/Please try again|then try again/);
      expect(text, answer).not.toContain('What was saved');
    }
    expect(partialText(truthText('held', true), ledger).startsWith('Your change is not saved in full yet: storage refused it for now')).toBe(true);
    const file = dataPath('global', 'nb10fix7', 'landed.json');
    fs.mkdirSync(dataPath('global', 'nb10fix7'), { recursive: true });
    enqueueWrite(file, '{"a":1}');
    const ticket = fileTicket(file);
    (ticket.record as { landed: number }).landed = ticket.seq;
    const saved = openLedger('console');
    saved.noteTicket(ticket, 'm');
    for (const answer of answers) {
      expect(partialText(truthText(answer, true), saved).endsWith(` ${partialEnding(['landed.json'])}`), answer).toBe(true);
    }
    expect(partialText(truthText('io', true), ledger)).toBe(
      "The bot could not write to storage, so your change was not saved in full. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.",
    );
    expect(partialText(truthText('io', true), ledger)).not.toContain('Part of it was saved');
  });
});
