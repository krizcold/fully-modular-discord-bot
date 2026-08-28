// Discord witness (PLAN_REPLICATION 20.6): the third evidence channel for
// leader election. Each election participant (master + designated backups)
// maintains exactly ONE self-describing beacon message and edits it in place;
// freshness is judged by Discord's edited_timestamp so local clocks never
// enter the verdict. REST only - the witness must never identify, so it works
// on nodes holding no lease. Every failure mode reads as "witness dark"
// (null / false), never as a crash: darkness means hold steady.

import * as https from 'https';
import { WITNESS_RENEW_MS, WITNESS_REST_TIMEOUT_MS } from './constants';

export type WitnessRole = 'master' | 'backup';

export interface WitnessClaim {
  nodeId: string;
  nodeName: string;
  term: number;
  role: WitnessRole;
  /** Discord's edited_timestamp (falls back to the post timestamp), ms epoch. */
  observedAt: number;
}

export interface WitnessStatus {
  home: 'dm' | 'channel' | null;
  channelId: string | null;
  beaconMessageId: string | null;
  lastRenewAt: number | null;
  lastRenewOk: boolean;
  lastError: string | null;
  lastReadAt: number | null;
  claims: WitnessClaim[];
}

export interface FleetWitness {
  /** Create-or-edit this node's beacon with the given claim. False = witness dark. */
  renewClaim(term: number, role: WitnessRole): Promise<boolean>;
  /** Latest claim per node from the beacon home. Null = witness dark. */
  readClaims(): Promise<WitnessClaim[] | null>;
  getStatus(): WitnessStatus;
}

const BEACON_MARKER = 'FLEET BEACON v1';

// Beacons are edited in place and never move up in channel history, so scans
// paginate this far before concluding a beacon is absent. Beyond it, the
// re-anchor path (repostBeacon) brings a buried beacon back to the top.
const SCAN_PAGE_SIZE = 100;
const SCAN_PAGE_CAP = 4;

interface RestResult {
  status: number;
  json: any;
}

function rest(method: string, path: string, token: string, body?: unknown): Promise<RestResult | null> {
  return new Promise(resolve => {
    let deadline: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (value: RestResult | null, destroy?: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (destroy) destroy();
      resolve(value);
    };
    // https.request throws SYNCHRONOUSLY on malformed input (e.g. an invalid
    // header character in the token); that must read as dark, not reject.
    try {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(
      `https://discord.com/api/v10${path}`,
      {
        method,
        headers: {
          authorization: `Bot ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
        timeout: WITNESS_REST_TIMEOUT_MS,
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let json: any = null;
          try { json = raw === '' ? null : JSON.parse(raw); } catch { /* non-JSON body reads as null */ }
          finish({ status: res.statusCode ?? 0, json });
        });
        // A connection killed after headers but before the body completes fires
        // neither 'end' nor a request 'error'; without this the promise hangs.
        res.on('close', () => { if (!res.complete) finish(null, () => req.destroy()); });
      },
    );
    // The 'timeout' option is inactivity-based; a slow-trickle response would
    // otherwise run unbounded. This is the overall per-request deadline.
    deadline = setTimeout(() => finish(null, () => req.destroy()), WITNESS_REST_TIMEOUT_MS);
    deadline.unref();
    req.on('timeout', () => finish(null, () => req.destroy()));
    req.on('error', () => finish(null));
    if (payload) req.write(payload);
    req.end();
    } catch {
      finish(null);
    }
  });
}

function parseBeacon(content: unknown): { nodeId: string; nodeName: string; term: number; role: WitnessRole } | null {
  if (typeof content !== 'string') return null;
  const lines = content.split('\n');
  if (lines[0] !== BEACON_MARKER) return null;
  try {
    const parsed = JSON.parse(lines.slice(1).join('\n'));
    if (typeof parsed?.nodeId !== 'string' || parsed.nodeId === '' || !Number.isFinite(parsed?.term)) return null;
    return {
      nodeId: parsed.nodeId,
      nodeName: typeof parsed.nodeName === 'string' && parsed.nodeName !== '' ? parsed.nodeName : parsed.nodeId,
      term: Number(parsed.term),
      role: parsed.role === 'master' ? 'master' : 'backup',
    };
  } catch {
    return null;
  }
}

export interface DiscordWitnessOptions {
  token: string;
  nodeId: string;
  nodeName: string;
  /** Configured beacon channel id from the fleet config; null/empty = owner DM default. */
  getChannelId: () => string | null;
}

export class DiscordWitness implements FleetWitness {
  private botUserId: string | null = null;
  private dmChannelId: string | null = null;
  private activeChannelId: string | null = null;
  private home: 'dm' | 'channel' | null = null;
  private beaconMessageId: string | null = null;
  private lastRenewAt: number | null = null;
  private lastRenewOk = false;
  private lastError: string | null = null;
  private lastReadAt: number | null = null;
  private lastClaims: WitnessClaim[] = [];
  // Monotonic edit nonce: steady-state renews would otherwise PATCH identical
  // content, and freshness must never depend on Discord bumping
  // edited_timestamp for a no-op edit. Seeded from the clock so a restart can
  // never resume at a previously-used value.
  private seq = Date.now();

  constructor(private readonly opts: DiscordWitnessOptions) {}

  getStatus(): WitnessStatus {
    return {
      home: this.home,
      channelId: this.activeChannelId,
      beaconMessageId: this.beaconMessageId,
      lastRenewAt: this.lastRenewAt,
      lastRenewOk: this.lastRenewOk,
      lastError: this.lastError,
      lastReadAt: this.lastReadAt,
      claims: this.lastClaims,
    };
  }

  async renewClaim(term: number, role: WitnessRole): Promise<boolean> {
    const channelId = await this.resolveHome();
    if (channelId === null) return this.renewFailed('beacon home unresolved (Discord unreachable or owner DM unavailable)');
    const content = `${BEACON_MARKER}\n${JSON.stringify({ nodeId: this.opts.nodeId, nodeName: this.opts.nodeName, term, role, seq: ++this.seq })}`;
    if (this.beaconMessageId === null) {
      const adopted = await this.findOwnBeacon(channelId);
      if (adopted === undefined) return this.renewFailed('beacon lookup failed');
      this.beaconMessageId = adopted;
    }
    if (this.beaconMessageId !== null) {
      const edited = await rest('PATCH', `/channels/${channelId}/messages/${this.beaconMessageId}`, this.opts.token, { content });
      if (edited && edited.status === 200) return this.renewOk();
      if (edited && edited.status === 404) this.beaconMessageId = null;
      else return this.renewFailed(`beacon edit failed${edited ? ` (HTTP ${edited.status})` : ''}`);
    }
    const created = await rest('POST', `/channels/${channelId}/messages`, this.opts.token, { content });
    if (created && created.status === 200 && typeof created.json?.id === 'string') {
      this.beaconMessageId = created.json.id;
      return this.renewOk();
    }
    return this.renewFailed(`beacon post failed${created ? ` (HTTP ${created.status})` : ''}`);
  }

  async readClaims(): Promise<WitnessClaim[] | null> {
    const channelId = await this.resolveHome();
    const botId = channelId === null ? null : await this.ensureBotUserId();
    if (channelId === null || botId === null) return null;
    const messages = await this.listMessages(channelId);
    if (messages === null) return null;
    const seen = new Set<string>();
    const claims: WitnessClaim[] = [];
    for (const msg of messages) {
      if (msg?.author?.id !== botId) continue;
      const parsed = parseBeacon(msg?.content);
      if (!parsed || seen.has(parsed.nodeId)) continue;
      seen.add(parsed.nodeId);
      const stamp = Date.parse(msg.edited_timestamp ?? msg.timestamp ?? '');
      claims.push({ ...parsed, observedAt: Number.isFinite(stamp) ? stamp : 0 });
    }
    this.lastClaims = claims;
    this.lastReadAt = Date.now();
    return claims;
  }

  /**
   * Re-anchor a buried beacon: drop the old message and publish afresh at the
   * top of the channel. Driven by the loop when a successful renew's own claim
   * is invisible to readers (a PATCH never moves a message up in history).
   */
  async repostBeacon(term: number, role: WitnessRole): Promise<boolean> {
    if (this.beaconMessageId !== null && this.activeChannelId !== null) {
      // Awaited: an in-flight DELETE would race the rebuild's own-beacon scan.
      await rest('DELETE', `/channels/${this.activeChannelId}/messages/${this.beaconMessageId}`, this.opts.token);
      this.beaconMessageId = null;
    }
    return this.renewClaim(term, role);
  }

  /**
   * Newest-first message scan, paginated to the bounded horizon. Null = the
   * scan failed. A mid-scan page failure fails the WHOLE scan: partial data
   * would read as an authoritative "absent" and mint duplicate beacons.
   */
  private async listMessages(channelId: string): Promise<any[] | null> {
    const messages: any[] = [];
    let before = '';
    for (let page = 0; page < SCAN_PAGE_CAP; page++) {
      const res = await rest('GET', `/channels/${channelId}/messages?limit=${SCAN_PAGE_SIZE}${before ? `&before=${before}` : ''}`, this.opts.token);
      if (!res || res.status !== 200 || !Array.isArray(res.json)) return null;
      messages.push(...res.json);
      if (res.json.length < SCAN_PAGE_SIZE) break;
      const last = res.json[res.json.length - 1];
      if (typeof last?.id !== 'string') break;
      before = last.id;
    }
    return messages;
  }

  private renewOk(): boolean {
    this.lastRenewAt = Date.now();
    this.lastRenewOk = true;
    this.lastError = null;
    return true;
  }

  private renewFailed(error: string): false {
    this.lastRenewOk = false;
    this.lastError = error;
    return false;
  }

  private async resolveHome(): Promise<string | null> {
    const configured = (this.opts.getChannelId() || '').trim();
    const wanted = configured !== '' ? configured : await this.resolveDmChannel();
    if (wanted === null) return null;
    if (this.activeChannelId !== null && this.activeChannelId !== wanted && this.beaconMessageId !== null) {
      // Best effort: the previous home must not keep a claim that will never refresh again.
      void rest('DELETE', `/channels/${this.activeChannelId}/messages/${this.beaconMessageId}`, this.opts.token);
      this.beaconMessageId = null;
    }
    this.activeChannelId = wanted;
    this.home = configured !== '' ? 'channel' : 'dm';
    return wanted;
  }

  private async resolveDmChannel(): Promise<string | null> {
    if (this.dmChannelId) return this.dmChannelId;
    const app = await rest('GET', '/oauth2/applications/@me', this.opts.token);
    // Team-owned apps report a pseudo-user owner whose DMs cannot open; the team owner is the human.
    const ownerId: unknown = app?.status === 200 ? (app.json?.team?.owner_user_id ?? app.json?.owner?.id) : undefined;
    if (typeof ownerId !== 'string' || ownerId === '') return null;
    const dm = await rest('POST', '/users/@me/channels', this.opts.token, { recipient_id: ownerId });
    if (!dm || dm.status !== 200 || typeof dm.json?.id !== 'string') return null;
    this.dmChannelId = dm.json.id;
    return this.dmChannelId;
  }

  private async ensureBotUserId(): Promise<string | null> {
    if (this.botUserId) return this.botUserId;
    const me = await rest('GET', '/users/@me', this.opts.token);
    if (!me || me.status !== 200 || typeof me.json?.id !== 'string') return null;
    this.botUserId = me.json.id;
    return this.botUserId;
  }

  /** Own beacon in the home, if any. Undefined = the lookup itself failed. */
  private async findOwnBeacon(channelId: string): Promise<string | null | undefined> {
    const botId = await this.ensureBotUserId();
    if (botId === null) return undefined;
    const messages = await this.listMessages(channelId);
    if (messages === null) return undefined;
    for (const msg of messages) {
      if (msg?.author?.id !== botId) continue;
      const parsed = parseBeacon(msg?.content);
      if (parsed && parsed.nodeId === this.opts.nodeId && typeof msg?.id === 'string') return msg.id;
    }
    return null;
  }
}

export interface WitnessLoopOptions extends DiscordWitnessOptions {
  role: WitnessRole;
  getTerm: () => number;
}

/** Build a witness and drive its renew loop; a successful renew is followed by a read so drills can verify both halves. */
export function startWitnessLoop(opts: WitnessLoopOptions): FleetWitness {
  const witness = new DiscordWitness(opts);
  let inFlight = false;
  const tick = async () => {
    // A slow tick must never overlap the next: two live ticks can both POST
    // and leave a duplicate beacon whose staleness reads as false evidence.
    if (inFlight) return;
    inFlight = true;
    try {
      const ok = await witness.renewClaim(opts.getTerm(), opts.role);
      if (!ok) return;
      const claims = await witness.readClaims();
      if (claims !== null && !claims.some(c => c.nodeId === opts.nodeId)) {
        await witness.repostBeacon(opts.getTerm(), opts.role);
      }
    } catch (error) {
      // The suppliers are externally owned; a throw here must never become an
      // unhandled rejection that takes the bot child down.
      console.warn('[Fleet] Witness tick failed:', error instanceof Error ? error.message : error);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  setInterval(() => void tick(), WITNESS_RENEW_MS).unref();
  return witness;
}
