import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => (process.env.GUILD_ID = 'g-test', {
  dispatch: [] as Array<{ guildId: string; kind: string }>,
  deliver: (_guildId: string): any => ({ delivered: true, via: 'dm' }),
  provider: null as any,
  lastTestGuild: 'g-old' as string | null,
  savedTestGuild: [] as string[],
  config: {} as Record<string, any>,
}));

vi.mock('../../src/bot/internalSetup/events/clientReady/registerCommands', async (orig) => ({
  ...(await orig<any>()),
  isAutoCleanupEnabled: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', async (orig) => {
  const real = await orig<any>();
  return { ...real, getConfigProperty: (k: string) => (k in h.config ? h.config[k] : real.getConfigProperty(k)) };
});

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', () => ({ resolveNodeRole: () => 'master' }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async (orig) => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: h.lastTestGuild }),
  saveGlobalData: (_file: string, data: any) => { h.savedTestGuild.push(data.guildId); return true; },
  appendData: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: () => h.provider, on: () => undefined }),
}));

import { Client, GatewayIntentBits } from 'discord.js';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import * as notifications from '../../src/bot/internalSetup/utils/premiumNotifications';
import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { deleteModuleCommandsFromDiscord } from '../../src/bot/internalSetup/utils/moduleReloader';
import { postAccessLog } from '../../src/bot/internalSetup/utils/accessLogChannel';
import { toggleCommand } from '../../src/bot/internalSetup/utils/ipcToggleHandler';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DISCORD_TOKEN;
});

describe('the REST token outlives the gateway (R35-J2)', () => {
  it('sets the REST token at buildClient and again after a gateway teardown', async () => {
    process.env.DISCORD_TOKEN = 'tok-1';
    const probe = new Client({ intents: [] });
    const setToken = vi.spyOn(Object.getPrototypeOf(probe.rest), 'setToken');
    const svc = new IngestService();
    const client = svc.buildClient({ intents: [GatewayIntentBits.Guilds] });
    expect(setToken).toHaveBeenCalledWith('tok-1');
    setToken.mockClear();
    await (svc as any).destroySessions('test');
    const calls = setToken.mock.calls.map((c) => c[0]);
    expect(calls[calls.length - 1]).toBe('tok-1');
    await client.destroy().catch(() => undefined);
  });
});

describe('notify answers its real delivery (R35-J2)', () => {
  it('says dropped with a cause when the guild is unreachable', async () => {
    const n = new SubscriptionNotifier();
    n.setClient({ guilds: { fetch: async () => { throw new Error('Unknown Guild'); } } } as any);
    const outcome: any = await n.notify('g1', 'manual.grant.added', { tierName: 'Gold' });
    expect(outcome.delivered).toBe(false);
    expect(String(outcome.cause)).toMatch(/Unknown Guild/);
  });

  it('says delivered by DM when the owner DM went out', async () => {
    const n = new SubscriptionNotifier();
    const guild = { fetchOwner: async () => ({ send: async () => ({}) }) };
    n.setClient({ guilds: { fetch: async () => guild } } as any);
    const outcome: any = await n.notify('g1', 'manual.grant.added', { tierName: 'Gold' });
    expect(outcome).toEqual({ delivered: true, via: 'dm' });
  });

  it('reports dropped when no bot process can deliver it', async () => {
    const outcome: any = await notifications.dispatchPremiumNotification('g1', 'manual.grant.added', {});
    expect(outcome?.delivered).toBe(false);
  });
});

function premiumWith(config: any): PremiumManager {
  const pm = new PremiumManager();
  (pm as any).config = config;
  (pm as any).configLoaded = true;
  (pm as any).configMtimeMs = Number.POSITIVE_INFINITY;
  vi.spyOn(pm, 'save').mockReturnValue(true);
  return pm;
}

const link = (providerId: string, ...variantIds: string[]) => ({
  providerId, enabled: true, mode: 'price',
  cache: { syncedAt: '2026-01-01T00:00:00Z', variants: variantIds.map(variantId => ({ variantId, label: variantId })) },
});

function paidSub(id: string): any {
  return { id, source: 'paid', providerId: 'p', providerSubId: `ps-${id}`, variantId: 'v1', tierId: 'a', offeringId: 'o1' };
}

describe('migration requests are stamped only on delivery (R35-J2)', () => {
  beforeEach(() => {
    h.provider = {
      capabilities: { supportsPriceMigration: true, supportsCancel: true },
      migrateSubscriptionPrice: vi.fn(async () => ({})),
      cancelSubscription: vi.fn(async () => ({})),
    };
  });

  it('stamps notifiedAt for the delivered guild and leaves the undelivered one unstamped', async () => {
    vi.spyOn(notifications, 'dispatchPremiumNotification').mockImplementation(async (guildId: string) =>
      (guildId === 'g1' ? { delivered: true, via: 'dm' } : { delivered: false, cause: 'guild not reachable' }) as any);
    const pm = premiumWith({
      tiers: {
        a: { displayName: 'A', offerings: [{ id: 'o1', providerLinks: [link('p', 'v1')] }] },
        b: { displayName: 'B', offerings: [{ id: 'o2', providerLinks: [link('p', 'v2')] }] },
      },
      subscriptions: { g1: { active: paidSub('s1'), paused: [] }, g2: { active: paidSub('s2'), paused: [] } },
      migrations: [],
      migrationSilencePolicy: 'continue',
    });
    await pm.scheduleMigration({
      providerId: 'p', sourceTierId: 'a', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'b', targetOfferingId: 'o2', targetVariantId: 'v2',
      effectiveDate: new Date(Date.now() + 86400000).toISOString(), message: '',
    });
    await new Promise((r) => setTimeout(r, 20));
    const decisions = (pm as any).config.migrations[0].decisions;
    expect(decisions.find((d: any) => d.guildId === 'g1').notifiedAt).toBeTruthy();
    expect(decisions.find((d: any) => d.guildId === 'g2').notifiedAt).toBeUndefined();
  });

  it('does not apply the silence policy to a request that never reached the owner', async () => {
    vi.spyOn(notifications, 'dispatchPremiumNotification').mockResolvedValue({ delivered: true, via: 'dm' } as any);
    const migration: any = {
      id: 'm1', providerId: 'p', sourceTierId: 'a', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'b', targetOfferingId: 'o2', targetVariantId: 'v2', status: 'pending',
      effectiveDate: new Date(Date.now() - 1000).toISOString(),
      decisions: [
        { guildId: 'g1', subscriptionId: 's1', providerSubId: 'ps-s1', decision: 'pending' },
        { guildId: 'g2', subscriptionId: 's2', providerSubId: 'ps-s2', decision: 'pending', notifiedAt: '2026-10-01T00:00:00.000Z' },
      ],
    };
    const pm = premiumWith({
      tiers: { a: { displayName: 'A', offerings: [{ id: 'o1' }] }, b: { displayName: 'B', offerings: [{ id: 'o2' }] } },
      subscriptions: { g1: { active: paidSub('s1'), paused: [] }, g2: { active: paidSub('s2'), paused: [] } },
      migrations: [migration],
      migrationSilencePolicy: 'continue',
    });
    await pm.processDueMigrations();
    expect(h.provider.migrateSubscriptionPrice).toHaveBeenCalledTimes(1);
    expect(h.provider.migrateSubscriptionPrice).toHaveBeenCalledWith('ps-s2', 'v2', 'none');
    expect(migration.decisions[0].outcome).toBe('skipped');
    expect(migration.decisions[0].decision).toBe('pending');
  });
});

function restCommands() {
  const deleted: string[] = [];
  const commands = {
    fetch: vi.fn(async (opts?: any) => {
      const m = new Map<string, any>();
      if (opts?.guildId === 'g-old') m.set('c1', { id: 'c1', name: 'old', type: 1 });
      return m;
    }),
    create: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    delete: vi.fn(async (id: string, guildId?: string) => { deleted.push(`${guildId}:${id}`); }),
  };
  return { commands, deleted };
}

describe('registration works on a master that holds no shard (R34-J6)', () => {
  beforeEach(() => { h.savedTestGuild.length = 0; h.lastTestGuild = 'g-old'; });

  it('cleans the old test guild through REST when it is not in the cache', async () => {
    const { commands, deleted } = restCommands();
    const client: any = { application: { commands }, guilds: { cache: new Map() } };
    await registerCommands(client);
    expect(deleted).toEqual(['g-old:c1']);
    expect(h.savedTestGuild).toEqual(['g-test']);
  });

  it('keeps the old test guild tracked when its cleanup fails, so the next run retries it', async () => {
    const { commands } = restCommands();
    commands.delete.mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));
    const client: any = { application: { commands }, guilds: { cache: new Map() } };
    await registerCommands(client);
    expect(h.savedTestGuild).toEqual([]);
  });

  it('resolves the application through REST when the gateway never became ready', async () => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const get = vi.spyOn(client.rest, 'get').mockResolvedValue({ id: '123', name: 'app', flags: 0 } as any);
    h.lastTestGuild = 'g-test';
    await registerCommands(client).catch(() => undefined);
    expect(get).toHaveBeenCalled();
    expect(client.application).not.toBeNull();
    await client.destroy().catch(() => undefined);
  });
});

describe('review round rows (C09-2)', () => {
  it('keeps the REST token when a stopped login rejects mid-connect', async () => {
    process.env.DISCORD_TOKEN = 'tok-2';
    const svc = new IngestService();
    const client = svc.buildClient({ intents: [GatewayIntentBits.Guilds] });
    let reject!: (e: Error) => void;
    vi.spyOn(client, 'login').mockImplementation(() => new Promise<string>((_r, rj) => { reject = rj; }));
    const started = svc.start('tok-2');
    await new Promise((r) => setTimeout(r, 0));
    await svc.stop('revoke');
    const setToken = vi.spyOn(client.rest, 'setToken');
    client.rest.setToken(null as any);
    reject(new Error('destroyed mid-connect'));
    await expect(started).resolves.toBe('');
    const calls = setToken.mock.calls.map((c) => c[0]);
    expect(calls[calls.length - 1]).toBe('tok-2');
    await client.destroy().catch(() => undefined);
  });

  it('stamps both decisions of a guild that has two subscriptions on the source variant', async () => {
    h.provider = { capabilities: { supportsPriceMigration: true, supportsCancel: true }, migrateSubscriptionPrice: vi.fn(), cancelSubscription: vi.fn() };
    vi.spyOn(notifications, 'dispatchPremiumNotification').mockResolvedValue({ delivered: true, via: 'dm' } as any);
    const pm = premiumWith({
      tiers: { a: { displayName: 'A', offerings: [{ id: 'o1', providerLinks: [link('p', 'v1')] }] }, b: { displayName: 'B', offerings: [{ id: 'o2', providerLinks: [link('p', 'v2')] }] } },
      subscriptions: { g1: { active: paidSub('s1'), paused: [paidSub('s2')] } },
      migrations: [],
      migrationSilencePolicy: 'continue',
    });
    await pm.scheduleMigration({
      providerId: 'p', sourceTierId: 'a', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'b', targetOfferingId: 'o2', targetVariantId: 'v2',
      effectiveDate: new Date(Date.now() + 86400000).toISOString(), message: '',
    });
    await new Promise((r) => setTimeout(r, 20));
    const decisions = (pm as any).config.migrations[0].decisions;
    expect(decisions.length).toBe(2);
    expect(decisions.every((d: any) => !!d.notifiedAt)).toBe(true);
  });

  it('fetches the guild uncached so a notice does not add it to this node', async () => {
    const fetch = vi.fn(async () => { throw new Error('Unknown Guild'); });
    const n = new SubscriptionNotifier();
    n.setClient({ guilds: { fetch } } as any);
    await n.notify('g1', 'manual.grant.added', { tierName: 'Gold' });
    expect(fetch).toHaveBeenCalledWith({ guild: 'g1', cache: false });
  });

  it('deletes a test-only command through the application with GUILD_ID when the guild is not cached', async () => {
    const del = vi.fn(async () => undefined);
    const commands = {
      fetch: vi.fn(async (opts?: any) => {
        const m = new Map<string, any>();
        if (opts?.guildId === 'g-test') m.set('t1', { id: 't1', name: 'tcmd', type: 1 });
        (m as any).find = (fn: any) => [...m.values()].find(fn);
        return m;
      }),
      delete: del,
    };
    const client: any = { application: { commands }, guilds: { cache: new Map() } };
    await deleteModuleCommandsFromDiscord(client, [{ name: 'tcmd', type: 1, testOnly: true } as any]);
    expect(del).toHaveBeenCalledWith('t1', 'g-test');
  });

  it('logs and deletes nothing when the bot application cannot be resolved', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client: any = { application: null, rest: { get: async () => { throw new Error('401'); } }, guilds: { cache: new Map() } };
    await deleteModuleCommandsFromDiscord(client, [{ name: 'gcmd', type: 1, testOnly: false } as any]);
    expect(err.mock.calls.some((c) => String(c[0]).includes('Commands not deleted from Discord'))).toBe(true);
  });

  it('logs when a test-only command cannot be deleted because GUILD_ID is not set', async () => {
    const saved = process.env.GUILD_ID;
    delete process.env.GUILD_ID;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const commands = { fetch: vi.fn(async () => new Map()), delete: vi.fn() };
      await deleteModuleCommandsFromDiscord({ application: { commands } } as any, [{ name: 'tcmd', type: 1, testOnly: true } as any]);
      expect(err.mock.calls.some((c) => String(c[0]).includes('GUILD_ID is not set'))).toBe(true);
    } finally {
      process.env.GUILD_ID = saved;
    }
  });

  it('posts the access log with an empty guild cache', async () => {
    h.config['security.accessLog.enabled'] = true;
    h.config['security.accessLog.channelId'] = 'ch1';
    const send = vi.fn(async () => ({}));
    const fetch = vi.fn(async (_id: string, opts?: any) => (opts?.allowUnknownGuild ? { isTextBased: () => true, send } : null));
    try {
      await postAccessLog({ channels: { fetch }, guilds: { cache: new Map() } } as any, { uiKind: 'admin', when: Date.now() });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      h.config = {};
    }
  });

  it('toggles a command on a node whose application was never resolved by the gateway', async () => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    vi.spyOn(client.rest, 'get').mockResolvedValue({ id: '123', name: 'app', flags: 0 } as any);
    const result = await toggleCommand(client, 'nope', true);
    expect(result.error).not.toBe('Command manager not available');
    await client.destroy().catch(() => undefined);
  });
});
