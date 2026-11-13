import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a JSON bot (L5 run A, chunk 13-2): the exit line of a replay's audit line queued after the exit
// drain ends with the stored line itself, with no line break after it, when the disk did not confirm its sync and when
// its write was on the wire.

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

import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub, type Hold } from '../helpers/fileHandleStub';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, JOURNAL, logged, paidSub, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

type Manager = ReturnType<typeof getPremiumManager>;
const role = process.env.BOT_PROCESS_ROLE;
let stub: AppendStub;
const holds: Hold[] = [];

beforeEach(async () => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  for (const name of ['holdWrite'] as const) {
    const real = stub[name] as (...args: unknown[]) => Hold;
    (stub as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const hold = real(...args);
      holds.push(hold);
      return hold;
    };
  }
  hooks.confirm = null;
  process.env.BOT_PROCESS_ROLE = 'bot';
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  freshWriterLock('bot', new Set([process.pid]));
  takeWriterLock();
});
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  hooks.confirm = null;
  stub.restore();
  await flushAll();
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  reopenSharedWrites();
  setBackendKind(null);
  vi.restoreAllMocks();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

const expired = (providerSubId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'discord', providerSubId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});

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

function exitLines(pm: Manager): string[] {
  vi.mocked(console.error).mockClear();
  pm.logLossesAtExit();
  return logged(console.error as unknown as { mock: { calls: unknown[][] } });
}

const auditLine = (): string => {
  const lines = (rawOf(AUDIT) ?? '').split('\n').filter(l => l.includes('subscription.expire.paid'));
  expect(lines).toHaveLength(1);
  return lines[0];
};

describe("the exit line of an audit line queued after the exit drain", () => {
  it('whose sync the disk did not confirm ends with the stored line', async () => {
    const pm = await replayAwaitingAfterDrain();
    stub.failSync(AUDIT, 'EIO');
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    const lines = exitLines(pm);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.expire\.paid \(guild g1, [^)]+\) is in the file, but the disk did not confirm its sync; can't confirm whether it is stored: \{/);
    expect(lines[0].endsWith(`stored: ${auditLine()}`)).toBe(true);
  });

  it('whose write was on the wire ends with the line it was writing', async () => {
    const pm = await replayAwaitingAfterDrain();
    const hold = stub.holdWrite(AUDIT, true);
    expect(pm.afterDrain()).toBe(true);
    await hold.reached;
    const lines = exitLines(pm);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.expire\.paid \(guild g1, [^)]+\) was being written before this stop; can't confirm whether it is stored: \{/);
    hold.release();
    await settleQueue();
    expect(lines[0].endsWith(`stored: ${auditLine()}`)).toBe(true);
  });
});
