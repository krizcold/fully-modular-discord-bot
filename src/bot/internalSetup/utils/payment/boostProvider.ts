/**
 * ServerBoostingProvider - "boost the host's target server, get the tier
 * on guilds you own".
 *
 * Mechanism: 'verify_only'. There's no money flow we own; the host
 * configures `BOOST_TARGET_GUILD_ID` (their support server), and the
 * provider polls that guild every 5 minutes for active boosters. For
 * each booster's user id, the provider walks `client.guilds.cache` and
 * grants the wired tier on every guild that user owns where the bot
 * is installed.
 *
 * Variant model: `boost` (or its alias `boosts:1`) is the only supported
 * variant. Discord does NOT expose per-user boost slot counts to bot
 * tokens (`/guilds/{id}/premium-subscriptions` is user-token-only;
 * github.com/discord/discord-api-docs/issues/1714 still open as of
 * 2026). All we can detect is "this user is currently boosting" via
 * `member.premiumSince` - one boost or many, it's binary from the bot's
 * vantage point. `boosts:2+` is rejected at parse time so admins don't
 * silently configure a tier that can never be granted.
 *
 * Lifecycle:
 *   - Bot process polls the target guild's members every 5 minutes.
 *   - For each booster's owned guilds: emit subscription.created.
 *   - When a user un-boosts: emit subscription.expired on next tick.
 *   - Internal map `installed[guildId] = providerSubId` deduplicates.
 *
 * Capabilities are deliberately minimal: no cancel, no pause, no
 * coupons, no migration, no portal. The "purchase" is the user's
 * existing Discord boost; we just verify it.
 *
 * Required intents / permissions:
 *   - GuildMembers privileged intent on the bot.
 *   - Bot must be a member of the target guild.
 *
 * Scaling limits:
 *   - members.fetch() pulls every member of the target guild on each
 *     tick. For target guilds with >10k members this is expensive;
 *     consider switching to incremental tracking via guildMemberUpdate
 *     events if the cost matters.
 */

import type { Client } from 'discord.js';
import { loadCredentials } from '@/utils/envLoader';
import { getPaymentRegistry } from './paymentRegistry';
import type {
  PaymentProvider,
  ProviderCapabilities,
  ProviderSubscriptionState,
  InitiateOpts,
  InitiateResult,
  OfferingVariant,
  ProviderSubscriptionRef,
  CredentialFieldDef,
} from './paymentTypes';

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: false,
  supportsCancel: false,
  supportsReactivate: false,
  supportsCoupons: false,
  supportsPause: false,
  supportsMultipleVariants: true,
  supportsProductMode: false,
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: false,
  supportsPriceMigration: false,
  mechanism: 'verify_only',
  variantIdLabel: 'Variant id - use "boost"',
  productIdLabel: '',
};

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const VARIANT_PREFIX = 'boosts:';
const VARIANT_SHORTHAND = 'boost';

export class ServerBoostingProvider implements PaymentProvider {
  readonly id = 'boost';
  readonly displayName = 'Server Boosting';
  readonly capabilities = CAPABILITIES;

  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** guildId -> providerSubId for installed boost-backed entitlements,
   * so the next tick can revoke when the user stops boosting. */
  private installed: Map<string, string> = new Map();

  setClient(client: Client): void {
    this.client = client;
    // The registry registers all providers BEFORE the client logs in,
    // so the first start() runs without a client and its immediate tick
    // bails out. Once the client arrives, fire one tick right away so an
    // admin who just configured the target guild gets a signal in seconds
    // instead of waiting for the next 5-minute interval.
    if (this.timer) {
      void this.tick().catch(err => {
        console.warn('[ServerBoostingProvider] post-setClient tick failed:', err?.message || err);
      });
    }
  }

  isConfigured(): boolean {
    if (!this.client) return false;
    const c = loadCredentials();
    return !!(c.BOOST_TARGET_GUILD_ID && /^[0-9]{17,20}$/.test(c.BOOST_TARGET_GUILD_ID));
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'BOOST_TARGET_GUILD_ID',
        label: 'Target Guild ID',
        type: 'text',
        placeholder: '1234567890123456789',
        helpText: 'The Discord server users must boost to qualify (typically your support / community server). The bot must be a member with the GuildMembers privileged intent enabled. Per-user slot counts are not exposed to bot tokens by Discord, so any active boost qualifies (multi-slot thresholds are not supported).',
      },
    ];
  }

  /**
   * GuildMembers is needed for the slot-count fallback path
   * (members.fetch + premiumSince) and for guild.ownerId resolution.
   * Without it the tick would log a warning every 5 minutes and grant
   * nothing.
   */
  getRequiredIntents(): string[] {
    return ['GuildMembers'];
  }

  async initiatePurchase(_opts: InitiateOpts): Promise<InitiateResult> {
    const c = loadCredentials();
    const targetMention = c.BOOST_TARGET_GUILD_ID ? ` (server id: ${c.BOOST_TARGET_GUILD_ID})` : '';
    return {
      clientHandoff: {
        type: 'discord-boost',
        instruction: `Boost the host's target Discord server${targetMention} from your account. Once your boost is active, the bot grants this tier on every server you own (within ~5 minutes).`,
      },
    };
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    if (!this.isValidVariant(variantId)) return null;
    return {
      variantId,
      label: 'Server Booster (target guild)',
      amount: 0,
      currency: '',
      durationDays: null,
      recurring: true,
      active: true,
    };
  }

  async getSubscriptionState(_providerSubId: string): Promise<ProviderSubscriptionState | null> {
    return null;
  }

  async listSubscriptionsForGuild(_guildId: string): Promise<ProviderSubscriptionRef[]> {
    return [];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(err => {
        console.warn('[ServerBoostingProvider] tick failed:', err?.message || err);
      });
    }, POLL_INTERVAL_MS);
    // First tick fires immediately so an admin who just configured the
    // target doesn't have to wait 5 minutes for any signal.
    void this.tick().catch(err => {
      console.warn('[ServerBoostingProvider] initial tick failed:', err?.message || err);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Walk the configured target guild's boosters and grant the wired
   * boost variant on each guild those boosters own.
   */
  private async tick(): Promise<void> {
    if (!this.client) return;
    const c = loadCredentials();
    const targetId = c.BOOST_TARGET_GUILD_ID;
    if (!targetId) return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getPremiumManager } = require('../premiumManager');
    const mgr = getPremiumManager();
    const tiers = mgr.getAllTiers();

    interface WiredVariant { variantId: string; tierId: string; offeringId: string; }
    const wired: WiredVariant[] = [];
    for (const [tierId, tier] of Object.entries<any>(tiers)) {
      for (const offering of (tier.offerings || [])) {
        for (const link of (offering.providerLinks || [])) {
          if (link.providerId !== this.id || !link.enabled) continue;
          const entries = link.priceConfig?.entries || [];
          for (const entry of entries) {
            if (!this.isValidVariant(entry.variantId)) continue;
            wired.push({ variantId: entry.variantId, tierId, offeringId: offering.id });
          }
        }
      }
    }
    if (wired.length === 0) {
      this.revokeAll('no boost variant wired');
      return;
    }
    // First wired variant wins. Multiple wired variants on different
    // offerings is unusual and we'd flap between them otherwise.
    const variantToGrant = wired[0];

    const targetGuild = await this.client.guilds.fetch(targetId).catch(() => null);
    if (!targetGuild) {
      console.warn(`[ServerBoostingProvider] target guild ${targetId} unreachable - bot is not a member?`);
      return;
    }

    const boosters = await this.fetchBoosters(targetGuild as any, targetId);
    if (boosters === null) return; // hard failure already logged

    const registry = getPaymentRegistry();
    const guilds = this.client.guilds.cache;
    for (const [ownedGuildId, ownedGuild] of guilds) {
      const ownerId = (ownedGuild as any).ownerId;
      const eligible = !!ownerId && boosters.has(ownerId);
      const qualifying = eligible ? variantToGrant : undefined;
      const previousSubId = this.installed.get(ownedGuildId);

      if (qualifying) {
        const subId = `boost:${ownedGuildId}:${ownerId}:${qualifying.variantId}`;
        if (previousSubId !== subId) {
          if (previousSubId) {
            registry.emitEvent({
              type: 'subscription.expired',
              providerId: this.id,
              providerSubId: previousSubId,
              guildId: ownedGuildId,
              state: this.expiredState(),
            });
          }
          registry.emitEvent({
            type: 'subscription.created',
            providerId: this.id,
            providerSubId: subId,
            guildId: ownedGuildId,
            tierId: qualifying.tierId,
            offeringId: qualifying.offeringId,
            variantId: qualifying.variantId,
            state: this.activeState(),
          });
          this.installed.set(ownedGuildId, subId);
        }
      } else if (previousSubId) {
        registry.emitEvent({
          type: 'subscription.expired',
          providerId: this.id,
          providerSubId: previousSubId,
          guildId: ownedGuildId,
          state: this.expiredState(),
        });
        this.installed.delete(ownedGuildId);
      }
    }
  }

  /**
   * Returns the set of user ids currently boosting the target guild.
   * Discord doesn't expose per-user slot counts to bot tokens, so this
   * is a flat set: a user is a booster (`premiumSince` is set) or not.
   *
   * Returns null on hard failure (missing intent / unreachable guild)
   * so the caller can bail and try again next tick.
   */
  private async fetchBoosters(targetGuild: any, targetId: string): Promise<Set<string> | null> {
    try { await targetGuild.members.fetch(); }
    catch (err: any) {
      console.warn(`[ServerBoostingProvider] members.fetch failed on target guild ${targetId} (need GuildMembers intent):`, err?.message || err);
      return null;
    }
    const memberCount = targetGuild.members.cache.size;
    if (memberCount > 10000) {
      console.warn(`[ServerBoostingProvider] target guild has ${memberCount} members; full member fetch every 5 minutes is expensive. Consider migrating to incremental guildMemberUpdate tracking.`);
    }
    const boosters = new Set<string>();
    for (const [memberId, member] of targetGuild.members.cache) {
      if ((member as any).premiumSince) boosters.add(memberId);
    }
    return boosters;
  }

  /** Revoke every install we're tracking. Used when the wiring goes away. */
  private revokeAll(reason: string): void {
    if (this.installed.size === 0) return;
    const registry = getPaymentRegistry();
    for (const [guildId, subId] of this.installed) {
      registry.emitEvent({
        type: 'subscription.expired',
        providerId: this.id,
        providerSubId: subId,
        guildId,
        state: this.expiredState(),
      });
    }
    this.installed.clear();
    console.log(`[ServerBoostingProvider] revoked all boost installs (${reason})`);
  }

  /**
   * Accepts only `boost` and `boosts:1` - the two ways to spell "user is
   * a booster". Higher thresholds (`boosts:2+`) are rejected because
   * Discord doesn't expose per-user slot counts to bot tokens; silently
   * accepting them would create tiers that can never be granted.
   */
  private isValidVariant(variantId: string): boolean {
    if (variantId === VARIANT_SHORTHAND) return true;
    if (!variantId.startsWith(VARIANT_PREFIX)) return false;
    const n = parseInt(variantId.slice(VARIANT_PREFIX.length), 10);
    return n === 1;
  }

  private activeState(): ProviderSubscriptionState {
    return {
      status: 'active',
      startDate: new Date().toISOString(),
      endDate: null,
      autoRenew: true,
    };
  }

  private expiredState(): ProviderSubscriptionState {
    return {
      status: 'expired',
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
      autoRenew: false,
    };
  }
}
