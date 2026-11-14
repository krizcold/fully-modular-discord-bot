import type os from 'os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  acceptAddressList,
  classifyPoolClients,
  hookListInUse,
  parseAddressList,
  resetAddressesForTests,
  setupAddressesIpc,
  transportClassOf,
  transportOf,
} from '../../src/utils/databaseAddress';

type Interfaces = ReturnType<typeof os.networkInterfaces>;

const A = 'postgresql://bot:pw@db1:5432/bot';
const NO_VERIFY = { host: 'db1', ssl: { rejectUnauthorized: false } };
const NONE: Interfaces = {};
const peerClient = (remoteAddress: string) => ({ connection: { stream: { remoteAddress } } });

const v6Interfaces: Interfaces = {
  eth0: [{
    address: 'fd00:1::2', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:00:00:00:00:01',
    internal: false, cidr: 'fd00:1::2/64', scopeid: 0,
  }],
};

describe('the transport class of a connected client', () => {
  it('counts TLS to a peer inside an attached IPv6 subnet as local', () => {
    expect(transportOf(NO_VERIFY, peerClient('fd00:1::77'), v6Interfaces)).toBe('local');
    expect(transportOf(NO_VERIFY, peerClient('fd00:2::77'), v6Interfaces)).toBe('unprotected');
  });

  it('counts ssl set to true as verified', () => {
    expect(transportOf({ host: 'db1', ssl: true }, null, NONE)).toBe('verified');
  });

  it('counts an IPv4 loopback peer as local with no attached subnet', () => {
    expect(transportOf(NO_VERIFY, peerClient('127.0.0.1'), NONE)).toBe('local');
  });

  it('counts the IPv6 loopback peer as local with no attached subnet', () => {
    expect(transportOf(NO_VERIFY, peerClient('::1'), NONE)).toBe('local');
  });

  it('classes a pool client as unprotected when reading its socket throws', () => {
    let listener: ((client: any) => void) | null = null;
    classifyPoolClients({ on: (_event, l) => { listener = l; } }, NO_VERIFY);
    const client = { get connection(): never { throw new Error('socket gone'); } };
    expect(() => listener!(client)).not.toThrow();
    expect(transportClassOf(client)).toBe('unprotected');
  });
});

describe('the cause of an unusable list entry', () => {
  it('names an entry with another scheme as not starting with postgresql://', () => {
    const list = parseAddressList(`${A},mysql://u:pw@db2/x`);
    expect(list[1]).toMatchObject({ usable: false, cause: 'entry 2 does not start with postgresql:// or postgres://' });
  });

  it('names an entry the parser refuses as one that cannot be parsed', () => {
    const list = parseAddressList(`${A},postgresql://bot:pw@db2:99999/x`);
    expect(list[1]).toMatchObject({ usable: false, cause: 'entry 2 cannot be parsed as a database address' });
  });
});

describe('the list the addresses hook gave', () => {
  const realSend = process.send;
  const sent: any[] = [];
  process.send = ((m: any) => { sent.push(m); return true; }) as any;
  afterAll(() => { process.send = realSend; });
  afterEach(() => { resetAddressesForTests(); sent.length = 0; });

  const ask = (id: string, url: unknown, type = 'data:addresses') => {
    process.emit('message' as any, { type, data: { id, url } } as any);
    return sent.filter(m => m?.data?.id === id);
  };

  it('keeps an accepted list without its surrounding spaces', () => {
    acceptAddressList(`  ${A}  `);
    expect(hookListInUse()).toBe(A);
  });

  it('answers each message once when set up twice', () => {
    setupAddressesIpc();
    setupAddressesIpc();
    setupAddressesIpc();
    expect(ask('once', A)).toEqual([{ type: 'data:addresses-ack', data: { id: 'once', accepted: true } }]);
  });

  it('ignores a message of another type', () => {
    setupAddressesIpc();
    expect(ask('other', A, 'data:other')).toEqual([]);
    expect(hookListInUse()).toBeNull();
  });

  it('keeps a hook list without its surrounding spaces', () => {
    setupAddressesIpc();
    expect(ask('trim', `  ${A}  `)).toEqual([{ type: 'data:addresses-ack', data: { id: 'trim', accepted: true } }]);
    expect(hookListInUse()).toBe(A);
  });

  it.each([
    ['a number', 5],
    ['an empty string', ''],
    ['only spaces', '   '],
  ])('refuses %s as the url with the reason', (_name, url) => {
    setupAddressesIpc();
    expect(ask(`bad-${String(url)}`, url)).toEqual([
      { type: 'data:addresses-ack', data: { id: `bad-${String(url)}`, accepted: false, error: 'url must be a non-empty string' } },
    ]);
    expect(hookListInUse()).toBeNull();
  });
});
