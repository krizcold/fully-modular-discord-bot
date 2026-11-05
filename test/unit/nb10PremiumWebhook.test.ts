import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 tests 19, 35 and 37 (decision 13): a payment op is answered only once the install its event started has saved
// and its install line has landed; a delivery of a subscription in flight waits for it and installs once; a
// redelivery saves and answers ok only once the subscription and its install line landed, writing the line when the
// audit file has none; the audit file is read once per process, never for a tick's re-emits; an op waits only for the
// installs started under its own ledger; a lost install line is logged with the ending its first op decided.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>(), reads: new Map<string, number>() }));
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
    readRawStrict: (p: string) => {
      inject.reads.set(p, (inject.reads.get(p) ?? 0) + 1);
      return real.readRawStrict(p);
    },
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

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock } from '../helpers/nb10Rig';
import { failFlushes } from '../helpers/configRig';
import { webhookAnswer } from '../../src/webui/routes/hopFailure';
import { cancelQueued, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { AUDIT, clearGlobal, gate, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const refuse = (...files: string[]) => { for (const f of files) inject.refuse.set(f, 'storage-failing'); };
const recover = () => inject.refuse.clear();

/** A provider whose webhook raises the event in its body, and whose pause the test holds open, per subscription when given. */
let pause = gate();
const pauses = new Map<string, ReturnType<typeof gate<void>>>();
const pauseCalls: string[] = [];
function registerFake(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString())); },
    pauseSubscription: (providerSubId: string) => { pauseCalls.push(providerSubId); return (pauses.get(providerSubId) ?? pause).promise; },
    listSubscriptionsForGuild: async (guildId: string) => (guildId === 'g3'
      ? [{ providerSubId: 'orph1', metadata: { tierId: 'low', offeringId: 'o1' }, state: state() }]
      : []),
  } as any);
  getPaymentRegistry().register({ id: 'boost', displayName: 'Boost', capabilities: {}, isConfigured: () => true } as any);
}

/** Appends to the audit file fail with EIO while `on`, as a disk that accepted the write and failed its flush. */
function failingAudit(): { on: boolean; calls: number } {
  const sw = { on: true, calls: 0 };
  const real = fs.promises.appendFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'appendFile').mockImplementation((async (p: any, data: any, options?: any) => {
    if (String(p) === AUDIT) {
      sw.calls += 1;
      if (sw.on) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    }
    return real(p, data, options);
  }) as typeof fs.promises.appendFile);
  return sw;
}

function newProcess(): ReturnType<typeof getPremiumManager> {
  resetPremiumManager();
  reg.current = null;
  registerFake();
  return getPremiumManager();
}

/** The process dies after its final stop step: what it still had queued for these files never lands. */
async function dies(...files: string[]): Promise<void> {
  await cancelQueued(files.filter(f => queuedFilePaths().includes(f)));
}

const answers503 = (reply: any) => {
  expect(reply).toMatchObject({ ok: false });
  expect(webhookAnswer(reply).status).toBe(503);
};
const created = (providerSubId: string, guildId = 'g1', tierId = 'low') => ({
  type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId, offeringId: tierId === 'low' ? 'o1' : 'o2', state: state(),
});
const deliver = (event: object) => applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } });
/** The bot answers a delivery itself; the web UI sends it through BotManager's local chain, its write gate and the writer lock. */
let chain: BotManager | null = null;
const viaChain = (bot: boolean) => (event: object) => (bot
  ? deliver(event)
  : (chain ??= new BotManager()).runSharedOp('payment.webhook', { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' }));
function localChainHooks(bot: boolean): void {
  beforeEach(() => {
    chain = null;
    if (bot) return;
    asBot(false);
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui');
  });
  afterEach(() => {
    setSharedWriteGate(null);
    chain = null;
  });
}
const installLines = (providerSubId?: string) => linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid'
  && (providerSubId === undefined || (jsonOf(PREMIUM) && JSON.stringify(jsonOf(PREMIUM).subscriptions).includes(l.subscriptionId))));
const stopLines = (): string[] => [...logged(spies.error), ...logged(spies.warn)];
const manualHigh = () => ({ id: 'm1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' });

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  recover();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
  pause = gate();
  pause.open();
  pauses.clear();
  pauseCalls.length = 0;
  inject.reads.clear();
  asBot(true);
  registerFake();
});
afterEach(async () => {
  recover();
  pause.open();
  for (const held of pauses.values()) held.open();
  resetPremiumManager();
  reg.current = null;
  fs.rmSync(AUDIT, { recursive: true, force: true });
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe.each([['in the bot', true], ['in the local chain', false]])('test 19: a webhook waits for its install, %s', (_name, bot) => {
  const send = viaChain(bot);
  localChainHooks(bot);
  it('no answer while the provider pause is open; a second delivery answers after it; one subscription', async () => {
    asBot(bot);
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    pause = gate();
    let firstDone = false;
    const first = send(created('ps1')).then(r => { firstDone = true; return r; });
    await tick(30);
    const second = send(created('ps1'));
    await tick(30);
    expect(firstDone).toBe(false);
    pause.open();
    expect(await first).toMatchObject({ ok: true });
    expect(jsonOf(PREMIUM).subscriptions.g1.paused).toHaveLength(1);
    expect(installLines()).toHaveLength(1);
    expect(await second).toMatchObject({ ok: true });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1.paused).toHaveLength(1);
    expect(installLines()).toHaveLength(1);
    if (!bot) expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe('test 19 through the web UI chain (BotManager, the shared write gate and the writer lock)', () => {
  it('the lock names the web UI while the pause is open; then ok, one paused subscription, one install line, no gate refusal, lock gone', async () => {
    asBot(false);
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui');
    try {
      writePremium({ g1: { active: manualHigh(), paused: [] } });
      pause = gate();
      let done = false;
      const body = Buffer.from(JSON.stringify(created('ps9'))).toString('base64');
      const reply = new BotManager().runSharedOp('payment.webhook', { providerId: 'fake', body, signature: '' }).then(r => { done = true; return r; });
      await tick(50);
      expect(done).toBe(false);
      expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'))).toMatchObject({ pid: process.pid, role: 'webui' });
      pause.open();
      expect(await reply).toMatchObject({ ok: true });
      expect(jsonOf(PREMIUM).subscriptions.g1.paused).toHaveLength(1);
      expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
      expect(logged(spies.error).some(l => l.includes('writes data files only inside a change it applies itself'))).toBe(false);
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      setSharedWriteGate(null);
    }
  });
});

describe('test 37: an op waits only for the installs started under its own ledger', () => {
  it('premium.setMessages answers while an entitlement install is held open; a webhook answers only after its own', async () => {
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    getPremiumManager();
    const entPause = gate();
    const hookPause = gate();
    pauses.set('ent1', entPause);
    pauses.set('ps2', hookPause);
    getPaymentRegistry().emitEvent(created('ent1') as any);
    await tick(20);
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'no' }] } })).toMatchObject({ ok: true });
    expect(pauseCalls).toEqual(['ent1']);
    expect(installLines()).toEqual([]);
    let done = false;
    const hook = deliver(created('ps2', 'g1')).then(r => { done = true; return r; });
    await tick(30);
    expect(done).toBe(false);
    expect(pauseCalls).toEqual(['ent1', 'ps2']);
    entPause.open();
    await vi.waitFor(() => expect(installLines()).toHaveLength(1), { timeout: 5000, interval: 20 });
    await tick(30);
    expect(done).toBe(false);
    hookPause.open();
    expect(await hook).toMatchObject({ ok: true });
    expect(installLines()).toHaveLength(2);
  });
});

describe('test 35: redeliveries', () => {
  it('a delivery whose save is refused answers held; once landed, a redelivery answers ok with one install line', async () => {
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    expect(await deliver(created('ps1'))).toMatchObject({ ok: false, answer: 'held' });
    expect(await deliver(created('ps1'))).toMatchObject({ ok: false });
    recover();
    await vi.waitFor(() => expect(installLines()).toHaveLength(1), { timeout: 5000, interval: 50 });
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    expect(Object.keys(jsonOf(PREMIUM).subscriptions)).toEqual(['g1']);
  });

  it('only premium-tiers.json refused: a redelivery is answered on its own save of the file, not on the landed line', async () => {
    refuse('premium-tiers.json');
    answers503(await deliver(created('ps1')));
    await vi.waitFor(() => expect(installLines()).toHaveLength(1), { timeout: 5000, interval: 20 });
    answers503(await deliver(created('ps1')));
    expect(jsonOf(PREMIUM)?.subscriptions?.g1).toBeUndefined();
    expect(installLines()).toHaveLength(1);
    recover();
    const real = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === PREMIUM) await tick(400);
      return real(from, to);
    }) as typeof fs.promises.rename);
    let onDisk: unknown = 'unanswered';
    const third = deliver(created('ps1')).then(r => { onDisk = jsonOf(PREMIUM)?.subscriptions?.g1?.paused?.[0]?.providerSubId ?? jsonOf(PREMIUM)?.subscriptions?.g1?.active?.providerSubId ?? null; return r; });
    await tick(50);
    expect(onDisk).toBe('unanswered');
    expect(await third).toMatchObject({ ok: true });
    expect(onDisk).toBe('ps1');
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    expect(Object.keys(jsonOf(PREMIUM).subscriptions)).toEqual(['g1']);
  });

  it("(c) in the web UI with no child: another writer adds B and its line between two local redeliveries; B's redelivery appends no line", async () => {
    asBot(false);
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui', new Set([process.pid, 5151]));
    try {
      writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
      const line = (guildId: string, subscriptionId: string) => `${JSON.stringify({ timestamp: 't', actor: 'admin', action: 'subscription.install.paid', guildId, subscriptionId })}\n`;
      fs.writeFileSync(AUDIT, line('g1', 's1'));
      const manager = new BotManager();
      const hook = (event: object) => manager.runSharedOp('payment.webhook', { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' });
      expect(await hook(created('ps1'))).toMatchObject({ ok: true });
      expect(fs.existsSync(writerLockPath())).toBe(false);

      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 5151, start: null, role: 'bot', at: Date.now() }));
      writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] }, g2: { active: paidSub('s2', 'ps2'), paused: [] } });
      fs.appendFileSync(AUDIT, line('g2', 's2'));
      fs.rmSync(writerLockPath());
      const audit = fs.readFileSync(AUDIT, 'utf8');

      expect(await hook(created('ps2', 'g2'))).toMatchObject({ ok: true });
      await settleQueue();
      expect(fs.readFileSync(AUDIT, 'utf8')).toBe(audit);
      expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid').map(l => l.subscriptionId)).toEqual(['s1', 's2']);
      expect(jsonOf(PREMIUM).subscriptions.g2.active).toMatchObject({ id: 's2', providerSubId: 'ps2' });
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      setSharedWriteGate(null);
    }
  });

  it('two concurrent deliveries install one subscription', async () => {
    const [a, b] = await Promise.all([deliver(created('ps3', 'g3')), deliver(created('ps3', 'g3'))]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(jsonOf(PREMIUM).subscriptions.g3.active.providerSubId).toBe('ps3');
    expect(installLines()).toHaveLength(1);
  });

  it('a new process with the subscription but no install line: the redelivery writes one marked redelivered, a second writes none', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
    fs.writeFileSync(AUDIT, `${JSON.stringify({ timestamp: 't', actor: 'admin', action: 'tier.create', tierId: 'low' })}\n`);
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    const lines = linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subscriptionId: 's1', metadata: { redelivered: true } });
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
    expect(inject.reads.get(AUDIT)).toBe(1);
  });

  it('the audit file that cannot be read: the redelivery answers not ok and appends nothing', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
    fs.mkdirSync(AUDIT);
    expect(await deliver(created('ps1'))).toMatchObject({ ok: false, answer: 'io' });
    expect(fs.statSync(AUDIT).isDirectory()).toBe(true);
  });

  it('6000 install lines: the oldest subscription is found by the whole-file scan, so no line is appended', async () => {
    const subs: Record<string, unknown> = { g0: { active: paidSub('s0', 'ps0'), paused: [] } };
    writePremium(subs);
    const body = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ timestamp: 't', actor: 'admin', action: 'subscription.install.paid', guildId: `g${i}`, subscriptionId: `s${i}` })).join('\n') + '\n';
    fs.writeFileSync(AUDIT, body);
    expect(await deliver(created('ps0', 'g0'))).toMatchObject({ ok: true });
    await settleQueue();
    expect(linesOf(AUDIT)).toHaveLength(6000);
  });

  it("a tick's re-emits of 300 installed subscriptions read the audit file zero times and write nothing; 20 redeliveries read it once", async () => {
    const subs: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) subs[`g${i}`] = { active: paidSub(`s${i}`, `ps${i}`), paused: [] };
    writePremium(subs);
    fs.writeFileSync(AUDIT, '');
    const premiumBefore = fs.readFileSync(PREMIUM, 'utf8');
    getPremiumManager();
    for (let i = 0; i < 300; i++) getPaymentRegistry().emitEvent(created(`ps${i}`, `g${i}`) as any);
    await tick(50);
    await settleQueue();
    expect(inject.reads.get(AUDIT) ?? 0).toBe(0);
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(premiumBefore);
    expect(linesOf(AUDIT)).toEqual([]);
    for (let i = 0; i < 20; i++) expect(await deliver(created(`ps${i}`, `g${i}`))).toMatchObject({ ok: true });
    expect(inject.reads.get(AUDIT)).toBe(1);
  });
});

describe('the endings of an install line lost at a stop', () => {
  it('held at the final step: the webhook line names the next delivery, the entitlement line is lost', async () => {
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    expect(await deliver(created('ps1', 'g1'))).toMatchObject({ ok: false, answer: 'held' });
    getPaymentRegistry().emitEvent(created('ent2', 'g2') as any);
    await tick(30);
    getPremiumManager().finalStop();
    const errors = logged(spies.error);
    const hook = errors.find(l => l.includes('subscription ps1'));
    const ent = errors.find(l => l.includes('subscription ent2'));
    expect(hook).toMatch(/^\[PremiumManager\] The audit line subscription\.install\.paid \(guild g1, subscription ps1\) was refused by the disk before this stop; the webhook was answered 503, and the provider's next delivery of it writes this line, or, when the subscription's own save was lost too, installs the subscription again under a new id with its own line: \{/);
    expect(hook).not.toContain('redelivered');
    expect(ent).toMatch(/^\[PremiumManager\] The audit line subscription\.install\.paid \(guild g2, subscription ent2\) was refused by the disk before this stop and is lost: \{/);
  });

  it('queued and not landed at the exit: the exit handler logs each with its ending, and nothing is called lost twice', async () => {
    fs.mkdirSync(AUDIT);
    expect(await deliver(created('ps1', 'g1'))).toMatchObject({ ok: false });
    getPaymentRegistry().emitEvent(created('ent2', 'g2') as any);
    await tick(30);
    const pm = getPremiumManager();
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.finalStop();
    pm.logLossesAtExit();
    const errors = logged(spies.error);
    expect(errors.filter(l => l.includes('subscription ps1'))).toHaveLength(1);
    expect(errors.find(l => l.includes('subscription ps1'))).toMatch(/did not reach the disk before this stop; the webhook was answered 503, and the provider's next delivery/);
    expect(errors.find(l => l.includes('subscription ent2'))).toMatch(/did not reach the disk before this stop and is lost: \{/);
    expect(stopLines().filter(l => l.includes('subscription ps1'))).toHaveLength(1);
    expect(stopLines().filter(l => l.includes('subscription ent2'))).toHaveLength(1);
    expect(stopLines().filter(l => l.includes('subscription ps1') && (l.includes('is lost') || l.includes('redelivered')))).toEqual([]);
  });
});

describe.each([['in the bot', true], ['in the local chain', false]])('test 35, the first cases, %s', (_name, bot) => {
  const send = viaChain(bot);
  localChainHooks(bot);
  it('a duplicate that arrives while the first install, whose save was refused, awaits the provider answers 503', async () => {
    asBot(bot);
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    const before = fs.readFileSync(PREMIUM, 'utf8');
    pause = gate();
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    let firstDone = false;
    const first = send(created('ps1')).then(r => { firstDone = true; return r; });
    await tick(30);
    const second = send(created('ps1'));
    await tick(30);
    expect(firstDone).toBe(false);
    pause.open();
    answers503(await first);
    answers503(await second);
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(before);
    expect(installLines()).toEqual([]);
    recover();
    if (bot) {
      await vi.waitFor(() => expect(installLines()).toHaveLength(1), { timeout: 5000, interval: 50 });
      expect(jsonOf(PREMIUM).subscriptions.g1.paused.map((p: any) => p.providerSubId)).toEqual(['ps1']);
    } else {
      await settleQueue();
      expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(before);
      expect(installLines()).toEqual([]);
      expect(fs.existsSync(writerLockPath())).toBe(false);
      const again: any = await send(created('ps1'));
      expect(again).toMatchObject({ ok: true });
      expect(jsonOf(PREMIUM).subscriptions.g1.paused.map((p: any) => p.providerSubId)).toEqual(['ps1']);
      expect(installLines()).toHaveLength(1);
      expect(fs.existsSync(writerLockPath())).toBe(false);
    }
  });

  it('an install line whose flush fails (EIO): the delivery and a redelivery answer 503 while it is queued, and 200 only once it landed', async () => {
    asBot(bot);
    const audit = failingAudit();
    answers503(await send(created('ps5', 'g5')));
    expect(audit.calls).toBeGreaterThan(0);
    expect(jsonOf(PREMIUM).subscriptions.g5.active.providerSubId).toBe('ps5');
    answers503(await send(created('ps5', 'g5')));
    expect(rawOf(AUDIT)).toBeNull();
    audit.on = false;
    expect(await send(created('ps5', 'g5'))).toMatchObject({ ok: true });
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g5', subscriptionId: jsonOf(PREMIUM).subscriptions.g5.active.id });
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    if (!bot) expect(fs.existsSync(writerLockPath())).toBe(false);
  }, 30_000);
});

describe('test 35 round 4 and round 8 (d): the retry appends the held install line and its flush fails', () => {
  /** A webhook install refused by the folder, then the retry lands the save and its append of the line fails (EIO). */
  async function heldThenFailing(): Promise<{ on: boolean; calls: number }> {
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    answers503(await deliver(created('ps1')));
    const audit = failingAudit();
    recover();
    await vi.waitFor(() => {
      expect(jsonOf(PREMIUM).subscriptions.g1?.active?.providerSubId).toBe('ps1');
      expect(audit.calls).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 50 });
    expect(queuedFilePaths()).toContain(AUDIT);
    expect(installLines()).toEqual([]);
    return audit;
  }

  it('a redelivery whose own save lands answers 503 while the line is queued, and 200 only once the line landed', async () => {
    const audit = await heldThenFailing();
    answers503(await deliver(created('ps1')));
    expect(installLines()).toEqual([]);
    audit.on = false;
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    expect(installLines()).toHaveLength(1);
    expect(installLines()[0].metadata?.redelivered).toBeUndefined();
    await settleQueue();
    expect(installLines()).toHaveLength(1);
  }, 30_000);

  it('a stop logs the line with the webhook ending and its JSON, never as lost; after a restart the redelivery appends exactly one line and answers 200 once it landed', async () => {
    const audit = await heldThenFailing();
    const pm = getPremiumManager();
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.finalStop();
    pm.logLossesAtExit();
    const about = logged(spies.error).filter(l => l.includes('subscription ps1'));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.install\.paid \(guild g1, subscription ps1\) did not reach the disk before this stop; the webhook was answered 503, and the provider's next delivery of it writes this line, or, when the subscription's own save was lost too, installs the subscription again under a new id with its own line: \{.*"action":"subscription\.install\.paid"/);
    expect(about[0]).not.toContain('is lost');
    expect(about[0]).not.toContain('redelivered');
    expect(stopLines().filter(l => l.includes('subscription ps1'))).toEqual(about);
    await dies(AUDIT);
    audit.on = false;
    spies.error.mockClear();

    newProcess();
    expect(rawOf(AUDIT)).toBeNull();
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g1', subscriptionId: jsonOf(PREMIUM).subscriptions.g1.active.id, metadata: { redelivered: true } });
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    expect(logged(spies.error).filter(l => l.includes('is lost'))).toEqual([]);
  }, 30_000);
});

describe('test 35 round 6: a new process whose redelivered line cannot land', () => {
  it('each redelivery answers 503 while /data/global fails; after the disk recovers the audit file holds one install line and was read once', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
    fs.writeFileSync(AUDIT, `${JSON.stringify({ timestamp: 't', actor: 'admin', action: 'tier.create', tierId: 'low' })}\n`);
    const audit = failingAudit();
    const undo = failFlushes(PREMIUM, 'EIO');
    try {
      for (let i = 0; i < 3; i++) answers503(await deliver(created('ps1')));
      expect(installLines()).toEqual([]);
    } finally {
      undo();
      audit.on = false;
    }
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subscriptionId: 's1', metadata: { redelivered: true } });
    expect(inject.reads.get(AUDIT)).toBe(1);
    expect(await deliver(created('ps1'))).toMatchObject({ ok: true });
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    expect(inject.reads.get(AUDIT)).toBe(1);
  }, 30_000);
});

describe('test 35 round 7 (a): install lines of every origin that did not land at a stop', () => {
  it('the entitlement, boost tick and adoptOrphan lines are logged as lost and the webhook line with its ending; after a restart and the re-emits no line is appended and no log promises one', async () => {
    const audit = failingAudit();
    const pm = getPremiumManager();
    getPaymentRegistry().emitEvent(created('ent1', 'g1') as any);
    getPaymentRegistry().emitEvent({ ...created('bst1', 'g2'), providerId: 'boost' } as any);
    expect(await applySharedOp({ op: 'premium.adoptOrphan', args: { args: ['g3', 'fake', 'orph1'] } })).toMatchObject({ ok: false });
    answers503(await deliver(created('ps4', 'g4')));
    await vi.waitFor(() => {
      const subs = jsonOf(PREMIUM).subscriptions;
      expect(['g1', 'g2', 'g3', 'g4'].map(g => subs[g]?.active?.providerSubId)).toEqual(['ent1', 'bst1', 'orph1', 'ps4']);
    }, { timeout: 5000, interval: 20 });
    const premiumAtStop = fs.readFileSync(PREMIUM, 'utf8');
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.finalStop();
    pm.logLossesAtExit();
    const errors = logged(spies.error);
    for (const [guild, sub] of [['g1', 'ent1'], ['g2', 'bst1'], ['g3', 'orph1']]) {
      const about = errors.filter(l => l.includes(`subscription ${sub})`));
      expect(about).toHaveLength(1);
      expect(about[0]).toMatch(new RegExp(`^\\[PremiumManager\\] The audit line subscription\\.install\\.paid \\(guild ${guild}, subscription ${sub}\\) did not reach the disk before this stop and is lost: \\{.*"action":"subscription\\.install\\.paid"`));
      expect(about[0]).not.toContain('next delivery');
    }
    const hook = errors.filter(l => l.includes('subscription ps4)'));
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatch(/did not reach the disk before this stop; the webhook was answered 503, and the provider's next delivery of it writes this line.*: \{/);
    for (const sub of ['ent1', 'bst1', 'orph1', 'ps4']) expect(stopLines().filter(l => l.includes(`subscription ${sub})`))).toHaveLength(1);
    expect(stopLines().filter(l => l.includes('subscription ps4)') && (l.includes('is lost') || l.includes('redelivered')))).toEqual([]);
    await dies(AUDIT, PREMIUM);
    audit.on = false;

    spies.error.mockClear();
    spies.warn.mockClear();
    newProcess();
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(premiumAtStop);
    getPaymentRegistry().emitEvent({ ...created('bst1', 'g2'), providerId: 'boost' } as any);
    getPaymentRegistry().emitEvent(created('ent1', 'g1') as any);
    await tick(50);
    await settleQueue();
    expect(installLines()).toEqual([]);
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(premiumAtStop);
    expect([...logged(spies.warn), ...logged(spies.error)].filter(l => l.includes('next delivery') || l.includes('writes this line'))).toEqual([]);
  }, 30_000);
});

describe('test 35 round 8 (f): a webhook install whose save and line both did not land at a stop', () => {
  it('the exit line names both outcomes and not redelivered; after a restart the redelivery installs under a new id with one unmarked line', async () => {
    const audit = failingAudit();
    const undo = failFlushes(PREMIUM, 'EIO');
    const before = fs.readFileSync(PREMIUM, 'utf8');
    let firstId = '';
    try {
      answers503(await deliver(created('ps6', 'g6')));
      const pm = getPremiumManager();
      spies.error.mockClear();
      spies.warn.mockClear();
      pm.finalStop();
      pm.logLossesAtExit();
      const about = logged(spies.error).filter(l => l.includes('subscription ps6)'));
      expect(about).toHaveLength(1);
      expect(about[0]).toContain("the provider's next delivery of it writes this line, or, when the subscription's own save was lost too, installs the subscription again under a new id with its own line");
      expect(about[0]).not.toContain('redelivered');
      expect(stopLines().filter(l => l.includes('subscription ps6)'))).toEqual(about);
      expect(about[0]).not.toContain('is lost');
      firstId = JSON.parse(about[0].slice(about[0].indexOf('{'))).subscriptionId;
      expect(typeof firstId).toBe('string');
      await dies(AUDIT, PREMIUM);
    } finally {
      undo();
      audit.on = false;
    }
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(before);
    expect(rawOf(AUDIT)).toBeNull();

    newProcess();
    expect(await deliver(created('ps6', 'g6'))).toMatchObject({ ok: true });
    const active = jsonOf(PREMIUM).subscriptions.g6.active;
    expect(active.providerSubId).toBe('ps6');
    expect(active.id).not.toBe(firstId);
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].subscriptionId).toBe(active.id);
    expect(lines[0].metadata?.redelivered).toBeUndefined();
  }, 30_000);
});
