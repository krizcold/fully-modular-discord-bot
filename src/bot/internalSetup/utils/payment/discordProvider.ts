/**
 * DiscordProvider - Discord App Monetization (Premium Apps).
 *
 * Mechanism: 'client_handoff'. Discord owns the entire purchase flow
 * (user clicks the bot's profile -> Premium -> Subscribe). We never
 * initiate the purchase; we listen for ENTITLEMENT_CREATE / _UPDATE /
 * _DELETE on the gateway and translate them into our standard
 * subscription lifecycle events.
 *
 * Configuration: DISCORD_APPLICATION_ID + DISCORD_TOKEN are required
 * (token is the bot's existing one - no extra credential). Optional
 * webhook secret is N/A here because Discord doesn't use HTTP webhooks
 * for entitlements; everything flows over the gateway.
 *
 * Capabilities are deliberately conservative per the spec:
 *   - flat SKU model (one variant per offering, Price mode only)
 *   - no coupons, no pause, no price migration, no annual billing,
 *     no hosted picker, no customer portal
 *   - admin UI must restrict variant duration to monthly (host-side concern)
 *
 * Source of truth: Discord. We never write entitlements via REST in
 * production; the dev-only POST /entitlements endpoint exists for testing
 * and is not exposed.
 */

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

const DISCORD_API_BASE = 'https://discord.com/api/v10';

const CAPABILITIES: ProviderCapabilities = {
  canInitiatePurchase: false,
  supportsCancel: true,           // we can DELETE an entitlement
  supportsReactivate: false,
  supportsCoupons: false,
  supportsPause: false,
  supportsMultipleVariants: false,
  supportsProductMode: false,
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: false,   // monthly-only at present
  supportsPriceMigration: false,
  mechanism: 'client_handoff',
  variantIdLabel: 'Discord SKU ID',
  productIdLabel: '',             // no product concept
};

interface DiscordEntitlement {
  id: string;
  sku_id: string;
  application_id: string;
  user_id?: string | null;
  guild_id?: string | null;
  type: number; // 8 = APPLICATION_SUBSCRIPTION
  deleted?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  consumed?: boolean;
}

interface DiscordSku {
  id: string;
  type: number;     // 5 = SUBSCRIPTION, 6 = SUBSCRIPTION_GROUP
  application_id: string;
  name: string;
  slug: string;
  flags: number;
}

export class DiscordProvider implements PaymentProvider {
  readonly id = 'discord';
  readonly displayName = 'Discord App Monetization';
  readonly capabilities = CAPABILITIES;

  private gatewayHandler: ((payload: any) => void) | null = null;

  isConfigured(): boolean {
    const creds = loadCredentials();
    return !!(creds.DISCORD_APPLICATION_ID && creds.DISCORD_TOKEN);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'DISCORD_APPLICATION_ID',
        label: 'Application ID',
        type: 'text',
        placeholder: '1234567890123456789',
        helpText: 'Discord Developer Portal - General Information - Application ID. Same value as your bot Client ID.',
      },
      {
        key: 'DISCORD_TOKEN',
        label: 'Bot Token (read-only)',
        type: 'secret',
        helpText: 'Reuses the bot\'s existing token; managed by your hosting setup, not editable here.',
        optional: true,
      },
    ];
  }

  /**
   * Per spec, Discord's purchase always goes through Discord's UI; the bot
   * cannot initiate. The SubscribeModal special-cases client_handoff
   * mechanism and surfaces an instruction instead of a button.
   */
  async initiatePurchase(_opts: InitiateOpts): Promise<InitiateResult> {
    return {
      clientHandoff: {
        type: 'discord-premium-menu',
        instruction: 'Open Discord, click this bot\'s profile, then "Premium" / "Subscribe" to start.',
      },
    };
  }

  /**
   * Resolve a single SKU to a normalized OfferingVariant. Discord's SKU
   * API returns name + flags but no price (Discord owns pricing in their
   * portal). We surface label only; amount/currency/duration are unknown
   * to us and shown as "Discord-managed price · monthly" in the UI.
   */
  async fetchVariant(skuId: string): Promise<OfferingVariant | null> {
    const skus = await this.listSkus();
    if (!skus) return null;
    const match = skus.find(s => s.id === skuId);
    if (!match) return null;
    return this.normalizeSku(match);
  }

  /**
   * List all SKUs on the application. Used for orphan-adoption metadata
   * and for the admin lookup via fetchVariant. We don't expose this as
   * Product-mode listVariants because Discord SKUs are flat (one SKU =
   * one variant from our POV).
   */
  private async listSkus(): Promise<DiscordSku[] | null> {
    const creds = loadCredentials();
    if (!creds.DISCORD_APPLICATION_ID) return null;
    const data = await this.api<DiscordSku[]>('GET', `/applications/${creds.DISCORD_APPLICATION_ID}/skus`);
    return Array.isArray(data) ? data : null;
  }

  private normalizeSku(sku: DiscordSku): OfferingVariant {
    return {
      variantId: sku.id,
      label: sku.name,
      amount: 0,
      currency: '',
      durationDays: 30,    // Discord App Monetization is monthly
      recurring: true,
      active: true,
    };
  }

  /**
   * Cancel an entitlement. Discord's REST DELETE /entitlements stops the
   * recurring billing at the next renewal (it does NOT immediately revoke
   * access); the user retains the entitlement until ends_at. ENTITLEMENT_UPDATE
   * fires on the gateway when this completes.
   */
  async cancelSubscription(providerSubId: string, _immediately?: boolean): Promise<void> {
    const creds = loadCredentials();
    if (!creds.DISCORD_APPLICATION_ID) {
      throw new Error('DISCORD_APPLICATION_ID not configured');
    }
    await this.api<unknown>(
      'DELETE',
      `/applications/${creds.DISCORD_APPLICATION_ID}/entitlements/${encodeURIComponent(providerSubId)}`,
    );
  }

  async getSubscriptionState(providerSubId: string): Promise<ProviderSubscriptionState | null> {
    const creds = loadCredentials();
    if (!creds.DISCORD_APPLICATION_ID) return null;
    const all = await this.api<DiscordEntitlement[]>(
      'GET',
      `/applications/${creds.DISCORD_APPLICATION_ID}/entitlements`,
    );
    if (!Array.isArray(all)) return null;
    const ent = all.find(e => e.id === providerSubId);
    if (!ent) return null;
    return this.stateFromEntitlement(ent);
  }

  /**
   * Orphan detection: list all entitlements the bot's application has
   * for this guild that aren't in our local cache. PremiumManager
   * compares this against its records.
   */
  async listSubscriptionsForGuild(guildId: string): Promise<ProviderSubscriptionRef[]> {
    const creds = loadCredentials();
    if (!creds.DISCORD_APPLICATION_ID) return [];
    const all = await this.api<DiscordEntitlement[]>(
      'GET',
      `/applications/${creds.DISCORD_APPLICATION_ID}/entitlements?guild_id=${encodeURIComponent(guildId)}`,
    );
    if (!Array.isArray(all)) return [];
    const skus = await this.listSkus();
    const out: ProviderSubscriptionRef[] = [];
    for (const ent of all) {
      if (ent.deleted) continue;
      if (!ent.id) continue;
      const sku = skus?.find(s => s.id === ent.sku_id);
      const state = this.stateFromEntitlement(ent);
      out.push({
        providerSubId: ent.id,
        state,
        metadata: {
          guildId,
          variantId: ent.sku_id,
          // Discord doesn't carry tierId/offeringId metadata - those would
          // need to be derived by matching SKU id against our wired
          // offerings. PremiumManager.adoptOrphan handles that mapping.
        },
        display: {
          amountLabel: 'Discord-managed price',
          periodLabel: 'monthly',
          statusLabel: state.status,
        },
      });
      void sku;
    }
    return out;
  }

  /**
   * Gateway event listener. Bot process only - the web-UI fork has no
   * Discord client. We attach to the bot's existing client (set by
   * `setGatewayClient`) and bridge ENTITLEMENT_* into our standard
   * subscription.created / .updated / .expired events on the registry.
   */
  start(): void {
    // Listener is wired externally via setGatewayClient(client) so we don't
    // need to import discord.js here. Nothing else to start.
  }

  stop(): void {
    if (this.gatewayHandler) {
      // Detach via the same hook; setGatewayClient stores the cleanup fn.
      // The cleanup is owned by the wiring code in clientInitializer.
      this.gatewayHandler = null;
    }
  }

  /**
   * Called from clientInitializer.ts in the bot process to wire the
   * gateway event bridge. We accept an `attach(eventName, handler)`
   * function so we don't have to import discord.js here (keeps the
   * file usable from the web-UI process for everything else).
   */
  attachGatewayBridge(attach: (eventName: string, handler: (payload: any) => void) => void): void {
    const handle = (kind: 'created' | 'updated' | 'expired') => (raw: any) => {
      try {
        const ent = this.normalizeRawEntitlement(raw);
        if (!ent) return;
        if (!ent.guild_id) return; // user-scoped entitlements - we only handle guild subs
        const state = this.stateFromEntitlement(ent);
        const registry = getPaymentRegistry();
        if (kind === 'created') {
          // Discord doesn't carry tier/offering metadata - emit as orphan-adopt
          // candidate by populating tierId/offeringId as empty. PremiumManager
          // will fall back to listSubscriptionsForGuild on next orphan scan.
          // We still emit so the audit log records the event.
          registry.emitEvent({
            type: 'subscription.created',
            providerId: this.id,
            providerSubId: ent.id,
            guildId: ent.guild_id,
            tierId: '',
            offeringId: '',
            variantId: ent.sku_id,
            state,
          });
        } else if (kind === 'updated') {
          registry.emitEvent({
            type: 'subscription.updated',
            providerId: this.id,
            providerSubId: ent.id,
            guildId: ent.guild_id,
            state,
          });
        } else {
          registry.emitEvent({
            type: 'subscription.expired',
            providerId: this.id,
            providerSubId: ent.id,
            guildId: ent.guild_id,
            state: { ...state, status: 'expired' },
          });
        }
      } catch (err: any) {
        console.warn(`[DiscordProvider] gateway ${kind} handler failed:`, err?.message || err);
      }
    };
    attach('entitlementCreate', handle('created'));
    attach('entitlementUpdate', handle('updated'));
    attach('entitlementDelete', handle('expired'));
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  private normalizeRawEntitlement(raw: any): DiscordEntitlement | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id || raw.entitlementId;
    const sku_id = raw.skuId || raw.sku_id;
    if (!id || !sku_id) return null;
    return {
      id: String(id),
      sku_id: String(sku_id),
      application_id: String(raw.applicationId || raw.application_id || ''),
      user_id: raw.userId || raw.user_id || null,
      guild_id: raw.guildId || raw.guild_id || null,
      type: Number(raw.type ?? 8),
      deleted: !!raw.deleted,
      starts_at: raw.startsAt || raw.starts_at || null,
      ends_at: raw.endsAt || raw.ends_at || null,
      consumed: !!raw.consumed,
    };
  }

  private stateFromEntitlement(ent: DiscordEntitlement): ProviderSubscriptionState {
    const now = Date.now();
    const endsMs = ent.ends_at ? Date.parse(ent.ends_at) : null;
    const expired = ent.deleted || (endsMs !== null && endsMs <= now);
    return {
      status: expired ? 'expired' : 'active',
      startDate: ent.starts_at || new Date().toISOString(),
      endDate: ent.ends_at || null,
      autoRenew: !ent.deleted,
      meta: { skuId: ent.sku_id, type: ent.type },
    };
  }

  private async api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, any>): Promise<T | null> {
    const creds = loadCredentials();
    const token = creds.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not configured');

    const url = `${DISCORD_API_BASE}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'fully-modular-discord-bot (premium, 1.0)',
      },
    };
    if (body) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    if (res.status === 204) return null;
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* leave null */ }
    }
    if (!res.ok) {
      const msg = parsed?.message || `Discord API ${method} ${path} -> ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }
}
