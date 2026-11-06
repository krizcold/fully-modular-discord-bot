import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors (premiumManager.ts, decision 13): a redelivery of a subscription in the cache writes its install
// line, by an admin, when the audit file has none (only install lines count, damaged lines are skipped); a held or
// buffered line answers held under its own cause; an install line queued in this process stays queued when the audit
// file is read; a line written in a dropped replay is dropped and later delivered again; a refused line that is not
// an install line never drops the subscription's install line.

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
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, gate, linesOf, logged, paidSub, quiet, settleQueue, state, writePremium } from './nb10PremiumRig';
import { stubAppendHandles } from '../helpers/fileHandleStub';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const AUDIT_DOC = 'global:/premium-tiers.audit.jsonl';
const refuse = (file: string, cause = 'storage-failing') => inject.refuse.set(file, cause);
const recover = () => inject.refuse.clear();

function newProcess(): ReturnType<typeof getPremiumManager> {
  resetPremiumManager();
  reg.current = null;
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: async () => undefined,
  } as any);
  return getPremiumManager();
}
type Manager = ReturnType<typeof getPremiumManager>;
const created = (providerSubId: string, guildId = 'g1') => ({
  type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state(),
});
/** A webhook delivery of the event in a payment op; answers the op's refused documents. */
function redeliver(pm: Manager, event: object) {
  return runSealed('console', null, 'premium', async ledger => {
    markPaymentLedger(ledger, 'payment.webhook');
    getPaymentRegistry().emitEvent(event as any);
    await pm.settled(ledger);
    return ledger.refusedDocs().filter(r => r.doc === AUDIT_DOC);
  });
}
/** Runs fn in a ledger of a replay that was dropped at a stop. */
function inDroppedReplay(pm: Manager, fn: () => Promise<void>): Promise<void> {
  return runSealed('console', null, 'premium', async ledger => {
    (pm as any).replayLedgers.add(ledger);
    (pm as any).replayDropped = true;
    await fn();
    await pm.settled(ledger);
  });
}
const installLines = () => linesOf(AUDIT).filter(l => l?.action === 'subscription.install.paid');
const auditLine = (entry: object) => `${JSON.stringify({ timestamp: 't', actor: 'admin', ...entry })}\n`;
const withS1 = () => writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });

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
  asBot(true);
});
afterEach(async () => {
  recover();
  resetPremiumManager();
  reg.current = null;
  fs.rmSync(AUDIT, { recursive: true, force: true });
  vi.restoreAllMocks();
  await settleQueue();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the audit file read of a redelivery', () => {
  it('a line of another action for the subscription is not its install line: the redelivery writes one, by an admin', async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.expire.paid', guildId: 'g1', subscriptionId: 's1' }));
    const pm = newProcess();
    expect(await redeliver(pm, created('ps1'))).toEqual([]);
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'admin', subscriptionId: 's1', guildId: 'g1', metadata: { redelivered: true } });
  });

  it('a null line is skipped and the redelivery writes the install line', async () => {
    withS1();
    fs.writeFileSync(AUDIT, 'null\n');
    const pm = newProcess();
    await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toEqual([]);
  });

  it('an audit file that cannot be read is logged with its errno and the 503', async () => {
    withS1();
    fs.mkdirSync(AUDIT);
    const pm = newProcess();
    expect(await redeliver(pm, created('ps1'))).toEqual([{ cause: 'io', doc: AUDIT_DOC, seq: expect.any(Number), retried: false }]);
    expect(logged(spies.error).filter(l => /^\[PremiumManager\] Cannot read premium-tiers\.audit\.jsonl \(E[A-Z]+\); the delivery is answered 503 and the next one reads it again$/.test(l))).toHaveLength(1);
  });

  it('an install line queued in this process stays queued: its loss is logged at exit while it has not landed', async () => {
    writePremium({ g2: { active: paidSub('s2', 'ps2'), paused: [] } });
    const pm = newProcess();
    const flush = gate();
    const stub = stubAppendHandles();
    const opened = stub.holdOpen(AUDIT);
    void flush.promise.then(() => opened.release());
    try {
      getPaymentRegistry().emitEvent(created('psA') as any);
      await pm.settled(undefined);
      // The line's append is held at its open, so none of its bytes is in the file at the exit.
      await opened.reached;
      await redeliver(pm, created('ps2', 'g2'));
      spies.error.mockClear();
      pm.logLossesAtExit();
      expect(logged(spies.error).filter(l => l.includes('(guild g1, subscription psA) did not reach the disk'))).toHaveLength(1);
    } finally {
      flush.open();
    }
    await settleQueue();
  });
});

describe('a redelivery while the install line waits', () => {
  it('a held line answers held under the cause that held it', async () => {
    const pm = newProcess();
    refuse('premium-tiers.audit.jsonl');
    getPaymentRegistry().emitEvent(created('ps1') as any);
    await pm.settled(undefined);
    expect(await redeliver(pm, created('ps1'))).toEqual([{ cause: 'storage-failing', doc: AUDIT_DOC, seq: expect.any(Number), retried: true }]);
  });

  it("a replay's buffered line answers held as an io refusal, whatever held other lines", async () => {
    withS1();
    const pm = newProcess();
    // The state a replay leaves while its marks have not landed (decision 12): the line waits in its buffer.
    (pm as any).installLines.set('s1', { state: 'buffered', webhook: false, line: auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' }), entry: { action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' } });
    (pm as any).installLinesFilled = true;
    (pm as any).heldCause = 'storage-failing';
    expect(await redeliver(pm, created('ps1'))).toEqual([{ cause: 'io', doc: AUDIT_DOC, seq: expect.any(Number), retried: true }]);
    await settleQueue();
    expect(installLines()).toEqual([]);
  });
});

describe('lines written in a dropped replay', () => {
  it("an install's line is dropped, and the next delivery writes it", async () => {
    const pm = newProcess();
    await inDroppedReplay(pm, async () => { getPaymentRegistry().emitEvent(created('psX', 'g5') as any); });
    await settleQueue();
    expect(installLines()).toEqual([]);
    expect(await redeliver(pm, created('psX', 'g5'))).toEqual([]);
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g5', metadata: { redelivered: true } });
  });

  it("another line naming the subscription keeps its install line, so a redelivery writes none", async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' }));
    const pm = newProcess();
    await redeliver(pm, created('ps1'));
    await inDroppedReplay(pm, async () => { await pm.grantManual('g1', 'high', 30); });
    await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(installLines()).toHaveLength(1);
  });
});

describe("a refused line that is not the subscription's install line", () => {
  it('a refusal of the stop in the bot keeps the install line, so a redelivery writes none', async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' }));
    const pm = newProcess();
    await redeliver(pm, created('ps1'));
    refuse('premium-tiers.audit.jsonl', 'node-stopping');
    expect(await pm.cancelPaidSubscription('g1')).toBe(true);
    recover();
    await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(installLines()).toHaveLength(1);
  });

  it('a refusal in the web UI keeps the install line, so a redelivery writes none', async () => {
    asBot(false);
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' }));
    const pm = newProcess();
    await redeliver(pm, created('ps1'));
    refuse('premium-tiers.audit.jsonl');
    expect(await pm.cancelPaidSubscription('g1')).toBe(true);
    recover();
    await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(installLines()).toHaveLength(1);
  });
});
