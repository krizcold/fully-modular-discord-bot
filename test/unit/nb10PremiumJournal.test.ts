import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 41 (decision 12): provider events that arrive while premium-tiers.json cannot be read are journaled in
// premium-tiers.events.jsonl, replayed once by the bot after a load and startPremiumTickers(), covered by the per-writer
// marks of eventsApplied, and the journal is deleted once a save carrying the marks landed. The web UI refuses premium
// changes while the journal is pending. A stop during the replay keeps the journal for the next start, and the
// replay's audit lines are written only after its save landed (the gatekeeper's ruling on finding 16).

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push(`${kind}:${guildId}`);
    return { delivered: true, via: 'dm' };
  },
}));
const queued = vi.hoisted(() => ({ ops: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    enqueueAppend: (p: string, line: string) => { real.enqueueAppend(p, line); queued.ops.push(`append ${p} ${line}`); },
    enqueueDelete: (p: string) => { real.enqueueDelete(p); queued.ops.push(`delete ${p}`); },
  };
});

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { markMaintenanceBoot } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { AUDIT, clearGlobal, gate, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
const expired = (providerSubId: string, guildId: string, providerId = 'discord') => ({ type: 'subscription.expired', providerId, providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
const renewed = (providerSubId: string, guildId: string, providerId = 'dummy') => ({ type: 'subscription.renewed', providerId, providerSubId, guildId, state: { ...state(), endDate: later } });
const createdEvent = (providerSubId: string, guildId: string, providerId = 'fake') => ({ type: 'subscription.created', providerId, providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state() });
const subs = () => ({
  g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] },
  g2: { active: paidSub('s2', 'dm1', 'low', 'dummy'), paused: [] },
});
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const manualHigh = () => ({ id: 'm1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' });

let pause = gate();
function registerFake(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString())); },
    pauseSubscription: () => pause.promise,
    cancelSubscription: vi.fn(async () => undefined),
  } as any);
}
const deliver = (event: object) => applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } });

/** A new bot process: a new manager and writer id, then its load. */
function newProcess(): ReturnType<typeof getPremiumManager> {
  resetPremiumManager();
  reg.current = null;
  registerFake();
  return getPremiumManager();
}

async function replayed(pm: ReturnType<typeof getPremiumManager>): Promise<void> {
  await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
  await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
  await settleQueue();
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  clearGlobal();
  pause = gate();
  pause.open();
  asBot(true);
  registerFake();
});
afterEach(async () => {
  pause.open();
  resetPremiumManager();
  reg.current = null;
  fs.rmSync(PREMIUM, { recursive: true, force: true });
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

/** Journals the events in a bot whose premium-tiers.json cannot be read; answers their writer id. */
async function journalWhileBroken(events: object[]): Promise<string> {
  fs.writeFileSync(PREMIUM, '{ broken');
  const pm = newProcess();
  expect(pm.cacheState()).toBe('unreadable');
  for (const event of events) getPaymentRegistry().emitEvent(event as any);
  await settleQueue();
  const lines = linesOf(JOURNAL);
  expect(lines).toHaveLength(events.length);
  return lines[0].writer;
}

describe('the journal and its replay', () => {
  it('two events kept while the file was unreadable are applied once after the fix, the marks cover them and the journal goes', async () => {
    const writer = await journalWhileBroken([expired('d1', 'g1'), renewed('dm1', 'g2')]);
    expect(logged(spies.warn).filter(l => l.includes('it is kept in premium-tiers.events.jsonl'))).toHaveLength(2);
    writePremium(subs());
    const pm = newProcess();
    expect(pm.cacheState()).toBe('replaying');
    const held: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { displayName: 'L', priority: 1, overrides: {}, offerings: [] }] } });
    expect(held.error).toBe('Premium holds provider events received while premium-tiers.json could not be read; the bot applies them once it runs normally and is connected to Discord. Nothing was saved. Try again then.');
    expect(notices.sent).toEqual([]);
    startPremiumTickers();
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.eventsApplied).toEqual({ [writer]: 2 });
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: true });
  });

  it('a journal its marks cover (a crash after the save, before the delete) applies nothing and is deleted', async () => {
    writePremium({ g2: { active: { ...paidSub('s2', 'dm1', 'low', 'dummy'), endDate: later }, paused: [] } }, { eventsApplied: { w1: 2 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')) + journalLine('w1', 2, renewed('dm1', 'g2')));
    const pm = newProcess();
    expect(pm.cacheState()).toBe('normal');
    startPremiumTickers();
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    expect(notices.sent).toEqual([]);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 2 });
  });

  it('a cut last line is logged and skipped; a repeated line is handed once; a second writer has its own mark', async () => {
    writePremium(subs(), { eventsApplied: { w1: 1 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, renewed('dm1', 'g2')) + journalLine('w2', 1, expired('d1', 'g1')) + journalLine('w2', 1, expired('d1', 'g1')) + '{"writer":"w2","n":2,"ev');
    const pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    expect(logged(spies.warn).filter(l => l.startsWith('[PremiumManager] Skipped a line of premium-tiers.events.jsonl that cannot be read'))).toHaveLength(1);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    const saved = jsonOf(PREMIUM);
    expect(saved.eventsApplied).toEqual({ w1: 1, w2: 1 });
    expect(saved.subscriptions.g2.active.endDate).not.toBe(later);
  });

  it('a second episode: new events under a new writer are applied once', async () => {
    const first = await journalWhileBroken([expired('d1', 'g1')]);
    writePremium(subs());
    let pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    const kept = rawOf(PREMIUM)!;
    const second = await journalWhileBroken([renewed('dm1', 'g2')]);
    expect(second).not.toBe(first);
    fs.writeFileSync(PREMIUM, kept);
    pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ [first]: 1, [second]: 1 });
    expect(jsonOf(PREMIUM).subscriptions.g2.active.endDate).toBe(later);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
  });

  it('an entry that throws is logged with its JSON and skipped; the others are applied and premium runs normally', async () => {
    writePremium(subs());
    const bad = { type: 'subscription.renewed', providerId: 'dummy', providerSubId: 'dm1', guildId: 'g2' };
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')) + journalLine('w1', 2, bad) + journalLine('w1', 3, renewed('dm1', 'g2')));
    const pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    expect(logged(spies.error).some(l => l.startsWith('[PremiumManager] The journaled subscription.renewed event from dummy (subscription dm1, guild g2) could not be applied (') && l.includes('and is skipped: {'))).toBe(true);
    expect(jsonOf(PREMIUM).subscriptions.g2.active.endDate).toBe(later);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 3 });
  });

  it('an event that arrives during the replay is journaled and applied after the entries before it', async () => {
    writePremium({ g3: { active: manualHigh(), paused: [] } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, createdEvent('c1', 'g3')));
    pause = gate();
    const pm = newProcess();
    startPremiumTickers();
    await tick(30);
    expect(pm.cacheState()).toBe('replaying');
    getPaymentRegistry().emitEvent(renewed('c1', 'g3', 'fake') as any);
    expect(logged(spies.warn).some(l => l.includes('arrived while premium applies the provider events it kept'))).toBe(true);
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: false, error: expect.stringMatching(/^Premium is applying provider events/) });
    pause.open();
    await replayed(pm);
    const paused = jsonOf(PREMIUM).subscriptions.g3.paused;
    expect(paused).toHaveLength(1);
    expect(paused[0].endDate).toBe(later);
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
  });
});

describe('a stop during the replay', () => {
  it('hands nothing more, logs one line that the journal keeps them, and the next start applies each once', async () => {
    writePremium({ ...subs(), g3: { active: manualHigh(), paused: [] } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, createdEvent('c1', 'g3')) + journalLine('w1', 2, renewed('dm1', 'g2')) + journalLine('w1', 3, expired('d1', 'g1')));
    const journal = rawOf(JOURNAL);
    const before = rawOf(PREMIUM);
    pause = gate();
    let pm = newProcess();
    startPremiumTickers();
    await tick(30);
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.finalStop();
    pause.open();
    await tick(30);
    await settleQueue();
    const beforeExit = logged(spies.error).length;
    pm.logLossesAtExit();
    const exit = logged(spies.error).slice(beforeExit);
    expect(exit).toEqual(['[PremiumManager] The stop came before the kept provider events were saved; they stay in premium-tiers.events.jsonl, and the next normal start of the bot applies them (member notices of the 1 already handed may go out twice)']);
    expect(logged(spies.error).concat(logged(spies.warn)).some(l => /it is lost|lost with this stop|was not written/.test(l))).toBe(false);
    expect(rawOf(JOURNAL)).toBe(journal);
    expect(rawOf(PREMIUM)).toBe(before);
    expect(rawOf(AUDIT)).toBeNull();
    pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g3.paused).toHaveLength(1);
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
  });
});

describe("the replay's audit lines wait for a save carrying its marks", () => {
  const flush = { failing: false };
  beforeEach(() => {
    flush.failing = false;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((file: any, flags?: any, mode?: any) => {
      if (flush.failing && String(file).startsWith(`${PREMIUM}.`) && flags === 'w') {
        return Promise.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' }));
      }
      return open(file, flags, mode);
    }) as any);
  });

  /** Replays J1 (an install) while premium-tiers.json's flushes fail with EIO, so the replay's save stays queued. */
  async function replayWithSaveQueued(): Promise<ReturnType<typeof getPremiumManager>> {
    writePremium();
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, createdEvent('j1', 'g4')));
    const pm = newProcess();
    flush.failing = true;
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect(rawOf(AUDIT)).toBeNull();
    return pm;
  }

  it('a redelivery meanwhile answers not ok and appends nothing; once the save lands the line is appended once', async () => {
    const pm = await replayWithSaveQueued();
    expect(await deliver(createdEvent('j1', 'g4'))).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    await settleQueue();
    expect(rawOf(AUDIT)).toBeNull();
    queued.ops = [];
    flush.failing = false;
    await vi.waitFor(() => expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1), { timeout: 8000, interval: 50 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    const install = queued.ops.findIndex(o => o.startsWith(`append ${AUDIT} `) && o.includes('subscription.install.paid'));
    const journalDelete = queued.ops.indexOf(`delete ${JOURNAL}`);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(journalDelete).toBeGreaterThan(install);
    expect(queued.ops.filter(o => o.startsWith(`append ${AUDIT} `) && o.includes('subscription.install.paid'))).toHaveLength(1);
    expect(await deliver(createdEvent('j1', 'g4'))).toMatchObject({ ok: true });
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
    expect(pm.cacheState()).toBe('normal');
  });

  it('the save lands in the drain after the stop: the lines are queued for one more pass, and nothing is logged', async () => {
    const pm = await replayWithSaveQueued();
    pm.finalStop();
    flush.failing = false;
    await settleQueue();
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 1 });
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  });

  it('the save never lands: no line is appended, the journal stays, and the exit logs the replay line', async () => {
    const pm = await replayWithSaveQueued();
    pm.finalStop();
    await settleQueue();
    expect(pm.afterDrain()).toBe(false);
    await settleQueue();
    expect(rawOf(AUDIT)).toBeNull();
    expect(rawOf(JOURNAL)).not.toBeNull();
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual(['[PremiumManager] The stop came before the kept provider events were saved; they stay in premium-tiers.events.jsonl, and the next normal start of the bot applies them (member notices of the 1 already handed may go out twice)']);
  });
});

describe('the web UI and the journal', () => {
  beforeEach(() => asBot(false));

  it('a pending line refuses premium and payment ops with no provider call; a covered journal does not; an unreadable one names its errno', async () => {
    writePremium(subs(), { eventsApplied: { w1: 1 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')) + journalLine('w1', 2, renewed('dm1', 'g2')));
    const pm = newProcess();
    const refused: any = await applySharedOp({ op: 'premium.cancelPaidSubscription', args: { args: ['g1'] } });
    expect(refused).toMatchObject({ ok: false, code: 'failed', error: 'Premium holds provider events the bot has not applied yet (premium-tiers.events.jsonl); nothing was saved. Start the bot to apply them, then try again.' });
    expect(await deliver(createdEvent('x1', 'g9'))).toMatchObject({ ok: false, code: 'failed' });
    expect(notices.sent).toEqual([]);
    expect(pm.cacheState()).toBe('normal');
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: true });
    await settleQueue();
    expect(rawOf(JOURNAL)).not.toBeNull();
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 1 });
    fs.rmSync(JOURNAL);
    fs.mkdirSync(JOURNAL);
    const unreadable: any = await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'y' }] } });
    expect(unreadable.error).toMatch(/^premium-tiers\.events\.jsonl cannot be read \(E[A-Z]+\)/);
    fs.rmSync(JOURNAL, { recursive: true });
  });

  it('loads a fixed file beside a journal without a replay: no handler, notice or journal write', async () => {
    writePremium(subs());
    const line = journalLine('w1', 1, expired('d1', 'g1'));
    fs.writeFileSync(JOURNAL, line);
    const pm = newProcess();
    await tick(30);
    expect(pm.cacheState()).toBe('normal');
    expect(pm.resolveActiveTier('g1').tierId).toBe('low');
    expect(notices.sent).toEqual([]);
    expect(rawOf(JOURNAL)).toBe(line);
  });
});

// Last: a maintenance boot cannot be undone in this process.
describe('a maintenance boot', () => {
  it('a covered journal is deleted and changes are taken; a pending one waits for the next normal boot', async () => {
    markMaintenanceBoot();
    writePremium(subs(), { eventsApplied: { w1: 1 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    let pm = newProcess();
    startPremiumTickers();
    expect(pm.cacheState()).toBe('normal');
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: true });
    fs.writeFileSync(JOURNAL, journalLine('w1', 2, renewed('dm1', 'g2')));
    pm = newProcess();
    startPremiumTickers();
    await tick(30);
    expect(pm.cacheState()).toBe('replaying');
    expect(notices.sent).toEqual([]);
    expect((await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'y' }] } }) as any).error).toMatch(/^Premium holds provider events/);
    expect(rawOf(JOURNAL)).not.toBeNull();
  });
});
