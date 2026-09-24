// Whether the other nodes can dial this one as master (B7-F18). Read by the
// promote's confirm and the stand-in arm lane's warning.

import { promises as dns } from 'dns';
import * as os from 'os';
import { normalizeUrl } from './nodeIdentity';

export type Reachability =
  | { verdict: 'listed' }
  | { verdict: 'unlisted' }
  | { verdict: 'unknown'; why: string };

export interface ReachabilityDeps {
  lookup: (host: string) => Promise<string[]>;
  ownAddresses: () => string[];
}

const LOOKUP_TIMEOUT_MS = 3000;

const defaultDeps: ReachabilityDeps = {
  lookup: host => Promise.race([
    dns.lookup(host, { all: true }).then(rows => rows.map(row => row.address)),
    new Promise<string[]>((_, reject) => { setTimeout(() => reject(new Error('timed out')), LOOKUP_TIMEOUT_MS).unref?.(); }),
  ]),
  ownAddresses: () => Object.values(os.networkInterfaces()).flatMap(list => (list ?? []).map(entry => entry.address)),
};

/**
 * The advertised URL is compared as dialing compares. A same-server fleet
 * dials container names instead, which only this node's own addresses can
 * recognise, so an entry on this node's control port is resolved and matched
 * against them; one that cannot be resolved leaves the verdict unknown.
 */
export async function judgeReachability(
  publicUrl: string,
  candidates: string[],
  controlPort: number,
  deps: ReachabilityDeps = defaultDeps,
): Promise<Reachability> {
  const mine = normalizeUrl(publicUrl.trim());
  if (mine !== '' && candidates.some(url => normalizeUrl(url.trim()) === mine)) return { verdict: 'listed' };
  const hosts: string[] = [];
  for (const url of candidates) {
    try {
      const parsed = new URL(url.trim());
      if (parsed.hostname !== '' && Number(parsed.port) === controlPort) hosts.push(parsed.hostname);
    } catch {
      // not a URL: nothing any node could dial
    }
  }
  // In parallel, so the wait is one lookup timeout at most.
  const answers = await Promise.all(hosts.map(host => Promise.resolve()
    .then(() => deps.lookup(host))
    .then(addresses => ({ host, addresses }), () => ({ host, addresses: null as string[] | null }))));
  const unresolved: string[] = [];
  let own: Set<string> | null = null;
  for (const { host, addresses } of answers) {
    if (addresses === null) {
      unresolved.push(host);
      continue;
    }
    own ??= new Set(deps.ownAddresses());
    if (addresses.some(address => own!.has(address))) return { verdict: 'listed' };
  }
  if (unresolved.length > 0) return { verdict: 'unknown', why: `${unresolved.join(', ')} on this node's control port could not be resolved` };
  if (mine === '') return { verdict: 'unknown', why: 'this node advertises no FLEET_PUBLIC_URL' };
  return { verdict: 'unlisted' };
}
