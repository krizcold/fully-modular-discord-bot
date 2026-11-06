import net from 'net';
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
