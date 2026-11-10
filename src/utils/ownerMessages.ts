import { createHash } from 'crypto';
import { RateLimitError, REST } from 'discord.js';
import { loadCredentials } from './envLoader';

/**
 * NB5 decision 8: the switch notices and owner messages in the owner's Discord DM, through Discord's REST API with one
 * attempt per request, so a 429 is a failure carrying its retry_after and no request outlives its caller's budget.
 */

export const NOTICE_TITLE = 'Main database moved';
const DEFAULT_REQUEST_MS = 10_000;
let requestMs = DEFAULT_REQUEST_MS;
const PIN_LIMIT = 50;
const RECENT_LIMIT = 100;

export interface OwnerRest {
  get(route: string, options: { signal: AbortSignal; query?: URLSearchParams }): Promise<unknown>;
  post(route: string, options: { signal: AbortSignal; body: unknown }): Promise<unknown>;
  put(route: string, options: { signal: AbortSignal }): Promise<unknown>;
  delete(route: string, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface OwnerRestOptions {
  version: string;
  retries: number;
  timeout: number;
  rejectOnRateLimit: () => boolean;
}

type RestFactory = (options: OwnerRestOptions) => OwnerRest;

const realRest: RestFactory = options => new REST(options).setToken(loadCredentials().DISCORD_TOKEN ?? '') as unknown as OwnerRest;
let restFactory: RestFactory = realRest;
let rest: OwnerRest | null = null;

/** Tests give a fake REST; null restores Discord's. */
export function _setOwnerRestFactory(factory: RestFactory | null): void {
  restFactory = factory ?? realRest;
  rest = null;
}

/** Tests shorten the 10 s request bound; null restores it. */
export function _setOwnerRequestMs(ms: number | null): void {
  requestMs = ms ?? DEFAULT_REQUEST_MS;
}

let ids: { botId: string; dmChannel: string } | null = null;
let reading: Promise<NoticeRead> | null = null;

export function _resetOwnerMessages(): void {
  ids = null;
  reading = null;
  rest = null;
}

/** `machines`: every machine the bot's notices name at that generation, sorted; absent reads as `[machine]`. */
export type NoticeRead =
  | { kind: 'none' }
  | { kind: 'notice'; generation: number; machine: string; date: string; machines?: string[] }
  | { kind: 'failed'; cause: string; status?: number; retryAfterMs?: number };

export interface Notice {
  machine: string;
  generation: number;
  date: string;
}

/** A notice as read; a tie notice (NB24) has the field `Also announced`, one other machine per line. */
export type ParsedNotice = Notice & { tie: boolean; also: string[] };

export const ALSO_FIELD = 'Also announced';
const FIELD_VALUE_MAX = 1024;

/** Machines joined as `A`, `A and B`, `A, B and C`. */
export function machineList(machines: string[]): string {
  if (machines.length <= 1) return machines.join('');
  return `${machines.slice(0, -1).join(', ')} and ${machines[machines.length - 1]}`;
}

export const sortedMachines = (names: Iterable<string>): string[] => [...new Set(names)].sort();

/** The machines a notice names: its `Machine` and every machine of its `Also announced`. */
export function namesOf(notice: ParsedNotice): string[] {
  return sortedMachines([notice.machine, ...notice.also]);
}

/** Every machine the notices name at a generation, sorted. */
export function machinesAt(found: ParsedNotice[], generation: number): string[] {
  return sortedMachines(found.filter(n => n.generation === generation).flatMap(n => [n.machine, ...n.also]));
}

/** A request that did not get the answer asked for: Discord's refusal (status, code, message), a timeout, or the network. */
export interface RequestFailureInfo {
  cause: string;
  status?: number;
  code?: number;
  message?: string;
  timeout?: true;
  /** A message create that failed with no Discord status or with a 5xx: the message may have been posted. */
  unconfirmed?: true;
  /** No request was sent: the budget was gone when it was due. */
  lapsed?: true;
}

class RequestFailure extends Error {
  constructor(readonly info: RequestFailureInfo, readonly retryAfterMs?: number) {
    super(info.cause);
  }
  get status(): number | undefined {
    return this.info.status;
  }
}

function client(): OwnerRest {
  if (!rest) rest = restFactory({ version: '10', retries: 0, timeout: DEFAULT_REQUEST_MS, rejectOnRateLimit: () => true });
  return rest;
}

function failureOf(error: unknown): RequestFailure {
  if (error instanceof RequestFailure) return error;
  const e = error as { name?: string; status?: number; message?: string; retryAfter?: number; code?: unknown; rawError?: { message?: unknown } } | null;
  if (error instanceof RateLimitError || e?.status === 429) {
    const retryAfterMs = typeof e?.retryAfter === 'number' ? e.retryAfter : undefined;
    const seconds = retryAfterMs === undefined ? '' : `, retry after ${Math.ceil(retryAfterMs / 1000)} s`;
    return new RequestFailure({ cause: `HTTP 429 (rate limited${seconds})`, status: 429 }, retryAfterMs);
  }
  if (typeof e?.status === 'number') {
    const message = typeof e.rawError?.message === 'string' ? e.rawError.message : e.message ?? 'no message';
    return new RequestFailure({
      cause: `HTTP ${e.status} (${message})`, status: e.status, message,
      ...(typeof e.code === 'number' ? { code: e.code } : {}),
    });
  }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new RequestFailure({ cause: 'a timeout', timeout: true });
  const code = typeof e?.code === 'string' ? e.code : undefined;
  return new RequestFailure({ cause: `a network error (${code ?? e?.message ?? String(error)})` });
}

/** One request: a signal of the smaller of 10 s and the budget left; none starts once the budget lapsed. */
async function request<T>(deadline: number, send: (signal: AbortSignal) => Promise<unknown>): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new RequestFailure({ cause: 'a timeout', timeout: true, lapsed: true });
  try {
    return (await send(AbortSignal.timeout(Math.min(requestMs, left)))) as T;
  } catch (error) {
    const failure = failureOf(error);
    if (failure.status === 404 || failure.status === 403) ids = null;
    throw failure;
  }
}

async function ownerIds(deadline: number): Promise<{ botId: string; dmChannel: string }> {
  if (ids) return ids;
  const app = await request<{ owner?: { id?: string }; team?: { owner_user_id?: string } | null; bot?: { id?: string } }>(
    deadline, signal => client().get('/applications/@me', { signal }));
  const owner = app.team?.owner_user_id ?? app.owner?.id;
  const botId = app.bot?.id;
  if (!owner || !botId) throw new RequestFailure({ cause: 'the application has no owner or bot user' });
  const channel = await request<{ id?: string }>(deadline, signal => client().post('/users/@me/channels', { signal, body: { recipient_id: owner } }));
  if (!channel.id) throw new RequestFailure({ cause: 'the DM channel has no id' });
  ids = { botId, dmChannel: channel.id };
  return ids;
}

interface MessageLike {
  id?: string;
  author?: { id?: string };
  timestamp?: string;
  embeds?: Array<{ title?: string; timestamp?: string; fields?: Array<{ name?: string; value?: string }> }>;
}

function noticeOf(message: MessageLike, botId: string): ParsedNotice | null {
  if (message?.author?.id !== botId) return null;
  const embed = message.embeds?.[0];
  if (!embed || embed.title !== NOTICE_TITLE) return null;
  const field = (name: string) => embed.fields?.find(f => f.name === name)?.value;
  const raw = field('Generation');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  const tie = embed.fields?.some(f => f.name === ALSO_FIELD) ?? false;
  const alsoText = field(ALSO_FIELD);
  const also = typeof alsoText === 'string' ? alsoText.split('\n').filter(line => line !== '') : [];
  return { generation, machine: field('Machine') ?? '', date: embed.timestamp ?? message.timestamp ?? '', tie, also };
}

export type FoundNotice = ParsedNotice & { messageId: string; pinned: boolean };

/** The bot's notices in a channel: the highest one, the pinned ones with their generations, every one read, and how many messages of any kind were read. */
interface ChannelNotices {
  best: FoundNotice | null;
  pinned: Array<{ messageId: string; generation: number }>;
  found: FoundNotice[];
  messages: number;
}

async function noticesIn(channel: string, botId: string, deadline: number, withPins: boolean): Promise<ChannelNotices> {
  const pins = withPins
    ? await request<unknown>(deadline, signal => client().get(`/channels/${channel}/messages/pins`, { signal, query: new URLSearchParams({ limit: String(PIN_LIMIT) }) }))
    : [];
  const recent = await request<unknown>(deadline, signal => client().get(`/channels/${channel}/messages`, { signal, query: new URLSearchParams({ limit: String(RECENT_LIMIT) }) }));
  const pinnedMessages = (Array.isArray(pins) ? pins : ((pins as { items?: Array<{ message?: MessageLike }> })?.items ?? []).map(item => item.message)) as MessageLike[];
  const recentMessages = Array.isArray(recent) ? (recent as MessageLike[]) : [];
  const out: ChannelNotices = { best: null, pinned: [], found: [], messages: pinnedMessages.length + recentMessages.length };
  const seen = new Set<string>();
  const consider = (message: MessageLike, pinned: boolean) => {
    const found = noticeOf(message, botId);
    if (!found) return;
    const messageId = String(message.id ?? '');
    if (pinned) out.pinned.push({ messageId, generation: found.generation });
    if (!seen.has(messageId)) {
      seen.add(messageId);
      out.found.push({ ...found, messageId, pinned });
    }
    if (!out.best || found.generation > out.best.generation || (found.generation === out.best.generation && pinned && !out.best.pinned)) {
      out.best = { ...found, messageId, pinned };
    }
  };
  for (const message of pinnedMessages) consider(message, true);
  for (const message of recentMessages) consider(message, false);
  return out;
}

function readFailed(error: unknown): NoticeRead {
  const failure = failureOf(error);
  return {
    kind: 'failed', cause: failure.info.cause,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  };
}

/** No budget gives each request its own 10 s, with no shared cap: 40 s at most on a cold cache. */
function deadlineOf(budgetMs: number | undefined): number {
  return budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + budgetMs;
}

async function readOnce(budgetMs: number | undefined): Promise<NoticeRead> {
  const deadline = deadlineOf(budgetMs);
  try {
    const { botId, dmChannel } = await ownerIds(deadline);
    const { best, found } = await noticesIn(dmChannel, botId, deadline, true);
    return best
      ? { kind: 'notice', generation: best.generation, machine: best.machine, date: best.date, machines: machinesAt(found, best.generation) }
      : { kind: 'none' };
  } catch (error) {
    return readFailed(error);
  }
}

/**
 * The newest switch notice in the owner's DM. Single-flight: a caller that comes while a read runs gets its answer,
 * except a read of its own (decision 17's `chooseNow()`).
 */
export function readNewestNotice(opts: { budgetMs?: number; own?: boolean } = {}): Promise<NoticeRead> {
  const budgetMs = opts.budgetMs;
  if (opts.own) return readOnce(budgetMs);
  if (!reading) {
    const read = readOnce(budgetMs).finally(() => { if (reading === read) reading = null; });
    reading = read;
  }
  return reading;
}

/** The notice's embed (decision 8); given other machines, the tie notice (NB24) naming as many as fit in one field. */
export function noticeEmbed(notice: Notice, others?: string[]): { title: string; description: string; fields: Array<{ name: string; value: string }>; timestamp: string } {
  const fields = [{ name: 'Machine', value: notice.machine.slice(0, 256) }, { name: 'Generation', value: String(notice.generation) }];
  if (!others || others.length === 0) {
    return {
      title: NOTICE_TITLE,
      description: `The main database of this bot is now on ${notice.machine}, since ${notice.date}. A machine whose database was the main before stays stopped until it rejoins as a live copy.`,
      fields,
      timestamp: notice.date,
    };
  }
  const fit: string[] = [];
  let length = 0;
  for (const name of sortedMachines(others)) {
    const added = (fit.length === 0 ? 0 : 1) + name.length;
    if (length + added > FIELD_VALUE_MAX) break;
    fit.push(name);
    length += added;
  }
  return {
    title: NOTICE_TITLE,
    description: `${notice.machine} also announced itself as the main database of this bot at generation ${notice.generation}, since ${notice.date}, while ${machineList(fit)} announced the same generation. The bot stops on every machine that reads these notices, until the owner presses Keep this machine as the main in one machine's Bot Manager and rejoins the others as copies.`,
    fields: [...fields, { name: ALSO_FIELD, value: fit.join('\n') }],
    timestamp: notice.date,
  };
}

/** The first 25 characters of the base64url SHA-256 of a text: a nonce no two places share. */
export function hashNonce(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 25);
}

/** The boot wait's DM nonce (decision 9). */
export function waitNonce(processId: string): string {
  return hashNonce(`wait:${processId}`);
}

/** Posts a text to the owner's DM; ok only when Discord's answer names the DM channel. */
export async function sendOwnerDm(content: string, nonce: string, budgetMs?: number): Promise<{ ok: true } | { ok: false; cause: string; status?: number }> {
  const deadline = deadlineOf(budgetMs);
  try {
    const { dmChannel } = await ownerIds(deadline);
    const sent = await request<{ channel_id?: string }>(deadline, signal => client().post(`/channels/${dmChannel}/messages`, {
      signal, body: { content, nonce, enforce_nonce: true },
    }));
    if (sent?.channel_id !== dmChannel) return { ok: false, cause: 'Discord answered with a message in another channel' };
    return { ok: true };
  } catch (error) {
    const failure = failureOf(error);
    return { ok: false, cause: failure.info.cause, ...(failure.status !== undefined ? { status: failure.status } : {}) };
  }
}

// ============================================================================
// POSTS IN A PLACE (decisions 14, 15 and 23)
// ============================================================================

export type OwnerPlace = { kind: 'dm' } | { kind: 'channel'; id: string };

/** `notice`, a DM place only: Discord's answer read as a notice of the bot, null when it is none. */
export type PostAnswer =
  | { ok: true; channelId: string; messageId: string; askedChannel: string; notice?: ParsedNotice | null }
  | { ok: false; failure: RequestFailureInfo; sent: boolean };

/** `<code> <message>` of Discord's refusal, or the failure's cause when Discord gave no code. */
export function discordWords(failure: RequestFailureInfo): string {
  if (failure.code !== undefined && failure.message !== undefined) return `${failure.code} ${failure.message}`;
  return failure.cause;
}

/** Decision 23's channel cause for a refusal in a channel. */
export function channelCause(failure: RequestFailureInfo): string {
  if (failure.code === 10003 || failure.status === 404) return 'the channel does not exist, or the bot is not in its server';
  if (failure.code === 50001) return 'the bot cannot see that channel';
  if (failure.code === 50013) return 'the bot lacks the Send Messages permission there';
  return `Discord answered ${discordWords(failure)}`;
}

/** The owner's DM channel id, from the cache or Discord. */
export async function ownerDmChannel(deadline: number): Promise<string> {
  return (await ownerIds(deadline)).dmChannel;
}

/** One message create in a place, with its nonce enforced; the answer carries the channel Discord's message is in. */
export async function postInPlace(place: OwnerPlace, body: Record<string, unknown>, nonce: string | null, deadline: number): Promise<PostAnswer> {
  let sent = false;
  try {
    let channel = place.kind === 'channel' ? place.id : '';
    let botId: string | null = null;
    if (place.kind === 'dm') {
      const owner = await ownerIds(deadline);
      channel = owner.dmChannel;
      botId = owner.botId;
    }
    const answer = await request<MessageLike & { channel_id?: string }>(deadline, signal => {
      sent = true;
      return client().post(`/channels/${channel}/messages`, { signal, body: nonce === null ? body : { ...body, nonce, enforce_nonce: true } });
    });
    const posted = { ok: true as const, channelId: String(answer?.channel_id ?? ''), messageId: String(answer?.id ?? ''), askedChannel: channel };
    return botId === null ? posted : { ...posted, notice: noticeOf(answer, botId) };
  } catch (error) {
    const info = failureOf(error).info;
    const unconfirmed = sent && !info.timeout && (info.status === undefined || info.status >= 500);
    return { ok: false, failure: unconfirmed ? { ...info, unconfirmed: true } : info, sent };
  }
}

/** The words for where a message is: the owner's DMs or `channel <id>`. */
export async function placeWords(channelId: string, deadline: number): Promise<string> {
  let dm = ids?.dmChannel ?? null;
  if (dm === null) {
    try { dm = await ownerDmChannel(deadline); } catch { dm = null; }
  }
  return channelId === dm ? "the owner's DMs" : `channel ${channelId}`;
}

/** The bot's notices in a place (the DM reads its pins too): the highest, the pinned ones, and every one read. */
export async function readNoticesIn(place: OwnerPlace, deadline: number): Promise<
  { ok: true; channel: string; best: FoundNotice | null; pinned: Array<{ messageId: string; generation: number }>; found: FoundNotice[]; messages: number }
  | { ok: false; failure: RequestFailureInfo }
> {
  try {
    const { botId, dmChannel } = await ownerIds(deadline);
    const channel = place.kind === 'dm' ? dmChannel : place.id;
    const found = await noticesIn(channel, botId, deadline, place.kind === 'dm');
    return { ok: true, channel, ...found };
  } catch (error) {
    return { ok: false, failure: failureOf(error).info };
  }
}

/** Pins a message (Discord's current pin route); answers the failure when it was not pinned. */
export async function pinMessage(channel: string, messageId: string, deadline: number): Promise<RequestFailureInfo | null> {
  try {
    await request(deadline, signal => client().put(`/channels/${channel}/messages/pins/${messageId}`, { signal }));
    return null;
  } catch (error) {
    return failureOf(error).info;
  }
}

/** Unpins the given messages, best effort: an older notice left pinned does not change which one is the highest. */
export async function unpinMessages(channel: string, messageIds: string[], deadline: number): Promise<void> {
  for (const id of messageIds) {
    try {
      await request(deadline, signal => client().delete(`/channels/${channel}/messages/pins/${id}`, { signal }));
    } catch {
      continue;
    }
  }
}
