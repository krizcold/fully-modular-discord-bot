import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { _setListenClientFactory, channelsFor, startSharedListener, stopSharedListener, type ListenerDeps } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';

// NB15 gatekeeper ruling 20 (NB6's 'unprotected' halves of rows 36, 37 and 100): a no-verify listening connection is
// classed by its socket's scripted peer against this process's interfaces. A peer outside every attached subnet
// LISTENs smdb_shared only and never asks for a request pass; one on an attached subnet LISTENs both channels.

const UNCHECKED = 'postgres://bot@smdb-pg:5432/bot?sslmode=no-verify';
const CANT = "[Shared] Can't listen for changes from other machines";
const iface = (cidr: string, internal = false) => ({ address: cidr.split('/')[0], netmask: '', family: 'IPv4', mac: '', internal, cidr }) as any;
const ATTACHED = { lo: [iface('127.0.0.1/8', true)], eth0: [iface('172.18.0.5/16')] };

let rig: ReturnType<typeof listenRig>;
let lines: string[];
let calls: { docs: string[]; connected: number; guild: number };
let changed: Array<() => void>;

const deps = (): ListenerDeps => ({
  entry: () => UNCHECKED,
  onDoc: key => { calls.docs.push(key); },
  onConnected: () => { calls.connected += 1; },
  onGuildRequest: () => { calls.guild += 1; },
  onDatabaseChanged: cb => { changed.push(cb); },
});
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(ATTACHED as any);
  rig = listenRig();
  calls = { docs: [], connected: 0, guild: 0 };
  changed = [];
  _setListenClientFactory(rig.factory as never);
});
afterEach(() => {
  stopSharedListener();
  _setListenClientFactory(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the shared listener classes by the scripted peer (ruling 20)', () => {
  it('a no-verify peer outside every attached subnet (100.64.0.1): smdb_shared only, shared changes applied, no request pass, no [Shared] line, onConnected runs', async () => {
    rig.peers.push('100.64.0.1');
    startSharedListener(deps());
    await settle();
    const client = rig.last();
    expect(client.connection.stream.remoteAddress).toBe('100.64.0.1');
    expect(client.queries).toEqual(['LISTEN smdb_shared']);
    expect(channelsFor(client as never)).toEqual(['smdb_shared']);
    expect(calls.connected).toBe(1);
    client.notify('smdb_shared', JSON.stringify({ k: 'doc', key: 'g/1/m/a.json', by: 'another' }));
    expect(calls.docs).toEqual(['g/1/m/a.json']);
    client.notify('smdb_guild_requests', processId());
    expect(calls.guild).toBe(0);
    expect(lines.some(l => l.startsWith(CANT))).toBe(false);
  });

  it('a no-verify peer on an attached subnet (172.18.0.9): both channels', async () => {
    rig.peers.push('172.18.0.9');
    startSharedListener(deps());
    await settle();
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
    rig.last().notify('smdb_guild_requests', processId());
    expect(calls.guild).toBe(1);
  });

  it('a reconnect to a peer that moved outside the subnets classes again: smdb_shared only', async () => {
    rig.peers.push('172.18.0.9', '100.64.0.1');
    startSharedListener(deps());
    await settle();
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
    changed.forEach(cb => cb());
    await settle();
    expect(rig.clients).toHaveLength(2);
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared']);
  });
});
