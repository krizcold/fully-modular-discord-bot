import { describe, expect, it } from 'vitest';
import { checkAddressList, pgConfig, transportOf } from '../../src/utils/databaseAddress';

const NO_INTERFACES = {};
const SUBNET_10 = {
  eth0: [{ address: '10.0.0.2', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '10.0.0.2/8' }],
} as unknown as ReturnType<typeof import('os').networkInterfaces>;

const insecureTls = { ssl: { rejectUnauthorized: false } };
const peer = (remoteAddress: string) => ({ connection: { stream: { remoteAddress } } });

describe('the scheme check of a database address', () => {
  it('refuses an entry that only contains postgresql:// after other text', () => {
    expect(checkAddressList('xpostgresql://bot@db/bot')).toBe('DATA_BACKEND_URL must start with postgresql:// or postgres://');
    expect(checkAddressList('postgresql://bot@db/bot')).toBeNull();
  });

  it('parses an entry framed by spaces', () => {
    const config = pgConfig('  postgresql://bot@db.example:6432/bot  ');
    expect(config.host).toBe('db.example');
    expect(config.port).toBe(6432);
    expect(config.database).toBe('bot');
  });

  it('refuses another scheme with a message naming the two accepted prefixes', () => {
    expect(() => pgConfig('mysql://bot@db/bot')).toThrow(/^the address does not start with postgresql:\/\/ or postgres:\/\/$/);
  });
});

describe('the host pgConfig hands to node-postgres', () => {
  it('strips brackets only when they frame the whole host', () => {
    expect(pgConfig('postgresql://bot@[::1]:5432/bot').host).toBe('::1');
    expect(pgConfig('postgresql://bot@db/bot?host=ab[cd]').host).toBe('ab[cd]');
    expect(pgConfig('postgresql://bot@db/bot?host=[ab]cd').host).toBe('[ab]cd');
  });
});

describe('the transport class of a connection without TLS', () => {
  it('classes the IPv6 loopback as local, bare or in brackets', () => {
    expect(transportOf({ host: '::1' }, null, NO_INTERFACES)).toBe('local');
    expect(transportOf({ host: '[::1]' }, null, NO_INTERFACES)).toBe('local');
  });

  it('classes a host that only contains 127. as unprotected', () => {
    expect(transportOf({ host: '10.127.0.1' }, null, NO_INTERFACES)).toBe('unprotected');
  });

  it('classes a host with brackets that do not frame it whole as unprotected', () => {
    expect(transportOf({ host: 'local[host]' }, null, NO_INTERFACES)).toBe('unprotected');
    expect(transportOf({ host: '[127.0.0.1]x' }, null, NO_INTERFACES)).toBe('unprotected');
  });
});

describe('the transport class of TLS without certificate checks, by its peer', () => {
  it('classes an IPv4-mapped loopback peer with multi-digit parts as local', () => {
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('::ffff:127.10.10.10'), NO_INTERFACES)).toBe('local');
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('::FFFF:127.0.0.1'), NO_INTERFACES)).toBe('local');
  });

  it('reads a mapped address only when it is the whole peer', () => {
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('1::ffff:127.0.0.1'), NO_INTERFACES)).toBe('unprotected');
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('::ffff:127.0.0.1x'), NO_INTERFACES)).toBe('unprotected');
  });

  it('classes a peer that is no IP address as unprotected, even with an attached subnet', () => {
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('not-an-ip'), SUBNET_10)).toBe('unprotected');
    expect(transportOf({ host: 'db.example', ...insecureTls }, peer('10.0.0.5'), SUBNET_10)).toBe('local');
  });
});
