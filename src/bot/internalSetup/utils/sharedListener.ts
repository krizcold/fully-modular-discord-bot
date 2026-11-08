// The bot process's listening connection on a Postgres bot (NB6 decisions 10 and 29, C25 to C28): one connection
// outside the data pool, 'smdb-shared-listen', that LISTENs for the shared tables' notifications and for the guild
// requests addressed to this process. It checks itself every 30 s, is opened again 5 s after any failure and on a
// move to another database, and ends at the stop.

import { Client, type ClientConfig } from 'pg';
import { pgConfig } from '../../../utils/databaseAddress';
import { processId } from '../fleet/processId';

export const LISTEN_APPLICATION_NAME = 'smdb-shared-listen';
export const SHARED_CHANNEL = 'smdb_shared';
export const GUILD_REQUESTS_CHANNEL = 'smdb_guild_requests';

const CONNECT_MS = 5000;
const KEEPALIVE_DELAY_MS = 30_000;
const RETRY_MS = 5000;
const CHECK_EVERY_MS = 30_000;
const CHECK_BOUND_MS = 5000;
const LOG_AGAIN_MS = 10 * 60 * 1000;
const END_BOUND_MS = 2000;

/** The part of node-pg's Client the listener uses. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  on(event: 'notification', fn: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', fn: (error: Error) => void): unknown;
  on(event: 'end', fn: () => void): unknown;
  end(): Promise<unknown>;
}

export interface ListenerDeps {
  /** The entry the data pool is built from now; null before the choice. */
  entry(): string | null;
  /** Another process changed a doc key. */
  onDoc(key: string): void;
  /** Another process published or removed a module. */
  onModule?(module: string): void;
  /** The LISTENs answered: the pass runs (decision 11), and the sweep's pass. */
  onConnected(): void;
  /** A guild request addressed to this process (decision 17). */
  onGuildRequest(): void;
  /** Registers the call made when NB5 moves this process to another database. */
  onDatabaseChanged?(cb: () => void): void;
}

let makeClient: (config: ClientConfig) => ListenClient = config => new Client(config);

/** Tests give the listener their own client. */
export function _setListenClientFactory(factory: ((config: ClientConfig) => ListenClient) | null): void {
  makeClient = factory ?? (config => new Client(config));
}

/** C26: the channels a connected client LISTENs on. NB15 narrows it for a client its transport check classes. */
export function channelsFor(_client: ListenClient): string[] {
  return [SHARED_CHANNEL, GUILD_REQUESTS_CHANNEL];
}

interface Run {
  deps: ListenerDeps;
  client: ListenClient | null;
  /** Bumped at each connect and drop, so a late answer of an older client changes nothing. */
  generation: number;
  connected: boolean;
  retry: NodeJS.Timeout | null;
  check: NodeJS.Timeout | null;
  failing: boolean;
  lastLogAt: number | null;
}

let run: Run | null = null;

function timer(fn: () => void, ms: number): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = timer(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    work.then(value => { clearTimeout(t); resolve(value); }, error => { clearTimeout(t); reject(error); });
  });
}

function destroy(client: ListenClient): void {
  try {
    (client as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
  } catch {
    // The socket is gone already.
  }
}

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Starts the listener; it runs until stopSharedListener. */
export function startSharedListener(deps: ListenerDeps): void {
  if (run) return;
  const current: Run = { deps, client: null, generation: 0, connected: false, retry: null, check: null, failing: false, lastLogAt: null };
  run = current;
  deps.onDatabaseChanged?.(() => {
    if (run !== current) return;
    drop(current);
    connect(current);
  });
  connect(current);
}

/** C25: ends the client (destroyed when its end takes over 2 s) and opens no other. */
export function stopSharedListener(): void {
  const current = run;
  if (!current) return;
  run = null;
  if (current.retry) clearTimeout(current.retry);
  if (current.check) clearTimeout(current.check);
  current.retry = null;
  current.check = null;
  current.generation += 1;
  const client = current.client;
  current.client = null;
  if (!client) return;
  const cut = timer(() => destroy(client), END_BOUND_MS);
  client.end().then(() => clearTimeout(cut), () => { clearTimeout(cut); destroy(client); });
}

function drop(current: Run): void {
  current.generation += 1;
  current.connected = false;
  if (current.check) clearTimeout(current.check);
  if (current.retry) clearTimeout(current.retry);
  current.check = null;
  current.retry = null;
  const client = current.client;
  current.client = null;
  if (client) {
    destroy(client);
    client.end().catch(() => undefined);
  }
}

/** Row 36: the client is dropped, the cause logged (once, again every 10 minutes), and a connect follows in 5 s. */
function failed(current: Run, generation: number, error: unknown): void {
  if (run !== current || current.generation !== generation) return;
  drop(current);
  const now = Date.now();
  if (current.lastLogAt === null || now - current.lastLogAt >= LOG_AGAIN_MS) {
    current.lastLogAt = now;
    console.error(`[Shared] Can't listen for changes from other machines (${causeOf(error)}); this machine takes them at its check every 60 seconds until it can`);
  }
  current.failing = true;
  current.retry = timer(() => {
    current.retry = null;
    connect(current);
  }, RETRY_MS);
}

function connect(current: Run): void {
  if (run !== current) return;
  current.generation += 1;
  const generation = current.generation;
  const entry = current.deps.entry();
  if (entry === null) {
    current.retry = timer(() => { current.retry = null; connect(current); }, RETRY_MS);
    return;
  }
  let client: ListenClient;
  try {
    client = makeClient({
      ...pgConfig(entry),
      application_name: LISTEN_APPLICATION_NAME,
      connectionTimeoutMillis: CONNECT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    });
  } catch (error) {
    failed(current, generation, error);
    return;
  }
  current.client = client;
  client.on('error', error => failed(current, generation, error));
  client.on('end', () => failed(current, generation, new Error('the connection ended')));
  client.on('notification', msg => notified(current, generation, msg));
  void (async () => {
    try {
      await within(client.connect(), CONNECT_MS);
      for (const channel of channelsFor(client)) {
        if (run !== current || current.generation !== generation) return;
        await within(client.query(`LISTEN ${channel}`), CHECK_BOUND_MS);
      }
    } catch (error) {
      failed(current, generation, error);
      return;
    }
    if (run !== current || current.generation !== generation) return;
    current.connected = true;
    if (current.failing) {
      current.failing = false;
      current.lastLogAt = null;
      console.log('[Shared] Listening for changes from other machines again');
    }
    scheduleCheck(current, generation);
    current.deps.onConnected();
  })();
}

/** Decision 10: SELECT 1 every 30 s under a 5 s bound; a failed or late check drops the client. */
function scheduleCheck(current: Run, generation: number): void {
  current.check = timer(() => {
    current.check = null;
    const client = current.client;
    if (run !== current || current.generation !== generation || !client) return;
    within(client.query('SELECT 1'), CHECK_BOUND_MS).then(
      () => { if (run === current && current.generation === generation) scheduleCheck(current, generation); },
      error => failed(current, generation, error),
    );
  }, CHECK_EVERY_MS);
}

function notified(current: Run, generation: number, msg: { channel: string; payload?: string }): void {
  if (run !== current || current.generation !== generation) return;
  if (msg.channel === GUILD_REQUESTS_CHANNEL) {
    if (msg.payload === processId()) current.deps.onGuildRequest();
    return;
  }
  if (msg.channel !== SHARED_CHANNEL) return;
  let notice: { k?: unknown; key?: unknown; module?: unknown; by?: unknown };
  try {
    notice = JSON.parse(msg.payload ?? '');
  } catch {
    return;
  }
  if (!notice || typeof notice !== 'object' || notice.by === processId()) return;
  if (notice.k === 'doc' && typeof notice.key === 'string') current.deps.onDoc(notice.key);
  else if (notice.k === 'module' && typeof notice.module === 'string') current.deps.onModule?.(notice.module);
}
