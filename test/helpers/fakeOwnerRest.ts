import { DiscordAPIError, HTTPError, RateLimitError } from 'discord.js';
import { _resetOwnerMessages, _setOwnerRestFactory, _setOwnerRequestMs } from '../../src/utils/ownerMessages';

// A fake of Discord's REST API for NB5's owner messages: the owner lookup, the DM channel, message creates (with the
// channel_id Discord answers), pins and the newest messages per channel. Routes can be scripted to fail or to hang
// until the request's signal aborts.

export const BOT = '200000000000000001';
export const OWNER = '300000000000000001';
export const DM = '400000000000000001';

export interface RestCall { method: 'get' | 'post' | 'put' | 'delete'; route: string; options: any; aborted?: boolean }
type Script = (call: RestCall) => unknown;

/** A Discord API error as discord.js's REST rejects with it. */
export function discordError(status: number, code: number, message: string): Error {
  return new DiscordAPIError({ code, message }, code, status, 'POST', 'https://discord.com/api/v10/x', {});
}

/** A 429 as the REST rejects with it under `rejectOnRateLimit` (retryAfter in ms). */
export function rateLimitError(retryAfterMs: number, route = '/channels/:id/messages'): Error {
  return new RateLimitError({
    timeToReset: retryAfterMs, limit: 5, method: 'POST', hash: 'h', url: 'https://discord.com/api/v10/x', route,
    majorParameter: 'm', global: false, retryAfter: retryAfterMs, sublimitTimeout: 0, scope: 'user',
  });
}

/** A 5xx with no Discord error body, as the REST rejects with it. */
export function httpError(status: number, statusText: string): Error {
  return new HTTPError(status, statusText, 'POST', 'https://discord.com/api/v10/x', {});
}

/** undici's network failure (the socket reset after the request was written), which the REST rethrows as it is. */
export function networkError(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

export class FakeOwnerRest {
  calls: RestCall[] = [];
  aborted: RestCall[] = [];
  messages = new Map<string, any[]>();
  pinned = new Map<string, Set<string>>();
  private scripts: Array<{ method: string; route: RegExp; answer: Script }> = [];
  private seq = 0;
  /** Discord's nonce dedupe: a create in one channel by one author with an enforced nonce seen before answers that message. */
  private nonces = new Map<string, any>();
  /** While false every request hangs until its signal aborts. */
  answering = true;

  constructor(requestMs = 10_000) {
    _resetOwnerMessages();
    _setOwnerRequestMs(requestMs);
    _setOwnerRestFactory(() => ({
      get: (route: string, options: any) => this.call('get', route, options),
      post: (route: string, options: any) => this.call('post', route, options),
      put: (route: string, options: any) => this.call('put', route, options),
      delete: (route: string, options: any) => this.call('delete', route, options),
    }));
  }

  static reset(): void {
    _setOwnerRestFactory(null);
    _setOwnerRequestMs(null);
    _resetOwnerMessages();
  }

  /** The answer of a route: a value, a Promise, or a thrown error; 'hang' waits for the abort. */
  on(method: RestCall['method'], route: RegExp, answer: Script): this {
    this.scripts.unshift({ method, route, answer });
    return this;
  }

  fail(method: RestCall['method'], route: RegExp, error: Error): this {
    return this.on(method, route, () => { throw error; });
  }

  hang(method: RestCall['method'], route: RegExp): this {
    return this.on(method, route, () => 'hang');
  }

  /** A message of the bot (or another author) put in a channel, newest first. */
  seed(channel: string, message: any, pin = false): any {
    const m = { id: `seed${++this.seq}`, channel_id: channel, author: { id: BOT }, timestamp: '2026-11-01T10:00:00.000Z', ...message };
    this.messages.set(channel, [m, ...(this.messages.get(channel) ?? [])]);
    if (pin) this.pins(channel).add(m.id);
    return m;
  }

  /** Discord's nonce window has passed: every nonce may create a message again. */
  expireNonces(): void {
    this.nonces.clear();
  }

  creates(channel?: string): RestCall[] {
    return this.calls.filter(c => c.method === 'post' && /^\/channels\/\d+\/messages$/.test(c.route) && (!channel || c.route === `/channels/${channel}/messages`));
  }

  private pins(channel: string): Set<string> {
    let set = this.pinned.get(channel);
    if (!set) this.pinned.set(channel, set = new Set());
    return set;
  }

  /** Waits ms for a scripted answer; the call's signal firing first rejects it as discord.js rejects an aborted request. */
  delay(ms: number, call: RestCall): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal: AbortSignal | undefined = call.options?.signal;
      const abort = () => {
        clearTimeout(timer);
        call.aborted = true;
        this.aborted.push(call);
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private hangUntilAbort(call: RestCall): Promise<never> {
    return new Promise((_, reject) => {
      const signal: AbortSignal | undefined = call.options?.signal;
      const abort = () => {
        call.aborted = true;
        this.aborted.push(call);
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async call(method: RestCall['method'], route: string, options: any): Promise<unknown> {
    const call: RestCall = { method, route, options };
    this.calls.push(call);
    if (!this.answering) return this.hangUntilAbort(call);
    for (const s of this.scripts) {
      if (s.method !== method || !s.route.test(route)) continue;
      const answer = await s.answer(call);
      if (answer === 'hang') return this.hangUntilAbort(call);
      if (answer !== undefined) return answer;
    }
    return this.real(method, route, options);
  }

  private real(method: RestCall['method'], route: string, options: any): unknown {
    if (method === 'get' && route === '/applications/@me') return { owner: { id: OWNER }, bot: { id: BOT } };
    if (method === 'post' && route === '/users/@me/channels') return { id: DM };
    const create = /^\/channels\/(\d+)\/messages$/.exec(route);
    if (create && method === 'post') {
      const body = options.body ?? {};
      const key = body.enforce_nonce === true && typeof body.nonce === 'string' ? JSON.stringify([create[1], BOT, body.nonce]) : null;
      if (key !== null && this.nonces.has(key)) return this.nonces.get(key);
      const message = this.seed(create[1], { id: `msg${++this.seq}`, content: body.content, embeds: body.embeds ?? [], nonce: body.nonce });
      if (key !== null) this.nonces.set(key, message);
      return message;
    }
    if (create && method === 'get') return [...(this.messages.get(create[1]) ?? [])];
    const pins = /^\/channels\/(\d+)\/messages\/pins$/.exec(route);
    if (pins && method === 'get') {
      const set = this.pins(pins[1]);
      const items = (this.messages.get(pins[1]) ?? []).filter(m => set.has(m.id)).map(message => ({ pinned_at: '2026-11-01T10:00:00.000Z', message }));
      return { items, has_more: false };
    }
    const pin = /^\/channels\/(\d+)\/messages\/pins\/(\w+)$/.exec(route);
    if (pin && method === 'put') { this.pins(pin[1]).add(pin[2]); return undefined; }
    if (pin && method === 'delete') { this.pins(pin[1]).delete(pin[2]); return undefined; }
    throw new Error(`fakeOwnerRest: no answer for ${method} ${route}`);
  }
}
