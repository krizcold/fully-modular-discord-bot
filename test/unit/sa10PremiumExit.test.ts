import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ confirm: null as null | ((ticket: unknown, ms: number) => Promise<string>) }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return { ...real, confirmFile: (ticket: any, ms: number) => (hooks.confirm ? hooks.confirm(ticket, ms) : real.confirmFile(ticket, ms)) };
});
// The folder chain of every save fails as the device answers it on Linux; Windows has no folder sync.
const chain = vi.hoisted(() => ({ fail: null as null | { kind: 'sync' | 'open' | 'earlier'; errno: string }, dirs: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      if (!chain.fail) return real.syncFolderChain(dir);
      chain.dirs.push(dir);
      const error = Object.assign(new Error(`${chain.fail.errno}: folder sync`), { code: chain.fail.errno });
      return { failed: true, kind: chain.fail.kind, dir, errno: chain.fail.errno, error };
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

import { flushAll, forgetDurableFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, JOURNAL, linesOf, logged, paidSub, PREMIUM, settleQueue, state, writePremium } from './nb10PremiumRig';
import { gh } from '../helpers/p1Holder';

// NB19 T23 on any platform: premium's exit line for a line whose folder sync failed says the line is in the file and
// synced, then the clause of that failure, and quotes the line without its newline.

const role = process.env.BOT_PROCESS_ROLE;
type Manager = ReturnType<typeof getPremiumManager>;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  chain.fail = null;
  chain.dirs = [];
  process.env.BOT_PROCESS_ROLE = 'bot';
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  forgetDurableFiles();
  freshWriterLock('bot', new Set([process.pid]));
  takeWriterLock();
});
afterEach(async () => {
  hooks.confirm = null;
  chain.fail = null;
  await flushAll();
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  reopenSharedWrites();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

const errors = (): string[] => logged(console.error as unknown as { mock: { calls: unknown[][] } });
function newProcess(): Manager {
  resetPremiumManager();
  reg.current = null;
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { sells: ['guild'], supportsCancel: true }, isConfigured: () => true,
    handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString())); },
    cancelSubscription: async () => undefined,
  } as any);
  return getPremiumManager();
}
const created = (providerSubId: string, guildId = '70000000000000001') => ({
  type: 'subscription.created', buyerId: '80000000000000001', providerId: 'fake', providerSubId, holder: gh(guildId), tierId: 'low', offeringId: 'o1', state: state(),
});
const deliver = (event: object) => applySharedOp({ op: 'payment.webhook', args: { providerId: 'fake', body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' } });
const exitLines = (pm: Manager): string[] => {
  vi.mocked(console.error).mockClear();
  pm.logLossesAtExit();
  return errors().filter(l => l.startsWith('[PremiumManager]'));
};
const GLOBAL_DIR = path.dirname(JOURNAL);
const arm = () => { chain.fail = { kind: 'sync', errno: 'EIO' }; };
const why = () => syncWords('sync', GLOBAL_DIR, 'EIO').why;

describe("premium's exit lines when a folder sync failed", () => {
  it('a journal line: in the file and synced, the clause, and the event; never the file fsync text', async () => {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = newProcess();
    expect(pm.cacheState()).toBe('unreadable');
    arm();
    const event = created('ps1');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(1);
    expect(chain.dirs).toContain(GLOBAL_DIR);
    const head = '[PremiumManager] A subscription.created event from fake (subscription ps1, guild 70000000000000001) was received while premium-tiers.json could not be read';
    expect(exitLines(pm)).toEqual([`${head}; its journal line is in the file and synced, but ${why()}, so can't confirm whether it is stored: ${JSON.stringify(event)}`]);
  });

  it('an install line: in the file and synced, the clause, then can\'t confirm', async () => {
    writePremium();
    arm();
    const pm = newProcess();
    await deliver(created('ps1'));
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid').map(l => l.holder)).toEqual(['guild:70000000000000001']);
    const install = exitLines(pm).filter(l => l.includes('subscription.install.paid'));
    expect(install).toHaveLength(1);
    expect(install[0].startsWith(`[PremiumManager] The audit line subscription.install.paid (guild 70000000000000001, subscription ps1) is in the file and synced, but ${why()}; can't confirm whether it is stored`)).toBe(true);
  });

  it('an after-drain audit line: in the file and synced, the clause, and the stored line without its newline', async () => {
    const expired = {
      type: 'subscription.expired', providerId: 'discord', providerSubId: 'ps0', holder: 'guild:70000000000000001',
      state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
    };
    writePremium({ 'guild:70000000000000001': { active: paidSub('sA', 'ps0', 'low', 'discord'), paused: [] } });
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: expired })}\n`);
    hooks.confirm = () => new Promise<string>(() => undefined);
    const pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await flushAll();
    hooks.confirm = null;
    forgetDurableFiles();
    arm();
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    const lines = exitLines(pm);
    expect(lines).toHaveLength(1);
    const head = /^(\[PremiumManager\] The audit line subscription\.expire\.paid \(guild 70000000000000001, [^)]+\)) /.exec(lines[0]);
    expect(head, lines[0]).not.toBeNull();
    const stored = fs.readFileSync(AUDIT, 'utf8').trimEnd().split('\n').pop()!;
    expect(JSON.parse(stored)).toMatchObject({ action: 'subscription.expire.paid', holder: 'guild:70000000000000001' });
    expect(lines[0]).toBe(`${head![1]} is in the file and synced, but ${why()}; can't confirm whether it is stored: ${stored}`);
  });
});
