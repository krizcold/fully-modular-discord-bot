import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 56, row 286 (wip-redesign/sheets/NB6.md decision 76, sheet 3241-3248 and 3397): in the web UI an op's item
// that settles after 8 s holds the local chain's step: its notice goes out before the writer lock is released, and the
// op after it meets no effect of it. The web UI's row ops go out on helpers/nb6WebuiSession.ts's sessions.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ notice: string; lockHeld: boolean }>, lockHeld: (): boolean => false }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push({ notice: `${kind}:${guildId}`, lockHeld: notices.lockHeld() });
    return { delivered: true, via: 'dm' };
  },
}));

import { BotManager } from '../../src/webui/botManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions, type WebuiSessionDeps } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetPremiumItems } from '../../src/bot/internalSetup/utils/premiumItems';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const PREMIUM_KEY = 'global/premium-tiers.json';
const A = 'postgres://bot:pw@a.example:5432/bot';
const role = process.env.BOT_PROCESS_ROLE;
const tier = (name: string, priority: number) => ({ displayName: name, priority, overrides: {}, offerings: [] });

let s: ReturnType<typeof webuiSessions>;
let manager: BotManager;

function deps(): WebuiSessionDeps {
  return {
    target: async () => ({ entry: A, tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await s.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  delete process.env.BOT_PROCESS_ROLE;
  freshWriterLock('webui');
  _resetRowQueue();
  _resetSharedMirror();
  resetPremiumManager();
  _resetPremiumItems();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setGuildDataBackend(null);
  s = webuiSessions();
  s.rows.put(PREMIUM_KEY, JSON.stringify({ tiers: { low: tier('Low', 1) } }, null, 2));
  notices.sent.length = 0;
  notices.lockHeld = () => fs.existsSync(writerLockPath());
  manager = new BotManager();
  useWebuiSessions(deps());
});

afterEach(() => {
  useWebuiSessions(null);
  resetPremiumManager();
  _resetPremiumItems();
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('row 286: an op whose item settles after 8 s in the web UI', () => {
  it('its notice goes out inside the chain step, before the lock is released; the next op meets no effect', async () => {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let held = 0;
    s.state.before = sql => {
      if (!sql.startsWith('BEGIN')) return undefined;
      held += 1;
      return held === 1 ? gate : undefined;
    };
    const started = Date.now();
    const reply = manager.runSharedOp('premium.grantManual', { args: ['g1', 'low', 30] });
    setTimeout(open, 8_500);
    expect(await reply).toMatchObject({ ok: true, result: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_400);
    expect(notices.sent).toEqual([{ notice: 'manual.grant.added:g1', lockHeld: true }]);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(await manager.runLocalOp('next', async () => ({ ok: true, result: notices.sent.length }))).toEqual({ ok: true, result: 1 });
    expect(notices.sent).toHaveLength(1);
  }, 30_000);
});
