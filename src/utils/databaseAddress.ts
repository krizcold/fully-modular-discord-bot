import net from 'net';
import os from 'os';
import type { ClientConfig } from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';
import { loadCredentials } from './envLoader';

/** host lowercased, port 5432 when absent, the database name without a trailing slash. */
export interface DatabaseAddress {
  host: string;
  port: number;
  database: string;
}

export type ListEntry =
  | { index: number; raw: string; usable: true; config: ClientConfig; shown: string }
  | { index: number; raw: string; usable: false; cause: string; shown: string };

const PREFIX = /^postgres(ql)?:\/\//;

/** No user, password or parameters. Throws when the entry is no URL. */
export function normalizeAddress(url: string): DatabaseAddress {
  const parsed = new URL(url);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase(),
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')),
  };
}

export function showAddress(a: DatabaseAddress | null | undefined): string {
  return a ? `${a.host}:${a.port}/${a.database}` : 'an unknown address';
}

/** The display form of one raw entry; `entry <n>` when it is no URL. */
export function showEntry(raw: string, index = 1): string {
  try {
    return showAddress(normalizeAddress(raw.trim()));
  } catch {
    return `entry ${index}`;
  }
}

/**
 * The connection fields of one entry, parsed by node-postgres's own parser at each call. A `verify-full` entry whose
 * host is an IP address gets that address as `ssl.host`, since pg sets the TLS server name only for a DNS host.
 * Throws when the entry cannot be parsed or its `sslrootcert` file cannot be read.
 */
export function pgConfig(entry: string): ClientConfig {
  const raw = entry.trim();
  if (!PREFIX.test(raw)) throw new Error('the address does not start with postgresql:// or postgres://');
  const config = parseIntoClientConfig(raw) as ClientConfig & { host?: string };
  if (typeof config.host === 'string') {
    const host = config.host.replace(/^\[(.*)\]$/, '$1');
    config.host = host;
    if (net.isIP(host) && config.ssl && typeof config.ssl === 'object' && config.ssl.rejectUnauthorized !== false) {
      config.ssl = { ...config.ssl, host } as ClientConfig['ssl'];
    }
  }
  return config;
}

/**
 * NB15 decision 21: how a connection that has connected is protected. 'verified': TLS with the server's certificate
 * checked. 'local': a loopback host or a Unix socket, or TLS to a peer inside a subnet of one of this process's own
 * interfaces (the machine's Docker network, inside a container). 'unprotected': every other connection.
 */
export type TransportClass = 'verified' | 'local' | 'unprotected';

type Interfaces = ReturnType<typeof os.networkInterfaces>;

const LOOPBACK_V4 = /^127\./;

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h) || h.startsWith('/');
}

function plainAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function inAttachedSubnet(peer: string, interfaces: Interfaces): boolean {
  const family = net.isIP(peer);
  if (family === 0) return false;
  const list = new net.BlockList();
  let any = false;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.cidr) continue;
      const [address, prefix] = entry.cidr.split('/');
      const type = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
      try {
        list.addSubnet(address, Number(prefix), type);
        any = true;
      } catch { /* an address the list cannot hold is no subnet */ }
    }
  }
  return any && list.check(peer, family === 6 ? 'ipv6' : 'ipv4');
}

/** Classes one connected client from its parsed config and its socket's peer; no name lookup runs. */
export function transportOf(config: ClientConfig, client: unknown, interfaces: Interfaces = os.networkInterfaces()): TransportClass {
  const ssl = config.ssl;
  // node-postgres takes an empty host as unset: PGHOST, else localhost.
  const host = typeof config.host === 'string' && config.host !== '' ? config.host : process.env.PGHOST || 'localhost';
  if (ssl && (ssl === true || (typeof ssl === 'object' && ssl.rejectUnauthorized !== false))) return 'verified';
  if (isLoopbackHost(host)) return 'local';
  if (!ssl) return 'unprotected';
  const remote = (client as { connection?: { stream?: { remoteAddress?: unknown } } } | null)?.connection?.stream?.remoteAddress;
  if (typeof remote !== 'string') return 'unprotected';
  const peer = plainAddress(remote);
  if (LOOPBACK_V4.test(peer) || peer === '::1') return 'local';
  return inAttachedSubnet(peer, interfaces) ? 'local' : 'unprotected';
}

const classes = new WeakMap<object, TransportClass>();

/** The class kept on a client at its connect; none for a client nobody classed. */
export function transportClassOf(client: object): TransportClass | undefined {
  return classes.get(client);
}

export function keepTransportClass(client: object, cls: TransportClass): void {
  classes.set(client, cls);
}

/** Classes every new client of a pool at its connect, before the pool hands it out; the class ends with the client. */
export function classifyPoolClients(pool: { on(event: 'connect', listener: (client: any) => void): unknown }, config: ClientConfig): void {
  pool.on('connect', client => {
    try {
      classes.set(client, transportOf(config, client));
    } catch {
      classes.set(client, 'unprotected');
    }
  });
}

function certificatePath(raw: string): string | null {
  try {
    return new URL(raw).searchParams.get('sslrootcert');
  } catch {
    return null;
  }
}

/** DATA_BACKEND_URL split on commas; each entry is parsed again at every call, so a file that appears later counts. */
export function parseAddressList(value: string): ListEntry[] {
  return value.split(',').map((part, i): ListEntry => {
    const index = i + 1;
    const raw = part.trim();
    const shown = showEntry(raw, index);
    if (raw === '') return { index, raw, usable: false, cause: `entry ${index} is empty`, shown };
    if (!PREFIX.test(raw)) {
      return { index, raw, usable: false, cause: `entry ${index} does not start with postgresql:// or postgres://`, shown };
    }
    try {
      return { index, raw, usable: true, config: pgConfig(raw), shown };
    } catch (error) {
      const file = certificatePath(raw);
      const code = (error as { code?: unknown })?.code;
      if (file && typeof code === 'string') {
        return { index, raw, usable: false, cause: `its certificate file ${file} cannot be read (${code})`, shown };
      }
      return { index, raw, usable: false, cause: `entry ${index} cannot be parsed as a database address`, shown };
    }
  });
}

/** Decision 18's check of a DATA_BACKEND_URL value: an error text naming the first bad entry, or null. */
export function checkAddressList(value: string): string | null {
  const entries = value.split(',').map(part => part.trim());
  for (let i = 0; i < entries.length; i++) {
    if (!PREFIX.test(entries[i])) {
      return entries.length === 1
        ? 'DATA_BACKEND_URL must start with postgresql:// or postgres://'
        : `entry ${i + 1} of DATA_BACKEND_URL must start with postgresql:// or postgres://`;
    }
  }
  return null;
}

let acceptedList: string | null = null;
let ipcInstalled = false;

/** The list the addresses hook gave this process, else DATA_BACKEND_URL as it reads now. */
export function addressListInUse(): string {
  return acceptedList ?? (loadCredentials().DATA_BACKEND_URL || '').trim();
}

/** The web UI process takes a list the addresses hook gave and its bot process accepted (decision 22). */
export function acceptAddressList(list: string): void {
  acceptedList = list.trim();
}

/** The list the hook gave this process, null before one; the web UI forks its bot process with it. */
export function hookListInUse(): string | null {
  return acceptedList;
}

/** The bot process's listener for `data:addresses`; it keeps an accepted list for the process's life and acks. */
export function setupAddressesIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  process.on('message', (message: unknown) => {
    const m = message as { type?: unknown; data?: { id?: unknown; url?: unknown } } | null;
    if (!m || m.type !== 'data:addresses') return;
    const id = m.data?.id;
    const url = typeof m.data?.url === 'string' ? m.data.url.trim() : '';
    const error = url === '' ? 'url must be a non-empty string' : checkAddressList(url);
    if (error === null) acceptedList = url;
    process.send?.({ type: 'data:addresses-ack', data: error === null ? { id, accepted: true } : { id, accepted: false, error } });
  });
}

/** Tests only. */
export function resetAddressesForTests(): void {
  acceptedList = null;
}
