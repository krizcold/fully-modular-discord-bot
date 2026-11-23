/**
 * One Stripe Customer per Discord member (P3 sheet, section 3): payment-providers/stripe/customers.json maps a buyer's
 * Discord id to that buyer's Customer, or to a create sent with a stored Idempotency-Key whose answer is not stored
 * yet. Read fresh on every use. Each save is confirmed before the next call to Stripe: on JSON the file write through
 * confirmFile, on Postgres the row op through its outcome within 8 s; the Postgres update refuses only a change of the
 * same buyer's entry made elsewhere.
 */

import { randomBytes } from 'crypto';
import { dataPath } from '../../../../utils/dataRoot';
import { rawTicket, readRawStrict, updateRawTracked, writeRawAtomicTracked, type RawWriteTracked } from '../dataManager';
import { confirmFile } from '../dataBackends/fileBackend';
import { latestRowTicket, rowOutcome, sharedKeyOf, shaOf } from '../sharedStore';
import { isDiscordId } from '../premiumHolder';

const DOC_NAME = 'payment-providers/stripe/customers.json';
const CONFIRM_MS = 8_000;
/** Stripe keeps an Idempotency-Key's answer for at least 24 hours; a pending key is reused only inside 23. */
const KEY_REUSE_MS = 23 * 60 * 60 * 1000;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

type CustomerEntry = { customerId: string; createdAt: string; [field: string]: unknown };
type PendingEntry = { pendingKey: string; startedAt: string; [field: string]: unknown };
type Entry = CustomerEntry | PendingEntry;

/** A Stripe API call; the customer create passes its Idempotency-Key as the fourth argument. */
export type StripeApi = <T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, formBody?: Record<string, string>, idempotencyKey?: string) => Promise<T>;

/** An error of a Stripe API call: the HTTP status with Stripe's code and param, or status null when no answer came. */
export class StripeApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly code?: string, readonly param?: string) {
    super(message);
  }
}

/** The bot cannot call Stripe at all (no secret key set); nothing was sent. */
export class StripeNotCalled extends Error {}

const docPath = (): string => dataPath('global', 'payment-providers', 'stripe', 'customers.json');

const sentence = (text: string): string => text.trim().replace(/\.+$/, '');

const st1 = (cause: string) => new Error(`Stripe checkout did not start: ${DOC_NAME} cannot be read (${cause}). Nothing was charged.`);
const st2 = (cause: string) => new Error(`Stripe checkout did not start: the bot did not save your Stripe billing account (${causeWords(cause)}). Nothing was charged.`);
const st3 = (reason: string) => new Error(`Can't confirm that the bot saved your Stripe billing account (${reason}), so no checkout was started. Nothing was charged; try again in a moment.`);
const st4 = (message: string) => new Error(`Stripe did not create your billing account: ${sentence(message)}. Nothing was charged.`);
const st5 = (reason: string) => new Error(`Can't confirm whether Stripe created your billing account (${reason}). Nothing was charged; try again in a moment.`);

const CAUSE_WORDS: Record<string, string> = {
  'changed-elsewhere': `another machine changed your entry in ${DOC_NAME} at the same time`,
  'storage-failing': 'the bot cannot write to its disk right now',
  'database-backlog': "the bot's database is behind on saving changes",
  'not-ready': 'this process may not write the data files right now',
  'writer-lost': 'another bot process took over writing the data files',
  io: 'the disk or the database answered the write with an error',
  unstorable: 'the file could not be stored',
};

function causeWords(cause: string): string {
  return CAUSE_WORDS[cause] ?? cause;
}

class DocUnreadable extends Error {}
class EntryChanged extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isCustomer(entry: Entry | undefined): entry is CustomerEntry {
  return !!entry && 'customerId' in entry;
}

function validEntry(buyerId: string, value: unknown): value is Entry {
  if (!isDiscordId(buyerId) || !isObject(value)) return false;
  const customer = 'customerId' in value;
  const pending = 'pendingKey' in value;
  if (customer === pending) return false;
  if (customer) return typeof value.customerId === 'string' && CUSTOMER_ID.test(value.customerId) && isTime(value.createdAt);
  return typeof value.pendingKey === 'string' && new RegExp(`^smdb-customer-${buyerId}-[0-9a-f]{16}$`).test(value.pendingKey) && isTime(value.startedAt);
}

interface Loaded {
  doc: Record<string, unknown>;
  customers: Record<string, Entry>;
  dropped: number;
}

/** The load rule: a doc holding an object under `customers`; the entries that fail the rule are left out. */
function loadValue(value: unknown): Loaded {
  if (!isObject(value)) throw new DocUnreadable('it holds no object');
  if (!isObject(value.customers)) throw new DocUnreadable('its customers field is not an object');
  const customers: Record<string, Entry> = {};
  let dropped = 0;
  for (const [buyerId, entry] of Object.entries(value.customers)) {
    if (validEntry(buyerId, entry)) customers[buyerId] = entry;
    else dropped += 1;
  }
  return { doc: value, customers, dropped };
}

const warnedShas = new Set<string>();

/** The doc as this process sees it now (its queued write first); an absent doc is empty. Throws DocUnreadable. */
function readDoc(): Loaded {
  let text: string | null;
  try {
    text = readRawStrict(docPath());
  } catch (error) {
    throw new DocUnreadable(error instanceof Error ? error.message : String(error));
  }
  if (text === null) return { doc: { customers: {} }, customers: {}, dropped: 0 };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DocUnreadable('it is not valid JSON');
  }
  const loaded = loadValue(value);
  if (loaded.dropped > 0) {
    const sha = shaOf(Buffer.from(text, 'utf8'));
    if (!warnedShas.has(sha)) {
      warnedShas.add(sha);
      console.warn(`[StripeProvider] ${DOC_NAME} holds ${loaded.dropped} ${loaded.dropped === 1 ? 'entry' : 'entries'} this version does not read. They are not used, and the next save of the file writes it without them.`);
    }
  }
  return loaded;
}

function readOrRefuse(): Loaded {
  try {
    return readDoc();
  } catch (error) {
    if (error instanceof DocUnreadable) throw st1(error.message);
    throw error;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

const sameEntry = (a: Entry | null | undefined, b: Entry | null | undefined): boolean => canonical(a ?? null) === canonical(b ?? null);

/** The doc with this buyer's entry set (or removed for null), when the stored entry is still `expected`. */
function nextDoc(loaded: Loaded, buyerId: string, expected: Entry | null, next: Entry | null): Record<string, unknown> {
  if (!sameEntry(loaded.customers[buyerId], expected)) throw new EntryChanged('changed-elsewhere');
  const customers = { ...loaded.customers };
  if (next) customers[buyerId] = next;
  else delete customers[buyerId];
  return { ...loaded.doc, customers };
}

function fileReason(answer: 'pending' | 'held' | 'unavailable'): string {
  if (answer === 'pending') return 'the disk did not confirm the write within 8 s';
  if (answer === 'held') return 'the disk refused the write; the bot keeps trying it';
  return 'the write left the queue before the disk confirmed it';
}

/** A Postgres row op's outcome within 8 s: ok, ST2 when refused, ST3 when unconfirmed or past the bound. */
async function rowSettled(ticket: NonNullable<ReturnType<typeof latestRowTicket>>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'bound'>(resolve => {
    timer = setTimeout(() => resolve('bound'), CONFIRM_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([rowOutcome(ticket), bound]);
  if (timer) clearTimeout(timer);
  if (outcome === 'landed') return;
  if (outcome === 'bound') throw st3('the database did not confirm it within 8 s');
  if (outcome === 'unconfirmed') throw st3("the database's answer was lost");
  throw st2(outcome.refused.cause);
}

async function fileSettled(ticket: NonNullable<ReturnType<typeof rawTicket>>): Promise<void> {
  const answer = await confirmFile(ticket, CONFIRM_MS);
  if (answer !== 'ok') throw st3(fileReason(answer));
}

/** Waits for this process's write of the doc that has not landed, when there is one (a read of it is not stored yet). */
async function confirmQueued(): Promise<void> {
  const key = sharedKeyOf(docPath());
  if (key) {
    const ticket = latestRowTicket(key);
    if (ticket) await rowSettled(ticket);
    return;
  }
  const ticket = rawTicket(docPath());
  if (ticket) await fileSettled(ticket);
}

let chain: Promise<unknown> = Promise.resolve();

/** One read-modify-save of the doc at a time in this process. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Sets (or removes, for null) this buyer's entry when it is still `expected`, and waits until the save is stored. */
function save(buyerId: string, expected: Entry | null, next: Entry | null): Promise<void> {
  return serial(async () => {
    const file = docPath();
    const key = sharedKeyOf(file);
    let tracked: RawWriteTracked;
    try {
      tracked = key
        ? updateRawTracked(file, { customers: {} }, current => nextDoc(loadValue(current), buyerId, expected, next))
        : writeRawAtomicTracked(file, JSON.stringify(nextDoc(readDoc(), buyerId, expected, next), null, 2));
    } catch (error) {
      if (error instanceof EntryChanged) throw st2('changed-elsewhere');
      if (error instanceof DocUnreadable) throw st1(error.message);
      throw error;
    }
    if (!tracked.accepted) throw st2(tracked.cause);
    if (key) {
      const ticket = latestRowTicket(key);
      if (ticket) await rowSettled(ticket);
      return;
    }
    const ticket = rawTicket(file);
    if (ticket) await fileSettled(ticket);
  });
}

const inFlight = new Map<string, Promise<string>>();

/**
 * The buyer's Stripe Customer: the stored one, or one created with the stored Idempotency-Key. Throws ST1 to ST5;
 * every save it makes is confirmed before the next call to Stripe. A second call for the same buyer while one runs
 * takes its answer.
 */
export function customerFor(buyerId: string, api: StripeApi): Promise<string> {
  const running = inFlight.get(buyerId);
  if (running) return running;
  const started = resolveCustomer(buyerId, api).finally(() => {
    if (inFlight.get(buyerId) === started) inFlight.delete(buyerId);
  });
  inFlight.set(buyerId, started);
  return started;
}

async function resolveCustomer(buyerId: string, api: StripeApi): Promise<string> {
  const entry = readOrRefuse().customers[buyerId];
  if (isCustomer(entry)) {
    await confirmQueued();
    return entry.customerId;
  }
  let pending: PendingEntry;
  if (entry && Date.now() - Date.parse(entry.startedAt) < KEY_REUSE_MS) {
    pending = entry;
    await confirmQueued();
  } else {
    pending = { pendingKey: `smdb-customer-${buyerId}-${randomBytes(8).toString('hex')}`, startedAt: new Date().toISOString() };
    await save(buyerId, entry ?? null, pending);
  }
  let created: { id?: unknown };
  try {
    created = await api<{ id?: unknown }>('POST', '/v1/customers', { 'metadata[discordUserId]': buyerId }, pending.pendingKey);
  } catch (error) {
    if (error instanceof StripeNotCalled) throw st4(error.message);
    if (error instanceof StripeApiError && (error.status === 409 || error.code === 'idempotency_key_in_use')) throw st5(`Stripe is still answering an earlier request for your billing account: ${sentence(error.message)}`);
    if (error instanceof StripeApiError && error.status !== null && error.status >= 400 && error.status < 500) throw st4(error.message);
    if (error instanceof StripeApiError && error.status !== null && error.status >= 500) {
      // Stripe replays a 5xx for the key's whole life, so the next purchase starts from a new key.
      await save(buyerId, pending, null).catch(() => undefined);
      throw st5(`Stripe answered ${error.status}`);
    }
    throw st5(error instanceof Error ? sentence(error.message) : String(error));
  }
  const customerId = created?.id;
  if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId)) throw st5('its answer named no Customer');
  await save(buyerId, pending, { customerId, createdAt: new Date().toISOString() });
  return customerId;
}

/** Removes the buyer's entry when it still names customerId (the Customer was deleted at Stripe); throws ST1 to ST3. */
export async function forgetCustomer(buyerId: string, customerId: string): Promise<void> {
  const entry = readOrRefuse().customers[buyerId];
  if (!isCustomer(entry) || entry.customerId !== customerId) return;
  await save(buyerId, entry, null);
}

/** The portal's plain read: the buyer's stored Customer, null for none or a pending one; throws with the cause when the doc cannot be read. */
export function recordedCustomer(buyerId: string): string | null {
  let loaded: Loaded;
  try {
    loaded = readDoc();
  } catch (error) {
    if (error instanceof DocUnreadable) throw new Error(error.message);
    throw error;
  }
  const entry = loaded.customers[buyerId];
  return isCustomer(entry) ? entry.customerId : null;
}
