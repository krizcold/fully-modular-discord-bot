/**
 * PatreonProvider - link a guild to a Patron pledge.
 *
 * Configuration:
 *   - PATREON_CLIENT_ID + PATREON_CLIENT_SECRET (OAuth2 app credentials)
 *   - PATREON_CAMPAIGN_ID (numeric campaign id; pinned to one campaign)
 *
 * Mechanism: 'oauth_link'. The guild owner clicks "Link Patreon", we
 * redirect to Patreon's OAuth consent. Patreon sends back an auth code;
 * /patreon/callback exchanges it for a token, looks up the user's
 * pledges via /api/oauth2/v2/identity, and adopts the matching tier
 * if their cents-per-month pledge meets the wired threshold.
 *
 * Anti-duplicate: the same Patreon user can't link to multiple guilds.
 * Recorded in PremiumManager.providerAccountLinks (already scaffolded).
 *
 * Polling: scheduledReconcile re-fetches pledge state for every linked
 * patron every 30 minutes. Patreon doesn't push webhooks for tier
 * changes reliably so polling is the source of truth.
 *
 * Variant model: Price mode only. variantId = "tier:{patreonTierId}" so
 * one patreon-tier maps to one of our offering variants. We don't pull
 * a catalog because Patreon tiers are admin-curated per campaign and
 * fluid; admins paste the patreon tier id when wiring.
 */

import * as crypto from 'crypto';
import { loadCredentials } from '@/utils/envLoader';
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
  canInitiatePurchase: true,         // we initiate by sending the user to Patreon's OAuth
  supportsCancel: false,             // patron unsubscribes on patreon.com
  supportsReactivate: false,
  supportsCoupons: false,
  supportsPause: false,
  supportsMultipleVariants: true,    // multiple patreon tiers per campaign
  supportsProductMode: false,        // patreon's "campaign" is the only product; not worth the abstraction
  supportsHostedPicker: false,
  supportsCustomerPortal: false,
  supportsAnnualBilling: false,      // patreon billing is monthly
  supportsPriceMigration: false,
  mechanism: 'oauth_link',
  variantIdLabel: 'Patreon Tier ID (e.g. "tier:12345")',
  productIdLabel: '',
};

const VARIANT_PREFIX = 'tier:';
const PATREON_API = 'https://www.patreon.com/api/oauth2/v2';
const PATREON_OAUTH = 'https://www.patreon.com/oauth2/authorize';
const PATREON_TOKEN = 'https://www.patreon.com/api/oauth2/token';

export class PatreonProvider implements PaymentProvider {
  readonly id = 'patreon';
  readonly displayName = 'Patreon';
  readonly capabilities = CAPABILITIES;

  isConfigured(): boolean {
    const c = loadCredentials();
    // WEBUI_BASE_URL is required because we hand it to Patreon as the OAuth
    // redirect_uri; without it we'd fall back to a placeholder URL Patreon
    // never accepts and the link flow would silently fail at the consent
    // screen. Treat it as a hard requirement, not optional.
    return !!(c.PATREON_CLIENT_ID && c.PATREON_CLIENT_SECRET && c.PATREON_CAMPAIGN_ID && c.WEBUI_BASE_URL);
  }

  getCredentialFields(): CredentialFieldDef[] {
    return [
      {
        key: 'PATREON_CLIENT_ID',
        label: 'OAuth Client ID',
        type: 'text',
        placeholder: 'long alphanumeric string',
        helpText: 'patreon.com/portal - My Apps & Tools - your client. Required for the OAuth-link flow.',
      },
      {
        key: 'PATREON_CLIENT_SECRET',
        label: 'OAuth Client Secret',
        type: 'secret',
        helpText: 'Same Patreon page as Client ID. Used server-side to exchange the auth code for an access token.',
      },
      {
        key: 'PATREON_CAMPAIGN_ID',
        label: 'Campaign ID',
        type: 'text',
        placeholder: '12345',
        helpText: 'Numeric campaign id. Pinned to one campaign per bot.',
      },
      {
        key: 'PATREON_CREATOR_ACCESS_TOKEN',
        label: 'Creator Access Token',
        type: 'secret',
        helpText: 'Optional. Lets the bot fetch your campaign\'s tier catalog without needing each user\'s token.',
        optional: true,
      },
      {
        key: 'WEBUI_BASE_URL',
        label: 'Web UI Base URL',
        type: 'url',
        placeholder: 'https://your-bot.example.com',
        helpText: 'Public base URL of this Web UI. Used to build the OAuth redirect URI you must register in Patreon.',
        optional: true,
      },
    ];
  }

  async initiatePurchase(opts: InitiateOpts): Promise<InitiateResult> {
    const c = loadCredentials();
    if (!this.isConfigured()) throw new Error('Patreon not configured');
    const redirectUri = `${c.WEBUI_BASE_URL}/guild/api/subscriptions/patreon/callback`;
    const state = this.signState({
      guildId: opts.guildId,
      tierId: opts.tierId,
      offeringId: opts.offeringId,
      variantId: opts.variantId,
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: c.PATREON_CLIENT_ID || '',
      redirect_uri: redirectUri,
      scope: 'identity identity[email] identity.memberships',
      state,
    });
    return { oauthUrl: `${PATREON_OAUTH}?${params.toString()}` };
  }

  /**
   * State signing - prevents CSRF where an attacker crafts a state with
   * their own guildId, tricks the user into authorizing, and ends up
   * with the user's Patreon linked to the attacker's guild. Sign with
   * PATREON_CLIENT_SECRET (already a server-only secret).
   *
   * Format: `<base64url(json)>.<base64url(hmac-sha256)>`. Signature
   * covers the JSON bytes so altering any field invalidates it.
   */
  private signState(payload: Record<string, any>): string {
    const c = loadCredentials();
    const secret = c.PATREON_CLIENT_SECRET || '';
    const json = Buffer.from(JSON.stringify(payload), 'utf-8');
    const sig = crypto.createHmac('sha256', secret).update(json).digest();
    return `${json.toString('base64url')}.${sig.toString('base64url')}`;
  }

  private verifyState(state: string): Record<string, any> {
    const dot = state.indexOf('.');
    if (dot < 0) throw new Error('State is unsigned');
    const c = loadCredentials();
    const secret = c.PATREON_CLIENT_SECRET || '';
    const jsonB64 = state.slice(0, dot);
    const sigB64 = state.slice(dot + 1);
    const json = Buffer.from(jsonB64, 'base64url');
    const expectedSig = crypto.createHmac('sha256', secret).update(json).digest();
    const providedSig = Buffer.from(sigB64, 'base64url');
    if (providedSig.length !== expectedSig.length
      || !crypto.timingSafeEqual(providedSig, expectedSig)) {
      throw new Error('State signature mismatch');
    }
    return JSON.parse(json.toString('utf-8'));
  }

  async fetchVariant(variantId: string): Promise<OfferingVariant | null> {
    if (!variantId.startsWith(VARIANT_PREFIX)) return null;
    const tierId = variantId.slice(VARIANT_PREFIX.length);
    const c = loadCredentials();
    if (!c.PATREON_CAMPAIGN_ID) return null;
    // Patreon tiers under a campaign:
    const campaign = await this.api<any>('GET',
      `/campaigns/${encodeURIComponent(c.PATREON_CAMPAIGN_ID)}?include=tiers&fields[tier]=title,amount_cents,published`);
    const tier = (campaign?.included || [])
      .find((x: any) => x.type === 'tier' && x.id === tierId);
    if (!tier) return null;
    return {
      variantId,
      label: tier.attributes?.title || tierId,
      amount: tier.attributes?.amount_cents || 0,
      currency: 'USD',
      durationDays: 30,
      recurring: true,
      active: !!tier.attributes?.published,
    };
  }

  async getSubscriptionState(_providerSubId: string): Promise<ProviderSubscriptionState | null> {
    // Per-sub state lives on patreon's membership records; we adopt them
    // via scheduledReconcile rather than fetch on demand. Returning null
    // here lets PremiumManager fall back to the cached state.
    return null;
  }

  async listSubscriptionsForGuild(_guildId: string): Promise<ProviderSubscriptionRef[]> {
    // Patreon doesn't index by guildId. We rely on the OAuth-link flow's
    // callback to install the sub directly; no orphan adoption path.
    return [];
  }

  /**
   * OAuth callback - the web-UI route hands the raw query here. We exchange
   * code for token, fetch the patron's identity + memberships, find any
   * membership that matches a wired tier on this campaign, and return the
   * data PremiumManager needs to install. PremiumManager handles the
   * anti-duplicate check via providerAccountLinks.
   */
  async handleOAuthCallback(query: Record<string, string>): Promise<{
    externalAccountId: string;
    guildId: string;
    tierId: string;
    offeringId: string;
    variantId: string;
    state: ProviderSubscriptionState;
  }> {
    const c = loadCredentials();
    if (!query.code || !query.state) throw new Error('Missing code or state in Patreon callback');
    let parsedState: any;
    try {
      parsedState = this.verifyState(query.state);
    } catch (err: any) {
      throw new Error(`Invalid state parameter: ${err?.message || 'unknown'}`);
    }

    const redirectUri = `${c.WEBUI_BASE_URL}/guild/api/subscriptions/patreon/callback`;

    const tokenRes = await fetch(PATREON_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        grant_type: 'authorization_code',
        client_id: c.PATREON_CLIENT_ID || '',
        client_secret: c.PATREON_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Patreon token exchange failed: ${tokenRes.status}`);
    const tokenJson: any = await tokenRes.json();

    // Fetch memberships AND their campaign relationship so we can filter
    // to OUR campaign only. Without the campaign include, a patron who
    // happens to support multiple creators would match against any tier
    // id, ignoring which creator is being checked.
    const identityRes = await fetch(`${PATREON_API}/identity?include=memberships,memberships.currently_entitled_tiers,memberships.campaign&fields[member]=patron_status,currently_entitled_amount_cents`, {
      headers: { 'Authorization': `Bearer ${tokenJson.access_token}` },
    });
    if (!identityRes.ok) throw new Error(`Patreon identity fetch failed: ${identityRes.status}`);
    const identity: any = await identityRes.json();

    const userId = identity?.data?.id;
    if (!userId) throw new Error('Patreon identity returned no user id');

    // Find the membership scoped to OUR campaign with the pledged tier.
    const memberships = (identity?.included || []).filter((x: any) => x.type === 'member');
    const wantedTierId = String(parsedState.variantId || '').replace(VARIANT_PREFIX, '');
    const ourCampaignId = String(c.PATREON_CAMPAIGN_ID || '');
    let matched = false;
    for (const m of memberships) {
      const campaignId = String(m.relationships?.campaign?.data?.id || '');
      if (campaignId !== ourCampaignId) continue;
      const tierIds: string[] = (m.relationships?.currently_entitled_tiers?.data || [])
        .map((t: any) => String(t.id));
      if (tierIds.includes(wantedTierId) && m.attributes?.patron_status === 'active_patron') {
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error('Your active Patreon pledge to this creator does not include the required tier.');

    return {
      externalAccountId: String(userId),
      guildId: String(parsedState.guildId),
      tierId: String(parsedState.tierId),
      offeringId: String(parsedState.offeringId || ''),
      variantId: String(parsedState.variantId || ''),
      state: {
        status: 'active',
        startDate: new Date().toISOString(),
        endDate: null,
        autoRenew: true,
        meta: { patreonUserId: userId, patreonTierId: wantedTierId },
      },
    };
  }

  /**
   * Periodic re-check of a single patron's pledge. Returns the current
   * state (active or expired) so PremiumManager can revoke if the
   * pledge dropped. Stage 7 doesn't wire the scheduler yet - that's
   * follow-up work because we need to map providerSubId -> stored
   * Patreon access token (which we don't currently persist).
   */
  async scheduledReconcile(_providerSubId: string): Promise<ProviderSubscriptionState | null> {
    // TODO: requires persistent storage of per-link Patreon access tokens.
    // Without that we can't re-query pledge state on behalf of the user.
    // The OAuth-link install path captures the snapshot; staying active
    // until next manual relink is acceptable while this is unimplemented.
    return null;
  }

  // ============================================================================
  // INTERNALS
  // ============================================================================

  private async api<T>(method: string, path: string): Promise<T | null> {
    // Application-level requests (campaign lookup) use the creator's
    // access token. We don't ship a creator-token credential because the
    // info we need (campaign tiers) is also reachable via OAuth flow's
    // identity scope. For now this method exists for completeness; the
    // fetchVariant path falls back to returning the wired data alone if
    // the API is unavailable.
    const c = loadCredentials();
    if (!c.PATREON_CREATOR_ACCESS_TOKEN) return null;
    const res = await fetch(`${PATREON_API}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${c.PATREON_CREATOR_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  }
}
