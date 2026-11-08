import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { dummyRig } from '../helpers/nb6DummyRig';

// NB6 code review round 2, lane D finding 2 (out/NB6/review2-D.md): an op refused 'changed-elsewhere' while a later
// save is held settles that held save as refused 'changed-elsewhere' and drops the cache, so reads answer the stored
// version at once. The real PremiumManager in the bot process role, the real row flush over the scripted shared tables.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push(`${kind}:${guildId}`);
    return { delivered: true, via: 'dm' };
  },
}));
const inject = vi.hoisted(() => ({ premium: [] as Array<{ cause: string } | null> }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const refuse = f === 'premium-tiers.json' && inject.premium.length > 0 ? inject.premium.shift() : null;
      // The Postgres accept's retried refusal: the row queue closed (dataManager.ts acceptSave).
      if (refuse) throw new real.DataBackendUnavailableError(refuse.cause as any);
      return real.saveDataTracked(f, o, d);
    },
  };
});

const r = premiumRig();
const d = dummyRig(r);

/** Holds every transaction at its BEGIN until released. */
function hold(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  r.m.state.rows.fault = sql => (sql.startsWith('BEGIN') ? gate.then(() => undefined) : undefined);
  return () => {
    r.m.state.rows.fault = undefined;
    release();
  };
}

beforeEach(async () => {
  await d.setup();
  notices.sent.length = 0;
  inject.premium.length = 0;
});
afterEach(async () => {
  inject.premium.length = 0;
  await d.teardown();
});

describe("R2-D2: an op refused 'changed-elsewhere' while a later save is held", () => {
  it('settles the held save as refused at once and reads the stored version', async () => {
    const pm = r.pm();
    expect(await pm.grantManual('g0', 'gold', 30)).toBe(true);
    await d.settle();
    expect(r.row().subscriptions?.g0).toBeDefined();
    const release = hold();
    expect(await pm.grantManual('g1', 'gold', 30)).toBe(true);
    inject.premium.push({ cause: 'database-backlog' });
    expect(await pm.grantManual('g2', 'gold', 30)).toBe(true);
    await d.otherPremium(config => { config.messages = { ...(config.messages ?? {}), moduleBlocked: 'from BRAVO' }; });
    release();
    await d.settle();
    expect(pm.getGuildSubscriptions('g1')?.active ?? null).toBeNull();
    expect(pm.getGuildSubscriptions('g2')?.active ?? null).toBeNull();
    // The mirror's file is the last version this machine stored until the next pass brings BRAVO's.
    await d.otherPremium(() => undefined);
    expect(pm.getMessages().moduleBlocked).toBe('from BRAVO');
    expect(pm.getGuildSubscriptions('g0')?.active?.tierId).toBe('gold');
    const grants = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.grant.manual');
    expect(grants.map(l => [l.guildId, l.metadata?.notSaved?.cause]).sort()).toEqual([['g0', undefined], ['g1', 'changed-elsewhere'], ['g2', 'changed-elsewhere']]);
    expect((pm as any).saveHeld).toBe(false);
    expect(notices.sent).toEqual(['manual.grant.added:g0']);
    expect(r.row().subscriptions?.g1).toBeUndefined();
    expect(r.row().subscriptions?.g2).toBeUndefined();
  }, 20_000);
});
