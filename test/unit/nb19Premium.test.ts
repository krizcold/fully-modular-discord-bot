import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ confirm: null as null | ((ticket: unknown, ms: number) => Promise<string>) }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return { ...real, confirmFile: (ticket: any, ms: number) => (hooks.confirm ? hooks.confirm(ticket, ms) : real.confirmFile(ticket, ms)) };
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

import { confirmFile, enqueueWrite, fileTicket, flushAll, forgetDurableFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, JOURNAL, linesOf, logged, paidSub, PREMIUM, settleQueue, state, writePremium } from './nb10PremiumRig';

// NB19 T23: premium's exit lines for a line whose range carries a folder sync kind say the line is in the file and
// synced, then the kind's clause; a failed file fsync keeps "the disk did not confirm its sync".

const POSIX = process.platform !== 'win32';
const GLOBAL = path.resolve(dataPath('global'));
const role = process.env.BOT_PROCESS_ROLE;
type Manager = ReturnType<typeof getPremiumManager>;
let stub: AppendStub;
let n = 0;

beforeEach(async () => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  process.env.BOT_PROCESS_ROLE = 'bot';
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  freshWriterLock('bot', new Set([process.pid]));
  takeWriterLock();
});
afterEach(async () => {
  hooks.confirm = null;
  stub.restore();
  await flushAll();
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  reopenSharedWrites();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  setBackendKind(null);
  vi.restoreAllMocks();
});

const errors = (): string[] => logged(console.error as unknown as { mock: { calls: unknown[][] } });
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
const deliver = (event: object) => applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } });
const exitLines = (pm: Manager): string[] => {
  vi.mocked(console.error).mockClear();
  pm.logLossesAtExit();
  return errors();
};
const journalHead = (event: { type: string; providerId: string; providerSubId: string; guildId: string }) =>
  `[PremiumManager] A ${event.type} event from ${event.providerId} (subscription ${event.providerSubId}, guild ${event.guildId}) was received while premium-tiers.json could not be read`;

async function setFlagAt(): Promise<string> {
  const x = dataPath(`nb19premx${process.pid}${++n}`);
  stub.failDirSync(x, 'EIO');
  const p = path.join(x, 'f.json');
  enqueueWrite(p, '{}');
  expect(await confirmFile(fileTicket(p), 3000)).toBe('unavailable');
  return path.resolve(x);
}
function brokenProcess(): Manager {
  fs.writeFileSync(PREMIUM, '{ broken');
  const pm = newProcess();
  expect(pm.cacheState()).toBe('unreadable');
  return pm;
}

describe.skipIf(!POSIX)('row 75: premium\'s exit lines', () => {
  it('a journal line under a flag set by /data/x: T23 with the earlier clause', async () => {
    const x = await setFlagAt();
    const pm = brokenProcess();
    const event = created('ps1');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(1);
    const { why } = syncWords('earlier', x, 'EIO');
    expect(exitLines(pm)).toEqual([`${journalHead(event)}; its journal line is in the file and synced, but ${why}, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
  });

  it('a journal line whose folder open fails with EMFILE: T23 with the open clause', async () => {
    const pm = brokenProcess();
    stub.rejectDirOpen(GLOBAL, 'EMFILE', 1);
    const event = created('ps1');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(1);
    const { why } = syncWords('open', GLOBAL, 'EMFILE');
    const lines = exitLines(pm);
    expect(lines).toEqual([`${journalHead(event)}; its journal line is in the file and synced, but ${why}, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
    expect(lines[0]).not.toContain('the disk did not confirm the sync of its journal line');
  });

  it('a journal line whose file fsync failed keeps today\'s text', async () => {
    const pm = brokenProcess();
    stub.failSync(JOURNAL, 'EIO');
    const event = created('ps1');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(exitLines(pm)).toEqual([`${journalHead(event)}; the disk did not confirm the sync of its journal line, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
  });

  it.each(['earlier', 'open'] as const)('an install line in a range of kind %s: T23 with that clause', async kind => {
    writePremium();
    const x = kind === 'earlier' ? await setFlagAt() : GLOBAL;
    const pm = newProcess();
    if (kind === 'open') {
      // The save of premium-tiers.json syncs the same folder at the same time: the rejection waits for that sync.
      const closes = () => stub.dirCloses.filter(d => d === GLOBAL).length;
      const before = closes();
      const held = stub.holdSync(AUDIT);
      const delivered = deliver(created('ps1'));
      await held.reached;
      await vi.waitFor(() => expect(closes()).toBeGreaterThan(before), { timeout: 5000, interval: 5 });
      stub.rejectDirOpen(GLOBAL, 'EMFILE', 1);
      held.release();
      await delivered;
    } else await deliver(created('ps1'));
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid').map(l => l.guildId)).toEqual(['g1']);
    const { why } = syncWords(kind, x, kind === 'earlier' ? 'EIO' : 'EMFILE');
    const install = exitLines(pm).filter(l => l.includes('subscription.install.paid'));
    expect(install).toHaveLength(1);
    expect(install[0].startsWith(`[PremiumManager] The audit line subscription.install.paid (guild g1, subscription ps1) is in the file and synced, but ${why}; can't confirm whether it is stored`)).toBe(true);
    expect(install[0]).not.toContain('the disk did not confirm its sync');
  });

  /** A replay whose marks' save landed while its watch still waits, so afterDrain queues its audit line. */
  async function replayAwaitingAfterDrain(): Promise<Manager> {
    const expired = {
      type: 'subscription.expired', providerId: 'discord', providerSubId: 'ps0', guildId: 'g1',
      state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
    };
    writePremium({ g1: { active: paidSub('sA', 'ps0', 'low', 'discord'), paused: [] } });
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: expired })}\n`);
    hooks.confirm = () => new Promise<string>(() => undefined);
    const pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await flushAll();
    return pm;
  }
  const afterDrainHead = /^(\[PremiumManager\] The audit line subscription\.expire\.paid \(guild g1, [^)]+\)) /;
  const lastAuditLine = () => fs.readFileSync(AUDIT, 'utf8').trimEnd().split('\n').pop()!;

  it.each(['earlier', 'open'] as const)('an after-drain audit line in a range of kind %s: T23 with that clause', async kind => {
    const pm = await replayAwaitingAfterDrain();
    hooks.confirm = null;
    forgetDurableFiles();
    const x = kind === 'earlier' ? await setFlagAt() : GLOBAL;
    if (kind === 'open') stub.rejectDirOpen(GLOBAL, 'EMFILE', 1);
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    const lines = exitLines(pm);
    expect(lines).toHaveLength(1);
    const head = afterDrainHead.exec(lines[0]);
    expect(head, lines[0]).not.toBeNull();
    const { why } = syncWords(kind, x, kind === 'earlier' ? 'EIO' : 'EMFILE');
    expect(lines[0]).toBe(`${head![1]} is in the file and synced, but ${why}; can't confirm whether it is stored: ${lastAuditLine()}`);
    expect(JSON.parse(lastAuditLine())).toMatchObject({ action: 'subscription.expire.paid', guildId: 'g1' });
    expect(lines[0]).not.toContain('the disk did not confirm its sync');
  });
});
