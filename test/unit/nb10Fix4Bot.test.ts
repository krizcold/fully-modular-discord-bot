import fs from 'fs';
import ts from 'typescript';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 4, the fixer's regression tests for the reply findings: the provider-link unlink as one op
// (O1), the bot's report once its boot takes the lock after a wait (O2), and a wait for a holder it cannot name (O3).

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
vi.mock('../../src/webui/auth/oauthMiddleware', () => ({
  requireOAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireGuildAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { releaseWriterLock, takeWriterLockForBoot, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { BotManager, ROUTE_TEXT } from '../../src/webui/botManager';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { startApp } from '../helpers/configRig';
import { forks } from '../helpers/forkMock';
import { exitChild, freshWriterLock, report, resetForks, startedWith } from '../helpers/nb10Rig';
import { clearGlobal, jsonOf, paidSub, PREMIUM, settleQueue, writePremium } from './nb10PremiumRig';

const G = '900000000000000777';
const role = process.env.BOT_PROCESS_ROLE;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

function seedLinked(): void {
  writePremium(
    { [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [{ ...paidSub('sP', 'pP', 'high', 'patreon'), status: 'paused' }] } },
    { providerAccountLinks: { patreon: { acct1: G } } },
  );
}

describe('the provider-link DELETE as one op (O1)', () => {
  it('sends one shared op, which cancels both subscriptions and removes the link', async () => {
    seedLinked();
    const ops: string[] = [];
    const manager = { runSharedOp: async (op: string, args: unknown) => { ops.push(op); return applySharedOp({ op, args }); } };
    const app = await startApp(a => a.use('/guild/api/subscriptions', createGuildSubscriptionRoutes(manager as any)));
    try {
      const res = await fetch(`${app.url}/guild/api/subscriptions/${G}/provider-links/patreon`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(ops).toEqual(['premium.unlinkProviderAccount']);
      await settleQueue();
      const stored = jsonOf(PREMIUM);
      expect(stored.providerAccountLinks.patreon).toBeUndefined();
      expect(stored.subscriptions[G]).toBeUndefined();
      const again = await fetch(`${app.url}/guild/api/subscriptions/${G}/provider-links/patreon`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a provider cancel that fails keeps the link, so the same request finishes the change', async () => {
    seedLinked();
    let fail = true;
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'Patreon', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => { if (fail) throw new Error('Patreon did not answer'); },
    } as any);
    const first: any = await applySharedOp({ op: 'premium.unlinkProviderAccount', args: { args: [G, 'patreon'] } });
    expect(first.ok).toBe(false);
    expect(first.error).not.toContain('nothing was saved');
    await settleQueue();
    expect(jsonOf(PREMIUM).providerAccountLinks.patreon).toEqual({ acct1: G });
    expect(getPremiumManager().getFullConfig().providerAccountLinks.patreon).toEqual({ acct1: G });
    fail = false;
    expect(await applySharedOp({ op: 'premium.unlinkProviderAccount', args: { args: [G, 'patreon'] } })).toEqual({ ok: true, result: true });
    await settleQueue();
    expect(jsonOf(PREMIUM).providerAccountLinks.patreon).toBeUndefined();
    expect(jsonOf(PREMIUM).subscriptions[G]).toBeUndefined();
  });
});

describe("the bot's report once its boot takes the lock after a wait (O2)", () => {
  it('takeWriterLockForBoot reports opening after a waiting report, and nothing more for a take at once', async () => {
    const sent: any[] = [];
    const hadSend = process.send;
    (process as any).send = (message: unknown) => { sent.push(message); return true; };
    try {
      freshWriterLock('bot', new Set([process.pid, 77]));
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 77, start: null, role: 'webui', at: Date.now() }));
      await takeWriterLockForBoot(async () => { fs.rmSync(writerLockPath(), { force: true }); });
      expect(sent.map(m => m.data.stage)).toEqual(['waiting', 'opening']);
      releaseWriterLock();
      sent.length = 0;
      await takeWriterLockForBoot(async () => undefined);
      expect(sent).toEqual([]);
      releaseWriterLock();
    } finally {
      (process as any).send = hadSend;
    }
  });

  it('BotManager drops the wait at opening: no wait in the status, and writes get the starting text', async () => {
    const { manager } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }, { stage: 'opening' }]);
    const status = manager.getStatus();
    expect(status.dataFiles ?? null).toBeNull();
    expect(status.mode).not.toBe('waiting-for-data-files');
    expect(manager.writeRefusal('shared')).toMatchObject({ code: 'starting', error: ROUTE_TEXT.starting });
  });

  it('a start whose child reported opening within the wait answers no wait', async () => {
    forks.onFork = child => { setTimeout(() => { report(child, { stage: 'waiting', holder: { role: 'webui', pid: 77 } }); report(child, { stage: 'opening' }); }, 1); };
    forks.holdExit = true;
    const answer = await new BotManager().start();
    forks.onFork = null;
    expect(answer).toEqual({ success: true });
  });
});

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/BotControlPanel.jsx', import.meta.url));

function panelHelper(): (info: any) => string | null {
  const compiled = ts.transpileModule(fs.readFileSync(PANEL, 'utf-8'), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function('React', `${compiled}\nreturn botDataFilesText;`)({});
}

describe('a start while the child waits for a holder it cannot name (O3)', () => {
  it('answers waiting, and the panel shows the wait instead of a successful start', async () => {
    forks.onFork = child => { setTimeout(() => report(child, { stage: 'waiting', holder: null }), 1); };
    forks.holdExit = true;
    const answer = await new BotManager().start();
    forks.onFork = null;
    expect(answer).toEqual({ success: true, waiting: true });
    expect(panelHelper()(answer)).toBe('Waiting for another process to release the data files');
  });
});
