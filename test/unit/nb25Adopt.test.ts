import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_KEY, JOURNAL_KEY, PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, dummyRig, dummyTier } from '../helpers/nb6DummyRig';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { freshWriterLock } from '../helpers/nb10Rig';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';

// NB25 (wip-redesign/sheets/NB25.md, section 8 item 1): an adopted paused subscription resumes at its provider before
// premium saves it active, with the days it had left; the plan the card showed is the one applied; every await of the
// adoption is followed by the stop check, a refresh of premium's row and the entry check; a landed resume that cannot
// be installed is paused again (T7). The real PremiumManager over the scripted shared tables (a Postgres bot), with a
// fake provider 'fake' whose list, resume and pause the test drives.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const inject = vi.hoisted(() => ({ premium: [] as Array<{ cause: string }>, stopping: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  return {
    ...real,
    isStopping: () => inject.stopping || real.isStopping(),
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const refuse = f === 'premium-tiers.json' && inject.premium.length > 0 ? inject.premium.shift() : null;
      if (refuse) {
        ledger.recordRefusal(refuse.cause as any, `global:${o.category ?? ''}/${f}`);
        return { outcome: 'refused', cause: refuse.cause };
      }
      return real.saveDataTracked(f, o, d);
    },
  };
});
type Refresh = { ok: true } | { ok: false; cause: string; local?: true };
type PassEnd = (e: Promise<void>) => void;
const mirror = vi.hoisted(() => ({ calls: 0, steps: [] as Array<((real: () => Promise<Refresh>, end: PassEnd) => Promise<Refresh>) | null> }));
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    refreshShared: (keys: string[] | null, end?: (e: Promise<void>) => void) => {
      if (Array.isArray(keys) && keys.length === 1 && keys[0] === 'global/premium-tiers.json') {
        mirror.calls += 1;
        const step = mirror.steps.shift();
        if (step) return step(() => real.refreshShared(keys, end), e => end?.(e));
      }
      return real.refreshShared(keys, end);
    },
  };
});

const r = premiumRig();
const d = dummyRig(r);
const OTHER = 424242;
const AT = '2026-11-01T00:00:00.000Z';

type Gate<T = unknown> = { promise: Promise<T>; open: (value?: T) => void };
function gate<T = unknown>(): Gate<T> {
  let open!: (value?: T) => void;
  const promise = new Promise<T>(resolve => { open = value => resolve(value as T); });
  return { promise, open };
}

const fake = {
  refs: [] as any[],
  list: null as Gate | null,
  holdResumes: false,
  resumeGates: [] as Array<Gate>,
  resumeError: null as Error | null,
  pauseError: null as Error | null,
  resumes: [] as Array<{ id: string; end: string | null; l0: boolean; row: string | null }>,
  pauses: [] as Array<[string, string | null, number | null | undefined]>,
};

const NAMES: Record<string, string> = { fake: 'Fake', fake2: 'Fake Two', fake3: 'Fake Three' };
function register(id = 'fake', withResume = true, supportsPause = true): void {
  getPaymentRegistry().register({
    id, displayName: NAMES[id], capabilities: { supportsPause }, isConfigured: () => true,
    listSubscriptionsForGuild: async (guildId: string) => {
      if (fake.list) await fake.list.promise;
      return fake.refs.filter(ref => ref.metadata.guildId === guildId && (ref.provider ?? 'fake') === id).map(ref => JSON.parse(JSON.stringify(ref)));
    },
    ...(withResume ? {
      resumeSubscription: async (subId: string, end: string | null) => {
        fake.resumes.push({ id: subId, end, l0: r.m.state.lines.some(l => l.includes('Adoption is resuming')), row: rowText() });
        if (fake.holdResumes) {
          const g = gate();
          fake.resumeGates.push(g);
          await g.promise;
        }
        if (fake.resumeError) throw fake.resumeError;
      },
    } : {}),
    pauseSubscription: async (subId: string, resumesAt: string | null, days?: number | null) => {
      fake.pauses.push([subId, resumesAt, days]);
      if (fake.pauseError) throw fake.pauseError;
    },
  } as any);
}

const rowText = (): string | null => {
  const row = r.m.state.rows.docs.get(PREMIUM_KEY);
  return row ? row.body.toString('utf8') : null;
};

const pausedRef = (over: { tierId?: string; offeringId?: string; days?: number | null; end?: number; autoRenew?: boolean; resumable?: false; guildId?: string; id?: string; provider?: string } = {}) => ({
  providerSubId: over.id ?? 'orph',
  provider: over.provider,
  metadata: {
    guildId: over.guildId ?? 'g1', tierId: over.tierId ?? 'silver', offeringId: over.offeringId ?? (over.tierId === 'gold' ? 'o1' : 'o2'),
    ...(over.days === null ? {} : { pausedDaysLeft: over.days ?? 12, pausedAt: AT }),
  },
  state: {
    status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + (over.end ?? 2 * DAY_MS)).toISOString(),
    autoRenew: over.autoRenew ?? true, ...(over.resumable === false ? { resumable: false } : {}),
  },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
});
const activeRef = (tierId = 'silver') => ({
  ...pausedRef({ tierId, days: null }),
  state: { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 20 * DAY_MS).toISOString(), autoRenew: true },
});

/** A paid subscription of the fake provider as premium-tiers.json stores it. */
const paid = (providerSubId: string, tierId: string, endMs = 20 * DAY_MS) => ({
  id: `s_${providerSubId}`, tierId, source: 'paid', offeringId: tierId === 'gold' ? 'o1' : 'o2', providerId: 'fake', providerSubId,
  purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: tierId, tierPriority: 1, purchasedAt: new Date().toISOString() },
  startDate: new Date().toISOString(), endDate: new Date(Date.now() + endMs).toISOString(), autoRenew: true, status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
async function seed(guildId: string, subs: { active?: unknown; paused?: unknown[] }): Promise<void> {
  await d.otherPremium(config => { config.subscriptions[guildId] = { paused: [], ...subs }; });
}

const planOf = async (guildId = 'g1', id = 'orph') => (await r.pm().findOrphansForGuild(guildId)).find(o => o.ref.providerSubId === id)?.plan;
const adopt = (shown: unknown, id = 'orph', guildId = 'g1', providerId = 'fake') => r.pm().adoptOrphan(guildId, providerId, id, shown);
const adoptOp = (shown: unknown, id = 'orph') => applySharedOp({ op: 'premium.adoptOrphan', args: { args: ['g1', 'fake', id, shown] } });
const active = (guildId = 'g1') => r.row()?.subscriptions?.[guildId]?.active;
const adoptLines = () => r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.adopt.orphan');
const logged = (text: string) => r.m.state.lines.filter(l => l.includes(text));
const near = (iso: string | null | undefined, ms: number) => expect(Math.abs(Date.parse(iso as string) - (Date.now() + ms))).toBeLessThan(10_000);
const until = async (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 5000, interval: 5 });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const track = (p: Promise<unknown>) => {
  const s = { done: false };
  p.then(() => { s.done = true; }, () => { s.done = true; });
  return s;
};
/** A refresh answer whose pass is still running, as the real refreshShared hands it over: the pass ends when its gate opens. */
const unended = (passes: Gate[], answer: Refresh) => async (_real: () => Promise<Refresh>, end: PassEnd): Promise<Refresh> => {
  const g = gate();
  passes.push(g);
  end(g.promise.then(() => undefined));
  return answer;
};
const T7_TIE ="Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: the server now holds a 'Silver' subscription of equal or higher priority.";
const P1 = ' It was paused again at Fake.';

async function boot(bot: boolean, lock = false): Promise<void> {
  await d.setup(bot);
  register();
  fake.refs = [pausedRef()];
  fake.list = null;
  fake.holdResumes = false;
  fake.resumeGates = [];
  fake.resumeError = null;
  fake.pauseError = null;
  fake.resumes = [];
  fake.pauses = [];
  inject.premium.length = 0;
  inject.stopping = false;
  mirror.calls = 0;
  mirror.steps = [];
  if (lock) {
    freshWriterLock(bot ? 'bot' : 'webui', new Set([process.pid, OTHER]));
    expect(takeWriterLock().kind).toBe('taken');
  }
}
async function down(): Promise<void> {
  inject.stopping = false;
  fake.list?.open();
  for (const g of fake.resumeGates) g.open();
  while (writerLockDepth() > 0) releaseWriterLock();
  // A fresh take forgets a deposition this process saw.
  freshWriterLock('webui');
  takeWriterLock();
  releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  getPaymentRegistry().unregister('fake');
  getPaymentRegistry().unregister('fake2');
  getPaymentRegistry().unregister('fake3');
  await d.teardown();
}
const deposeByOther = () => fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));

describe('a paused orphan with no live active sub', () => {
  beforeEach(() => boot(true));
  afterEach(down);

  it('resumes it with the recorded 12 days, L0 before the call, and saves it active with that end; L1 after', async () => {
    const plan = await planOf();
    expect(await adopt(plan)).toBe(true);
    await d.settle();
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0]).toMatchObject({ id: 'orph', l0: true });
    near(fake.resumes[0].end, 12 * DAY_MS);
    expect(logged('[PremiumManager] Adoption is resuming Fake subscription orph for guild g1 with 12 days left.')).toHaveLength(1);
    expect(active()).toMatchObject({ providerSubId: 'orph', status: 'active', endDate: fake.resumes[0].end });
    expect(r.pm().resolveActiveTier('g1').tierId).toBe('silver');
    expect(logged('[PremiumManager] Adoption resumed Fake subscription orph for guild g1 with 12 days left; the bot may not have saved it yet.')).toHaveLength(1);
    expect(adoptLines().at(-1)?.metadata).toMatchObject({ providerSubId: 'orph', resumed: true });
    expect(fake.pauses).toEqual([]);
  });

  it('with no recorded days the end is 2 days ahead, from the billing period', async () => {
    fake.refs = [pausedRef({ days: null })];
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 2, from: 'period' });
    expect(await adopt(plan)).toBe(true);
    near(fake.resumes[0].end, 2 * DAY_MS);
  });

  it('the resume throws: T3 with the error and the provider sentence; nothing saved; still listed; no L1', async () => {
    fake.resumeError = new Error('card declined');
    const plan = await planOf();
    const before = rowText();
    const reply = await adoptOp(plan);
    expect(reply).toMatchObject({ ok: false });
    expect((reply as any).error).toBe(`Subscription 'orph' was not adopted: the resume call to Fake failed (card declined). ${PROVIDER_SENTENCE}`);
    await d.settle();
    expect(rowText()).toBe(before);
    expect(adoptLines()).toEqual([]);
    expect(await planOf()).toMatchObject({ kind: 'resume' });
    expect(logged('Adoption resumed')).toEqual([]);
  });

  it('while the resume is open the row is unchanged and no adoption line is stored', async () => {
    fake.holdResumes = true;
    const plan = await planOf();
    const before = rowText();
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await d.settle();
    expect(rowText()).toBe(before);
    expect(adoptLines()).toEqual([]);
    fake.resumeGates[0].open();
    expect(await run).toBe(true);
  });

  it('the period end passes during the resume: the days sent stand and the adoption installs', async () => {
    fake.refs = [pausedRef({ days: null, end: 1000 })];
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 1, from: 'period' });
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    near(fake.resumes[0].end, DAY_MS);
    vi.setSystemTime(Date.now() + 2000);
    fake.resumeGates[0].open();
    expect(await run).toBe(true);
    await d.settle();
    expect(active()).toMatchObject({ providerSubId: 'orph', status: 'active', endDate: fake.resumes[0].end });
    near(active().endDate, DAY_MS);
    expect(fake.pauses).toEqual([]);
  });

  it('the save is refused after the resume: the verdict and the provider sentence; no re-pause; the lines marked; L1', async () => {
    const plan = await planOf();
    await d.settle();
    const before = rowText();
    inject.premium.push({ cause: 'unstorable' });
    const reply = await adoptOp(plan);
    await d.settle();
    expect(reply).toMatchObject({ ok: false });
    expect((reply as any).error).toBe(`${truthText('unstorable', false)} ${PROVIDER_SENTENCE}`);
    expect(fake.resumes).toHaveLength(1);
    expect(fake.pauses).toEqual([]);
    expect(rowText()).toBe(before);
    const marked = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.adopt.orphan' || l.action === 'subscription.install.paid');
    expect(marked.map(l => [l.action, l.metadata.notSaved?.cause])).toEqual([['subscription.adopt.orphan', 'unstorable'], ['subscription.install.paid', 'unstorable']]);
    expect(logged('Adoption resumed Fake subscription orph')).toHaveLength(1);
  });

  it.each([
    ['a tie', async () => { await r.pm().grantManual('g1', 'silver', 30); }, T7_TIE],
    ['a higher sub', async () => { await r.pm().grantManual('g1', 'gold', 30); }, "Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: the server now holds a 'Gold' subscription of equal or higher priority."],
    ['the tier deleted', async () => { r.pm().deleteTier('silver'); }, "Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: tier 'silver' does not exist."],
    ['the offering deleted', async () => { r.pm().setTier('silver', dummyTier('Silver', 1, 'o9') as any); }, "Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: tier 'silver' has no offering 'o2'."],
  ])('during the resume, %s: paused again with the days, T7 and P1; nothing saved by the adoption', async (_name, during, text) => {
    const plan = await planOf();
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await during();
    await d.settle();
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow(`${text}${P1}`);
    expect(fake.pauses).toEqual([['orph', null, 12]]);
    await d.settle();
    expect(adoptLines()).toEqual([]);
    expect(active()?.providerSubId).not.toBe('orph');
  });

  it('premium turns unreadable during the resume: paused again with the days, T7 with "premium cannot take changes right now" and P1', async () => {
    const plan = await planOf();
    await d.settle();
    const good = rowText()!;
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    r.m.state.rows.put(PREMIUM_KEY, '{ not json');
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow(`Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: premium cannot take changes right now.${P1}`);
    expect(fake.pauses).toEqual([['orph', null, 12]]);
    expect(rowText()).toBe('{ not json');
    expect(r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.adopt.orphan')).toEqual([]);
    r.m.state.rows.put(PREMIUM_KEY, good);
    await runSharedPass();
  });

  it('premium recovers into its replay during the resume: paused again with the days, T7 with "premium cannot take changes right now" and P1', async () => {
    const plan = await planOf();
    await d.settle();
    const good = rowText()!;
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    r.m.state.rows.put(PREMIUM_KEY, '{ not json');
    await runSharedPass();
    r.pm().getAllTiers();
    expect(r.pm().cacheState()).toBe('unreadable');
    const line = { writer: 'p-dead', node: 'node-bravo', nodeName: 'BRAVO', n: 1, event: { type: 'subscription.paused', providerId: 'fake', providerSubId: 'other1', guildId: 'g2', resumesAt: '2027-01-01T00:00:00.000Z' } };
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify(line));
    r.m.state.rows.put(PREMIUM_KEY, good);
    await runSharedPass();
    r.pm().getAllTiers();
    expect(r.pm().cacheState()).toBe('replaying');
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow(`Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: premium cannot take changes right now.${P1}`);
    expect(fake.pauses).toEqual([['orph', null, 12]]);
    await d.settle();
    expect(rowText()).toBe(good);
    expect(r.row().subscriptions?.g1?.active).toBeUndefined();
    expect(adoptLines()).toEqual([]);
    expect(r.lines(JOURNAL_KEY)).toHaveLength(1);
  });

  it('the re-pause throws: P2 with the days; with autoRenew false the ending form', async () => {
    for (const autoRenew of [true, false]) {
      fake.refs = [pausedRef({ autoRenew })];
      fake.pauses = [];
      fake.resumeGates = [];
      const plan = await planOf();
      fake.holdResumes = true;
      fake.pauseError = new Error('network down');
      const run = adopt(plan);
      await until(() => fake.resumeGates.length === 1);
      await r.pm().grantManual('g1', 'silver', 30);
      fake.resumeGates[0].open();
      const tail = autoRenew
        ? ' Pausing it again failed (network down); unless it is paused at Fake, it charges in 12 days.'
        : ' Pausing it again failed (network down); unless it is paused at Fake, it stays resumed and ends in 12 days with no further charge.';
      await expect(run).rejects.toThrow(`${T7_TIE}${tail}`);
      await r.pm().revokeManual('g1');
      await d.settle();
    }
  });

  it('a twin in this process while one is open: refused with no provider call; the first installs', async () => {
    const plan = await planOf();
    fake.holdResumes = true;
    const a = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    const before = rowText();
    await expect(adopt(plan)).rejects.toThrow("Subscription 'orph' was not adopted: another adoption of it is already running");
    expect(fake.resumes).toHaveLength(1);
    expect(rowText()).toBe(before);
    fake.resumeGates[0].open();
    expect(await a).toBe(true);
    expect(fake.pauses).toEqual([]);
    await d.settle();
    expect(active()).toMatchObject({ providerSubId: 'orph', status: 'active' });
  });

  it.each([['nothing more', null], ['premium marked stopping', 'marked'], ['a stop begun', 'begun']])("another holder saved it active during the resume, then %s: T8 and no re-pause", async (_name, stop) => {
    const plan = await planOf();
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await d.otherPremium(config => { config.subscriptions.g1 = { active: paid('orph', 'silver'), paused: [] }; }, stop !== null);
    const held = rowText();
    if (stop === 'begun') inject.stopping = true;
    if (stop === 'marked') r.pm().markStopped('stopping');
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow("Subscription 'orph' was not adopted: it is already in this bot's subscriptions.");
    expect(fake.pauses).toEqual([]);
    expect(rowText()).toBe(held);
  });

  it('another holder queued it during the resume: T7 with the queued reason; paused again with the days', async () => {
    const plan = await planOf();
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await d.otherPremium(config => {
      config.subscriptions.g1 = { active: paid('hi1', 'gold'), paused: [{ ...paid('orph', 'silver'), status: 'paused', remainingDaysAtPause: 12 }] };
    }, false);
    const held = rowText();
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow("Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: the bot already holds it, queued behind a higher-priority subscription. It was paused again at Fake.");
    expect(fake.pauses).toEqual([['orph', null, 12]]);
    expect(rowText()).toBe(held);
  });

  it('refresh not ok after the list: R8 with the cause, no call, only once its pass ended; local: R8l', async () => {
    const plan = await planOf();
    const cases: Array<[Refresh, string]> = [
      [{ ok: false, cause: 'no answer within 10 s' }, "Subscription 'orph' was not adopted: the current premium settings could not be brought up to date from the database (no answer within 10 s)."],
      [{ ok: false, cause: 'EIO', local: true }, "Subscription 'orph' was not adopted: this machine could not write its copy of the current premium settings (EIO)."],
    ];
    for (const [answer, text] of cases) {
      const passes: Gate[] = [];
      mirror.steps.push(unended(passes, answer));
      const run = adopt(plan);
      const s = track(run);
      await until(() => passes.length === 1);
      await pause();
      expect(s.done).toBe(false);
      passes[0].open();
      await expect(run).rejects.toThrow(text);
    }
    expect(fake.resumes).toEqual([]);
    expect(adoptLines()).toEqual([]);
  });

  it('refresh not ok after the resume: no re-pause before its pass ended, then T7 with R8 or R8l and P1; nothing saved', async () => {
    const plan = await planOf();
    const cases: Array<[Refresh, string]> = [
      [{ ok: false, cause: 'no answer within 10 s' }, "Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: the current premium settings could not be brought up to date from the database (no answer within 10 s). It was paused again at Fake."],
      [{ ok: false, cause: 'EIO', local: true }, "not installed: this machine could not write its copy of the current premium settings (EIO). It was paused again at Fake."],
    ];
    for (const [answer, text] of cases) {
      const passes: Gate[] = [];
      const pausesBefore = fake.pauses.length;
      mirror.steps.push(null, unended(passes, answer));
      const run = adopt(plan);
      const s = track(run);
      await until(() => passes.length === 1);
      await pause();
      expect(s.done).toBe(false);
      expect(fake.pauses).toHaveLength(pausesBefore);
      passes[0].open();
      await expect(run).rejects.toThrow(text);
    }
    expect(fake.pauses).toEqual([['orph', null, 12], ['orph', null, 12]]);
    await d.settle();
    expect(adoptLines()).toEqual([]);
    expect(active()).toBeUndefined();
  });
});

describe('a paused orphan beside a live sub', () => {
  beforeEach(() => boot(true));
  afterEach(down);

  it('over a live lower sub: resumed, and the old sub queued first and paused with its remaining days', async () => {
    await seed('g1', { active: paid('low1', 'silver') });
    fake.refs = [pausedRef({ tierId: 'gold' })];
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume', days: 12 });
    expect(await adopt(plan)).toBe(true);
    expect(fake.pauses).toEqual([['low1', null, 20]]);
    await d.settle();
    expect(fake.resumes).toHaveLength(1);
    expect(active()).toMatchObject({ providerSubId: 'orph', status: 'active' });
    expect(r.row().subscriptions.g1.paused[0].providerSubId).toBe('low1');
    expect(fake.pauses).toEqual([['low1', null, 20]]);
  });

  it('the active sub past its endDate with status active: the plan resumes', async () => {
    await seed('g1', { active: paid('old1', 'gold', -DAY_MS) });
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'resume' });
    expect(await adopt(plan)).toBe(true);
    expect(fake.resumes).toHaveLength(1);
  });

  it('a lower orphan: no resume; queued with 12 days; the pause got 12', async () => {
    await seed('g1', { active: paid('hi1', 'gold') });
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'queue', days: 12, activeTierId: 'gold' });
    const activeEnd = r.row().subscriptions.g1.active.endDate;
    expect(await adopt(plan)).toBe(true);
    expect(fake.pauses).toEqual([['orph', activeEnd, 12]]);
    await d.settle();
    expect(fake.resumes).toEqual([]);
    expect(r.row().subscriptions.g1.paused[0]).toMatchObject({ providerSubId: 'orph', status: 'paused', remainingDaysAtPause: 12 });
    expect(fake.pauses).toEqual([['orph', r.row().subscriptions.g1.active.endDate, 12]]);
  });

  it('a stop during the resume over a live lower sub: only the orphan paused again; T7 with the stop and P1', async () => {
    await seed('g1', { active: paid('low1', 'silver') });
    fake.refs = [pausedRef({ tierId: 'gold' })];
    for (const how of ['marked', 'begun', 'begun during the refresh', 'deposed']) {
      fake.resumes = [];
      fake.pauses = [];
      fake.resumeGates = [];
      inject.stopping = false;
      const plan = await planOf();
      fake.holdResumes = true;
      const before = rowText();
      const held = gate<Refresh>();
      const passEnd = gate();
      if (how === 'begun during the refresh') mirror.steps.push(null, async (_real, end) => { end(passEnd.promise.then(() => undefined)); return held.promise; });
      const run = adopt(plan);
      await until(() => fake.resumeGates.length === 1);
      if (how === 'marked') r.pm().markStopped('stopping');
      if (how === 'begun') inject.stopping = true;
      if (how === 'deposed') r.pm().markStopped('deposed');
      fake.resumeGates[0].open();
      if (how === 'begun during the refresh') {
        await until(() => mirror.steps.length === 0 && mirror.calls >= 2);
        inject.stopping = true;
        held.open({ ok: false, cause: 'the bot process is stopping' });
        await pause();
        expect(fake.pauses).toEqual([]);
        passEnd.open();
      }
      const words = how === 'deposed' ? 'another process took the data files' : 'the bot is stopping';
      await expect(run).rejects.toThrow(`Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: ${words}.${P1}`);
      expect(fake.pauses).toEqual([['orph', null, 12]]);
      expect(rowText()).toBe(before);
      // A fresh premium for the next way: the stop marks stay on this one.
      await down();
      await boot(true);
      await seed('g1', { active: paid('low1', 'silver') });
      fake.refs = [pausedRef({ tierId: 'gold' })];
    }
  });

  it('refusals with no call: equal priority R3, 0 days R1 in either slot, no resume or no pause support R2, the provider paused it R4 in either slot, the offering gone R6, the tier deleted R5', async () => {
    const refused = async (text: string) => {
      const plan = await planOf();
      expect(plan).toMatchObject({ kind: 'refuse', line: `It cannot be adopted: ${text}.` });
      await expect(adopt(plan)).rejects.toThrow(`Subscription 'orph' was not adopted: ${text}.`);
    };
    await seed('g1', { active: paid('same1', 'silver') });
    await refused("the server already has a 'Silver' subscription of the same priority; cancel one of them or let it end first");
    await seed('g1', {});
    fake.refs = [pausedRef({ days: 0 })];
    await refused('it is paused with no paid days left; cancel it at Fake instead');
    await seed('g1', { active: paid('hi1', 'gold') });
    await refused('it is paused with no paid days left; cancel it at Fake instead');
    fake.refs = [pausedRef({ resumable: false })];
    await refused('Fake paused it itself and the bot cannot lift that pause; resume or cancel it in the Fake dashboard');
    await seed('g1', {});
    await refused('Fake paused it itself and the bot cannot lift that pause; resume or cancel it in the Fake dashboard');
    register('fake2', false);
    fake.refs = [pausedRef({ provider: 'fake2' })];
    const plan2 = (await r.pm().findOrphansForGuild('g1')).find(o => o.providerId === 'fake2')?.plan;
    expect(plan2).toMatchObject({ kind: 'refuse', line: 'It cannot be adopted: Fake Two cannot resume a paused subscription, so its billing would stay paused; cancel it at Fake Two instead.' });
    await expect(adopt(plan2, 'orph', 'g1', 'fake2')).rejects.toThrow("Subscription 'orph' was not adopted: Fake Two cannot resume a paused subscription");
    register('fake3', true, false);
    fake.refs = [pausedRef({ provider: 'fake3' })];
    const plan3 = (await r.pm().findOrphansForGuild('g1')).find(o => o.providerId === 'fake3')?.plan;
    expect(plan3).toMatchObject({ kind: 'refuse', line: 'It cannot be adopted: Fake Three cannot resume a paused subscription, so its billing would stay paused; cancel it at Fake Three instead.' });
    await expect(adopt(plan3, 'orph', 'g1', 'fake3')).rejects.toThrow("Subscription 'orph' was not adopted: Fake Three cannot resume a paused subscription, so its billing would stay paused; cancel it at Fake Three instead.");
    await expect(adopt({ kind: 'resume', days: 12, from: 'recorded', at: AT, autoRenew: true, call: true }, 'orph', 'g1', 'fake3')).rejects.toThrow("Subscription 'orph' was not adopted: Fake Three cannot resume a paused subscription");
    fake.refs = [pausedRef()];
    const stale = await planOf();
    expect(stale).toMatchObject({ kind: 'resume' });
    r.pm().setTier('silver', dummyTier('Silver', 1, 'o9') as any);
    await refused("tier 'silver' has no offering 'o2'");
    await expect(adopt(stale)).rejects.toThrow("Subscription 'orph' was not adopted: tier 'silver' has no offering 'o2'.");
    r.pm().setTier('silver', dummyTier('Silver', 1, 'o2') as any);
    const plan = await planOf();
    r.pm().deleteTier('silver');
    await expect(adopt(plan)).rejects.toThrow("Subscription 'orph' was not adopted: tier 'silver' does not exist.");
    expect(fake.resumes).toEqual([]);
    expect(fake.pauses).toEqual([]);
  });
});

describe('R7: the plan the page showed', () => {
  beforeEach(() => boot(true));
  afterEach(down);

  const refusedR7 = async (shown: unknown, line: string) => {
    await d.settle();
    const before = rowText();
    await expect(adopt(shown)).rejects.toThrow(`Subscription 'orph' was not adopted: what adopting it does is not what this page showed; the bot now says: "${line}"; reload the page before adopting it.`);
    expect(fake.resumes).toEqual([]);
    expect(fake.pauses).toEqual([]);
    await d.settle();
    expect(rowText()).toBe(before);
    expect(adoptLines()).toEqual([]);
  };

  it('shown queue, days 12 against 2, autoRenew, missing, a string, install against paused: R7 with the server line', async () => {
    const plan: any = await planOf();
    await refusedR7({ ...plan, kind: 'queue' }, plan.line);
    fake.refs = [pausedRef({ days: null })];
    const two: any = await planOf();
    await refusedR7({ ...two, days: 12 }, two.line);
    fake.refs = [pausedRef({ autoRenew: false })];
    const ending: any = await planOf();
    await refusedR7({ ...ending, autoRenew: true }, ending.line);
    await refusedR7(undefined, ending.line);
    await refusedR7('resume', ending.line);
    await refusedR7({ kind: 'install' }, ending.line);
    fake.refs = [activeRef()];
    await refusedR7(undefined, 'It is active at Fake, and adopting adds it as it is.');
  });

  it('only activeTierId, only from or only at differs from the server plan: R7 with the server line', async () => {
    r.pm().setTier('platinum', dummyTier('Platinum', 3, 'o3') as any);
    await d.settle();
    await seed('g1', { active: paid('hi1', 'gold') });
    const behindGold: any = await planOf();
    expect(behindGold).toMatchObject({ kind: 'queue', days: 12, from: 'recorded', at: AT, activeTierId: 'gold' });
    await seed('g1', { active: { ...paid('top1', 'platinum'), offeringId: 'o3' } });
    const behindPlatinum: any = await planOf();
    expect(behindPlatinum).toMatchObject({ kind: 'queue', days: 12, from: 'recorded', at: AT, activeTierId: 'platinum', activeTier: 'Platinum' });
    expect(behindPlatinum.line).toContain('behind Platinum;');
    await refusedR7(behindGold, behindPlatinum.line);
    await seed('g1', {});
    fake.refs = [pausedRef({ days: null })];
    const period: any = await planOf();
    expect(period).toMatchObject({ kind: 'resume', days: 2, from: 'period' });
    expect(period.at).toBeUndefined();
    await refusedR7({ ...period, from: 'recorded' }, period.line);
    fake.refs = [pausedRef()];
    const recorded: any = await planOf();
    expect(recorded).toMatchObject({ kind: 'resume', days: 12, from: 'recorded', at: AT });
    await refusedR7({ ...recorded, at: '2026-10-01T00:00:00.000Z' }, recorded.line);
  });

  it('a plan shown resume while the server now sees queue', async () => {
    const plan: any = await planOf();
    await seed('g1', { active: paid('hi1', 'gold') });
    const now: any = await planOf();
    await refusedR7(plan, now.line);
  });
});

describe('a stop during the list', () => {
  afterEach(down);

  it('premium stopped, or a stop begun with premium unmarked, or a cut refresh: no call and the node-stopping answer', async () => {
    await boot(true);
    for (const how of ['marked', 'begun', 'cut']) {
      const plan = await planOf();
      fake.list = gate();
      const reply = adoptOp(plan);
      await new Promise(resolve => setTimeout(resolve, 30));
      if (how === 'marked') r.pm().markStopped('stopping');
      else inject.stopping = true;
      const calls = mirror.calls;
      if (how === 'cut') mirror.steps.push(async () => ({ ok: false, cause: 'the bot process is stopping' }));
      fake.list.open();
      fake.list = null;
      const answer: any = await reply;
      expect(answer.ok).toBe(false);
      expect(answer.error).toContain(truthText('node-stopping', false));
      expect(fake.resumes).toEqual([]);
      expect(logged('Adoption is resuming')).toEqual([]);
      if (how === 'cut') expect(mirror.calls).toBe(calls);
      await down();
      await boot(true);
    }
  });

  it('the web UI chain with the writer lock taken by another process during the list: no call, writer-lost', async () => {
    await boot(false, true);
    const plan = await planOf();
    fake.list = gate();
    const reply = adoptOp(plan);
    await new Promise(resolve => setTimeout(resolve, 30));
    deposeByOther();
    fake.list.open();
    const answer: any = await reply;
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain(truthText('writer-lost', false));
    expect(fake.resumes).toEqual([]);
  });
});

describe.each([['the bot child', true], ['the web UI chain', false]])('a deposition during the resume, %s', (_name, bot) => {
  beforeEach(() => boot(bot, true));
  afterEach(down);

  it('the lock file rewritten by another holder while the resume is open: only the orphan paused again; nothing saved', async () => {
    await seed('g1', { active: paid('low1', 'silver') });
    fake.refs = [pausedRef({ tierId: 'gold' })];
    const plan = await planOf();
    fake.holdResumes = true;
    const before = rowText();
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    deposeByOther();
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow(`Subscription 'orph' was not adopted: it was resumed at Fake, but not installed: another process took the data files.${P1}`);
    expect(fake.pauses).toEqual([['orph', null, 12]]);
    expect(rowText()).toBe(before);
  });
});

describe.each([['the bot child', true], ['the web UI chain', false]])("another machine's save, %s", (_name, bot) => {
  beforeEach(() => boot(bot, !bot));
  afterEach(down);

  it('during the list, a higher live sub: R7 with the queue line, no call', async () => {
    const plan = await planOf();
    fake.list = gate();
    const run = adopt(plan);
    await new Promise(resolve => setTimeout(resolve, 30));
    await d.otherPremium(config => { config.subscriptions.g1 = { active: paid('hi1', 'gold'), paused: [] }; }, false);
    fake.list.open();
    await expect(run).rejects.toThrow('the bot now says: "Adopting queues this paused subscription behind Gold;');
    expect(fake.resumes).toEqual([]);
    expect(mirror.calls).toBe(1);
  });

  it('during the resume, an equal sub: T7 and P1, and no save refused changed-elsewhere', async () => {
    const plan = await planOf();
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await d.otherPremium(config => { config.subscriptions.g1 = { active: paid('same1', 'silver'), paused: [] }; }, false);
    fake.resumeGates[0].open();
    await expect(run).rejects.toThrow(`${T7_TIE}${P1}`);
    await d.settle();
    expect(adoptLines()).toEqual([]);
    expect(r.lines(AUDIT_KEY).filter(l => l.metadata?.notSaved?.cause === 'changed-elsewhere')).toEqual([]);
    expect(mirror.calls).toBe(2);
  });

  it("during the resume, a change to another guild only: installed on the new row's base", async () => {
    const plan = await planOf();
    fake.holdResumes = true;
    const run = adopt(plan);
    await until(() => fake.resumeGates.length === 1);
    await d.otherPremium(config => { config.subscriptions.g2 = { active: paid('g2sub', 'gold'), paused: [] }; }, false);
    fake.resumeGates[0].open();
    expect(await run).toBe(true);
    await d.settle();
    expect(active('g2')?.providerSubId).toBe('g2sub');
    expect(active('g1')).toMatchObject({ providerSubId: 'orph', status: 'active' });
    expect(mirror.calls).toBe(2);
  });
});

describe("findOrphansForGuild's plans", () => {
  beforeEach(() => boot(true));
  afterEach(down);

  it('resume with the recorded days and T5 with the date', async () => {
    expect(await planOf()).toEqual({
      kind: 'resume', days: 12, from: 'recorded', at: AT, autoRenew: true, call: true,
      line: 'Adopting resumes this paused subscription at Fake; its next charge is in 12 days. The days are the ones the bot recorded when it paused it on 2026-11-01.',
    });
    fake.refs = [pausedRef({ days: null, autoRenew: false })];
    expect((await planOf())?.line).toBe("Adopting resumes this paused subscription at Fake; it ends in 2 days with no further charge. The days come from Fake's current billing period, because the bot did not record them when it was paused.");
  });

  it('queue below a live higher sub with T5q; with a higher sub already queued it names no time', async () => {
    await seed('g1', { active: paid('hi1', 'gold') });
    const plan = await planOf();
    expect(plan).toMatchObject({ kind: 'queue', days: 12, from: 'recorded', activeTierId: 'gold', activeTier: 'Gold' });
    expect(plan?.line).toBe('Adopting queues this paused subscription behind Gold; it stays paused at Fake until its turn in the queue, then resumes with 12 days left. The days are the ones the bot recorded when it paused it on 2026-11-01.');
    await seed('g1', { active: paid('hi1', 'gold'), paused: [{ ...paid('hi2', 'gold'), status: 'paused', remainingDaysAtPause: 5 }] });
    const line = (await planOf())?.line ?? '';
    expect(line).toContain('until its turn in the queue');
    expect(line).not.toContain('ends');
  });

  it('refuse R5 for a deleted tier while an active sub is live; R3 at equal priority; resume when the active sub is past its end', async () => {
    await seed('g1', { active: paid('hi1', 'gold') });
    fake.refs = [pausedRef({ tierId: 'bronze', offeringId: 'o9' })];
    expect(await planOf()).toMatchObject({ kind: 'refuse', line: "It cannot be adopted: tier 'bronze' does not exist." });
    fake.refs = [pausedRef({ tierId: 'gold' })];
    expect(await planOf()).toMatchObject({ kind: 'refuse', line: "It cannot be adopted: the server already has a 'Gold' subscription of the same priority; cancel one of them or let it end first." });
    await seed('g1', { active: paid('hi1', 'gold', -DAY_MS) });
    expect(await planOf()).toMatchObject({ kind: 'resume' });
  });

  it('install for an active ref with T6; no plan without tierId', async () => {
    fake.refs = [activeRef(), { ...pausedRef({ id: 'bare' }), metadata: { guildId: 'g1' } }];
    expect(await planOf()).toEqual({ kind: 'install', line: 'It is active at Fake, and adopting adds it as it is.' });
    const bare = (await r.pm().findOrphansForGuild('g1')).find(o => o.ref.providerSubId === 'bare');
    expect(bare).toBeDefined();
    expect(bare!.plan).toBeUndefined();
  });
});
