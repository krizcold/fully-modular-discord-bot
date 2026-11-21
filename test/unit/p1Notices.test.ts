import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 15, part 2: a notice takes a holder from premium to the Discord call. The notifier, the dispatch and the
// bot's IPC handler are the real ones; Discord is a fake client that records every call in order. The manager is the
// world's, so a server's notices channel is the one the setNotificationsChannelId op stored.
// P2 claim 12 (parts 0 and 2): the notice of a server's and of a user's purchase runs through the P1 seller and the
// real Dummy provider.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));

import { SubscriptionNotifier, getSubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import { dispatchPremiumNotification, setNotificationIPCDispatcher } from '../../src/bot/internalSetup/utils/premiumNotifications';
import { setupIPCNotificationHandler } from '../../src/bot/internalSetup/utils/ipcNotificationHandler';
import { BotManager } from '../../src/webui/botManager';
import { SERVERS, eachSeller, p1World, type SellerDriver } from '../helpers/p1World';

let w: ReturnType<typeof p1World>;
const SERVER = SERVERS[0];
const USER = '80000000000000007';
const OWNER = '80000000000000009';
const serverHolder = `guild:${SERVER}` as const;
const userHolder = `user:${USER}` as const;

interface FakeDiscord {
  ownerDm?: 'fails';
  recordChannel?: 'fails' | 'missing';
  systemChannel?: 'fails' | 'none';
  guild?: 'unknown';
  userDm?: Error | string;
}

function discord(how: FakeDiscord = {}) {
  const calls: string[] = [];
  const sent: Array<{ to: string; text: string }> = [];
  const channel = (id: string, fails: boolean) => ({
    id,
    send: async (text: string) => {
      calls.push(`channel.send ${id}`);
      if (fails) throw new Error('Missing Access');
      sent.push({ to: `channel ${id}`, text });
    },
  });
  const guild = {
    fetchOwner: async () => {
      calls.push('guild.fetchOwner');
      return {
        send: async (text: string) => {
          calls.push('owner.send');
          if (how.ownerDm === 'fails') throw new Error('Cannot send messages to this user');
          sent.push({ to: `user ${OWNER}`, text });
        },
      };
    },
    systemChannel: how.systemChannel === 'none' ? null : channel('system1', how.systemChannel === 'fails'),
  };
  const client = {
    guilds: {
      fetch: async (options: unknown) => {
        calls.push(`guilds.fetch ${JSON.stringify(options)}`);
        if (how.guild === 'unknown') throw new Error('Unknown Guild');
        return guild;
      },
    },
    channels: {
      fetch: async (id: string, options: unknown) => {
        calls.push(`channels.fetch ${id} ${JSON.stringify(options)}`);
        if (how.recordChannel === 'missing') throw new Error('Unknown Channel');
        return channel(id, how.recordChannel === 'fails');
      },
    },
    users: {
      send: async (id: string, text: string) => {
        calls.push(`users.send ${id}`);
        if (how.userDm !== undefined) throw how.userDm;
        sent.push({ to: `user ${id}`, text });
      },
    },
  };
  const notifier = new SubscriptionNotifier();
  notifier.setClient(client as any);
  return { notifier, client, calls, sent };
}

const FETCH = `guilds.fetch {"guild":"${SERVER}","cache":false}`;
const RECORD_CHANNEL = 'channels.fetch chan1 {"allowUnknownGuild":true}';
const warned = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));

let warn: ReturnType<typeof vi.spyOn>;

/** The world of the rows that follow, on this driver's seller. */
function useWorld(driver: SellerDriver): void {
  const world = p1World('json', driver);
  beforeEach(async () => {
    w = world;
    await w.setup();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await w.teardown();
  });
}

describe('P1 claim 15: a server holder is delivered as a server is today', () => eachSeller(['p1seller'], make => {
  useWorld(make());
  beforeEach(async () => {
    const reply = await w.setNoticesChannel(SERVER, 'chan1');
    expect(reply.ok).toBe(true);
    warn.mockClear();
  });

  it("fetches the server uncached and sends the owner a direct message, with the server's two texts", async () => {
    const d = discord();
    const granted = await d.notifier.notify(serverHolder, 'manual.grant.added', { tierName: 'Gold' });
    const started = await d.notifier.notify(serverHolder, 'paid.sub.started', { tierName: 'Gold', providerName: 'Seller' });

    expect([granted, started]).toStrictEqual([{ delivered: true, via: 'dm' }, { delivered: true, via: 'dm' }]);
    expect(d.calls).toEqual([FETCH, 'guild.fetchOwner', 'owner.send', FETCH, 'guild.fetchOwner', 'owner.send']);
    expect(d.sent).toEqual([
      { to: `user ${OWNER}`, text: '**Premium granted:** Your server now has **Gold**.' },
      { to: `user ${OWNER}`, text: '**Subscription active:** **Gold** (Seller) is now active for your server.' },
    ]);
    expect(warned(warn)).toEqual([]);
  });

  it("falls back to the record's notices channel when the owner's direct message fails", async () => {
    const d = discord({ ownerDm: 'fails' });
    const outcome = await d.notifier.notify(serverHolder, 'manual.grant.added', { tierName: 'Gold' });

    expect(outcome).toStrictEqual({ delivered: true, via: 'channel', channelId: 'chan1' });
    expect(d.calls).toEqual([FETCH, 'guild.fetchOwner', 'owner.send', RECORD_CHANNEL, 'channel.send chan1']);
    expect(d.sent).toEqual([{ to: 'channel chan1', text: '**Premium granted:** Your server now has **Gold**.' }]);
  });

  it("falls back to the system channel when the record's channel fails too", async () => {
    const d = discord({ ownerDm: 'fails', recordChannel: 'fails' });
    const outcome = await d.notifier.notify(serverHolder, 'manual.grant.added', { tierName: 'Gold' });

    expect(outcome).toStrictEqual({ delivered: true, via: 'channel', channelId: 'system1' });
    expect(d.calls).toEqual([FETCH, 'guild.fetchOwner', 'owner.send', RECORD_CHANNEL, 'channel.send chan1', 'channel.send system1']);
    expect(d.sent).toEqual([{ to: 'channel system1', text: '**Premium granted:** Your server now has **Gold**.' }]);
  });

  it('answers not delivered, with one warning, when every path fails', async () => {
    const d = discord({ ownerDm: 'fails', recordChannel: 'missing', systemChannel: 'fails' });
    const outcome = await d.notifier.notify(serverHolder, 'manual.grant.added', { tierName: 'Gold' });

    expect(outcome).toStrictEqual({ delivered: false, cause: 'the owner DM, the notifications channel and the system channel all failed' });
    expect(d.calls).toEqual([FETCH, 'guild.fetchOwner', 'owner.send', RECORD_CHANNEL, 'channel.send system1']);
    expect(d.sent).toEqual([]);
    expect(warned(warn)).toEqual([`[SubscriptionNotifier] no delivery path for manual.grant.added on guild ${SERVER}; notification dropped`]);
  });

  it('answers not delivered when the server cannot be fetched, and sends nothing', async () => {
    const d = discord({ guild: 'unknown' });
    const outcome = await d.notifier.notify(serverHolder, 'manual.grant.added', { tierName: 'Gold' });

    expect(outcome).toStrictEqual({ delivered: false, cause: 'guild not reachable (Unknown Guild)' });
    expect(d.calls).toEqual([FETCH]);
    expect(warned(warn)).toEqual([`[SubscriptionNotifier] guild ${SERVER} not reachable; cannot deliver manual.grant.added: guild not reachable (Unknown Guild)`]);
  });
}));

describe('P1 claim 15: a user holder gets one direct message', () => eachSeller(['p1seller'], make => {
  useWorld(make());
  it('sends one direct message to that user, fetches no server, and words the two texts for a user', async () => {
    const d = discord();
    const granted = await d.notifier.notify(userHolder, 'manual.grant.added', { tierName: 'VIP' });
    const started = await d.notifier.notify(userHolder, 'paid.sub.started', { tierName: 'VIP', providerName: 'Seller' });

    expect([granted, started]).toStrictEqual([{ delivered: true, via: 'dm' }, { delivered: true, via: 'dm' }]);
    expect(d.calls).toEqual([`users.send ${USER}`, `users.send ${USER}`]);
    expect(d.sent).toEqual([
      { to: `user ${USER}`, text: '**Premium granted:** You now have **VIP**.' },
      { to: `user ${USER}`, text: '**Subscription active:** **VIP** (Seller) is now active for you.' },
    ]);
    expect(warned(warn)).toEqual([]);
  });

  it("keeps every other text as a server's", async () => {
    const forServer = discord();
    const forUser = discord();
    const kinds = ['manual.grant.ended', 'manual.grant.revoked', 'paid.sub.paused-by-stacking', 'paid.sub.expired', 'tier.config-change-affecting-subscriber'] as const;
    for (const kind of kinds) {
      await forServer.notifier.notify(serverHolder, kind, { tierName: 'T', providerName: 'Seller', reason: 'r', details: 'd', remainingDays: 3 });
      await forUser.notifier.notify(userHolder, kind, { tierName: 'T', providerName: 'Seller', reason: 'r', details: 'd', remainingDays: 3 });
    }

    expect(forUser.sent.map(s => s.text)).toEqual(forServer.sent.map(s => s.text));
    expect(forUser.sent).toHaveLength(kinds.length);
  });

  it("answers not delivered with L5 when the user's direct messages fail, and tries no channel", async () => {
    const d = discord({ userDm: new Error('Cannot send messages to this user') });
    const outcome = await d.notifier.notify(userHolder, 'manual.grant.added', { tierName: 'VIP' });

    const cause = "the user's direct messages could not be reached (Cannot send messages to this user)";
    expect(outcome).toStrictEqual({ delivered: false, cause });
    expect(d.calls).toEqual([`users.send ${USER}`]);
    expect(warned(warn)).toEqual([`[SubscriptionNotifier] manual.grant.added for user ${USER} was not delivered: ${cause}`]);
  });

  it('shows a failure that is no Error as text', async () => {
    const d = discord({ userDm: 'socket closed' });
    const outcome = await d.notifier.notify(userHolder, 'paid.sub.expired', { tierName: 'VIP' });

    expect(outcome).toStrictEqual({ delivered: false, cause: "the user's direct messages could not be reached (socket closed)" });
  });

  it('sends nothing for a text that is no holder', async () => {
    const d = discord();
    const outcomes = [];
    for (const text of [SERVER, 'guild:g1', 'Guild:5', 'user:05', '']) outcomes.push(await d.notifier.notify(text as any, 'manual.grant.added', { tierName: 'Gold' }));

    expect(outcomes.map(o => o.delivered)).toEqual([false, false, false, false, false]);
    expect((outcomes[0] as any).cause).toBe(`'${SERVER}' is not a holder: expected guild:<id> or user:<id> with a Discord id.`);
    expect(d.calls).toEqual([]);
  });
}));

describe('P1 claim 15, part 3: what premium sends a user', () => eachSeller(['p1seller'], make => {
  useWorld(make());
  const stricter = (kind: 'user' | 'guild', count: number) => ({ displayName: kind === 'user' ? 'VIP' : 'Gold', priority: 5, overrides: { p1mod: { count } }, offerings: [], ...(kind === 'user' ? { kind } : {}) });

  it('a stricter change of a user tier sends its user the details without the panel sentence, a server its sentence', async () => {
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    expect((await w.op('setTier', 'vip', stricter('user', 10))).ok).toBe(true);
    expect((await w.op('setTier', 'gold', stricter('guild', 10))).ok).toBe(true);
    expect((await w.grant(userHolder, 'vip', 30)).ok).toBe(true);
    expect((await w.grant(serverHolder, 'gold', 30)).ok).toBe(true);
    notify.mockClear();

    expect((await w.op('setTier', 'vip', stricter('user', 5))).ok).toBe(true);
    expect((await w.op('setTier', 'gold', stricter('guild', 5))).ok).toBe(true);

    expect(notify.mock.calls).toEqual([
      [userHolder, 'tier.config-change-affecting-subscriber', { tierName: 'VIP', details: 'Some perks or limits were reduced.' }],
      [serverHolder, 'tier.config-change-affecting-subscriber', { tierName: 'Gold', details: 'Some perks or limits were reduced. Open the subscription panel to see the latest tier contents.' }],
    ]);
  });

  it('setNotificationsChannelId for a user throws X9 and stores nothing, with and without a record', async () => {
    vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    expect((await w.op('setTier', 'vip', stricter('user', 10))).ok).toBe(true);
    const none = { premium: w.storedText(), audit: w.auditText() };
    const withoutRecord = await w.setNoticesChannel(userHolder, 'chan1');
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(none);

    expect((await w.grant(userHolder, 'vip', 30)).ok).toBe(true);
    const held = { premium: w.storedText(), audit: w.auditText() };
    const withRecord = await w.setNoticesChannel(userHolder, 'chan1');
    const cleared = await w.setNoticesChannel(userHolder, null);

    for (const reply of [withoutRecord, withRecord, cleared]) {
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain("Notices for a user go to that user's direct messages; there is no channel to set.");
    }
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(held);
    expect(w.recordOf(userHolder).notificationsChannelId).toBeUndefined();
  });
}));

describe('P1 claim 15: the dispatch carries the holder', () => eachSeller(['p1seller'], make => {
  useWorld(make());
  it('premium names the server of a notice as its holder', async () => {
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    const reply = await w.grant(SERVER, 'low', 30);

    expect(reply.ok).toBe(true);
    expect(notify.mock.calls.map(c => [c[0], c[1]])).toEqual([[serverHolder, 'manual.grant.added']]);
  });

  it('in the bot it hands the holder to the notifier', async () => {
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    const outcome = await dispatchPremiumNotification(userHolder, 'manual.grant.added', { tierName: 'VIP' });

    expect(outcome).toStrictEqual({ delivered: true, via: 'dm' });
    expect(notify.mock.calls).toEqual([[userHolder, 'manual.grant.added', { tierName: 'VIP' }]]);
  });

  it('in the web UI it hands the holder to the registered bridge, and names the holder when there is none', async () => {
    process.env.BOT_PROCESS_ROLE = 'webui';
    const seen: unknown[][] = [];
    setNotificationIPCDispatcher(async (...args: unknown[]) => { seen.push(args); return { delivered: true, via: 'dm' }; });
    const bridged = await dispatchPremiumNotification(userHolder, 'paid.sub.started', { tierName: 'VIP' });
    setNotificationIPCDispatcher(null as any);
    const forUser = await dispatchPremiumNotification(userHolder, 'paid.sub.started', { tierName: 'VIP' });
    const forServer = await dispatchPremiumNotification(serverHolder, 'paid.sub.started', { tierName: 'Gold' });

    expect(bridged).toStrictEqual({ delivered: true, via: 'dm' });
    expect(seen).toEqual([[userHolder, 'paid.sub.started', { tierName: 'VIP' }]]);
    expect([forUser, forServer]).toStrictEqual([
      { delivered: false, cause: 'no bot process to deliver it' },
      { delivered: false, cause: 'no bot process to deliver it' },
    ]);
    expect(warned(warn)).toEqual([
      `[PremiumNotifications] paid.sub.started for user ${USER} dropped: no bot process to deliver it`,
      `[PremiumNotifications] paid.sub.started for guild ${SERVER} dropped: no bot process to deliver it`,
    ]);
  });

  it("the web UI's bot manager sends { holder, kind, payload } to the bot", async () => {
    const messages: unknown[][] = [];
    const manager = {
      isRunning: () => true,
      sendIPCMessage: async (...args: unknown[]) => { messages.push(args); return { success: true, outcome: { delivered: true, via: 'dm' } }; },
    };
    const outcome = await BotManager.prototype.dispatchNotification.call(manager as any, userHolder, 'manual.grant.added', { tierName: 'VIP' });

    expect(outcome).toStrictEqual({ delivered: true, via: 'dm' });
    expect(messages).toStrictEqual([['notification:dispatch', { holder: userHolder, kind: 'manual.grant.added', payload: { tierName: 'VIP' } }]]);
  });
}));

describe("P1 claim 15: the bot's handler of notification:dispatch", () => eachSeller(['p1seller'], make => {
  useWorld(make());
  async function handler() {
    const replies: any[] = [];
    const hadSend = Object.prototype.hasOwnProperty.call(process, 'send');
    const oldSend = process.send;
    (process as any).send = (message: unknown) => { replies.push(message); return true; };
    const listeners: Array<(message: unknown) => unknown> = [];
    const on = vi.spyOn(process, 'on').mockImplementation(((name: string, fn: (message: unknown) => unknown) => {
      if (name === 'message') listeners.push(fn);
      return process;
    }) as any);
    setupIPCNotificationHandler();
    on.mockRestore();
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    const restore = () => {
      if (hadSend) (process as any).send = oldSend;
      else delete (process as any).send;
    };
    return { replies, listeners, notify, restore };
  }

  it('hands a valid holder of either kind to the notifier and answers with its outcome', async () => {
    const h = await handler();
    try {
      expect(h.listeners).toHaveLength(1);
      await h.listeners[0]({ type: 'notification:dispatch', requestId: 'r1', data: { holder: serverHolder, kind: 'manual.grant.added', payload: { tierName: 'Gold' } } });
      await h.listeners[0]({ type: 'notification:dispatch', requestId: 'r2', data: { holder: userHolder, kind: 'paid.sub.started' } });
    } finally {
      h.restore();
    }

    expect(h.notify.mock.calls).toEqual([
      [serverHolder, 'manual.grant.added', { tierName: 'Gold' }],
      [userHolder, 'paid.sub.started', {}],
    ]);
    expect(h.replies).toStrictEqual([
      { requestId: 'r1', data: { success: true, outcome: { delivered: true, via: 'dm' } } },
      { requestId: 'r2', data: { success: true, outcome: { delivered: true, via: 'dm' } } },
    ]);
  });

  it('refuses a message without a valid holder and sends no notice', async () => {
    const h = await handler();
    const data = [
      { kind: 'manual.grant.added', payload: {} },
      { guildId: SERVER, kind: 'manual.grant.added', payload: {} },
      { holder: SERVER, kind: 'manual.grant.added', payload: {} },
      { holder: 'guild:g1', kind: 'manual.grant.added', payload: {} },
      { holder: 5, kind: 'manual.grant.added', payload: {} },
      { holder: serverHolder, payload: {} },
    ];
    try {
      expect(h.listeners).toHaveLength(1);
      for (let i = 0; i < data.length; i++) await h.listeners[0]({ type: 'notification:dispatch', requestId: `r${i}`, data: data[i] });
    } finally {
      h.restore();
    }

    expect(h.notify.mock.calls).toEqual([]);
    expect(h.replies).toStrictEqual([
      { requestId: 'r0', data: { success: false, error: 'holder and kind are required' } },
      { requestId: 'r1', data: { success: false, error: 'holder and kind are required' } },
      { requestId: 'r2', data: { success: false, error: `'${SERVER}' is not a holder: expected guild:<id> or user:<id> with a Discord id.` } },
      { requestId: 'r3', data: { success: false, error: "'guild:g1' is not a holder: expected guild:<id> or user:<id> with a Discord id." } },
      { requestId: 'r4', data: { success: false, error: "'5' is not a holder: expected guild:<id> or user:<id> with a Discord id." } },
      { requestId: 'r5', data: { success: false, error: 'holder and kind are required' } },
    ]);
  });
}));

describe("P2 claim 12: the notice of a purchase", () => eachSeller(['p1seller', 'dummy'], make => {
  useWorld(make());
  it('premium names the server as the holder of its purchase notice', async () => {
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    const reply = await w.purchase(SERVER, 'low');

    expect(reply.ok).toBe(true);
    expect(notify.mock.calls.map(c => [c[0], c[1]])).toEqual([[serverHolder, 'paid.sub.started']]);
  });

  it("premium names the user as the holder of the notice of a user's purchase", async () => {
    await w.addSoldUserTiers();
    const notify = vi.spyOn(getSubscriptionNotifier(), 'notify').mockResolvedValue({ delivered: true, via: 'dm' });
    const reply = await w.purchase(userHolder, 'vlow');

    expect(reply.ok).toBe(true);
    expect(notify.mock.calls.map(c => [c[0], c[1]])).toEqual([[userHolder, 'paid.sub.started']]);
  });

  it("the notice of a user's purchase reaches Discord as one direct message to that user, and no server is fetched", async () => {
    await w.addSoldUserTiers();
    const d = discord();
    getSubscriptionNotifier().setClient(d.client as any);
    try {
      const reply = await w.purchase(userHolder, 'vlow');
      expect(reply.ok).toBe(true);
      await vi.waitFor(() => expect(d.calls).toHaveLength(1));
      await w.settle();
    } finally {
      getSubscriptionNotifier().setClient(null as any);
    }

    expect(d.calls).toEqual([`users.send ${USER}`]);
    expect(d.sent.map(s => s.to)).toEqual([`user ${USER}`]);
  });
}));
