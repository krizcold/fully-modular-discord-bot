import fs from 'fs';
import path from 'path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pgConfig } from '../../src/utils/databaseAddress';
import { POSTGRES_IMAGE } from '../helpers/postgres';

// NB5 section 8 [pg] test 4 (decision 2, invariant 6): a server with ssl=on and a checked-in certificate whose
// subjectAltName is IP:127.0.0.1 (test/fixtures/nb5-tls: the CA, that certificate and key, and one for 10.9.9.9; all
// valid until 2126). pgConfig of a verify-full entry with an IP host checks the certificate against that IP.

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'nb5-tls');
const CA = path.join(FIXTURES, 'ca.crt');

async function tlsServer(cert: 'server' | 'other'): Promise<StartedPostgreSqlContainer> {
  const script = [
    `cp /tls/${cert}.crt /var/lib/postgresql/tls.crt`,
    `cp /tls/${cert}.key /var/lib/postgresql/tls.key`,
    'chown postgres:postgres /var/lib/postgresql/tls.crt /var/lib/postgresql/tls.key',
    'chmod 600 /var/lib/postgresql/tls.key',
    'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/tls.crt -c ssl_key_file=/var/lib/postgresql/tls.key',
  ].join(' && ');
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCopyFilesToContainer([
      { source: path.join(FIXTURES, `${cert}.crt`), target: `/tls/${cert}.crt` },
      { source: path.join(FIXTURES, `${cert}.key`), target: `/tls/${cert}.key` },
    ])
    .withEntrypoint(['sh', '-c'])
    .withCommand([script])
    .start();
}

function verifyFullEntry(c: StartedPostgreSqlContainer): string {
  const user = encodeURIComponent(c.getUsername());
  const password = encodeURIComponent(c.getPassword());
  return `postgresql://${user}:${password}@127.0.0.1:${c.getPort()}/${c.getDatabase()}?sslmode=verify-full&sslrootcert=${encodeURIComponent(CA)}`;
}

async function connects(config: ConstructorParameters<typeof Client>[0]): Promise<true | Error> {
  const client = new Client(config);
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    return error as Error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

let server: StartedPostgreSqlContainer;
let other: StartedPostgreSqlContainer;

beforeAll(async () => {
  expect(fs.existsSync(CA)).toBe(true);
  [server, other] = await Promise.all([tlsServer('server'), tlsServer('other')]);
}, 240_000);
afterAll(async () => {
  await Promise.all([server?.stop(), other?.stop()]);
});

describe('verify-full to an IP host', () => {
  it('pgConfig of the entry connects, its ssl.host the IP', async () => {
    const config = pgConfig(verifyFullEntry(server));
    expect((config.ssl as { host?: string }).host).toBe('127.0.0.1');
    expect(await connects(config)).toBe(true);
  });

  it('the same string as connectionString fails with a hostname mismatch (pg leaves servername unset for an IP)', async () => {
    const result = await connects({ connectionString: verifyFullEntry(server) });
    expect(result).toBeInstanceOf(Error);
    expect(`${(result as any).code ?? ''} ${(result as Error).message}`).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match|altnames/i);
  });

  it("a certificate for another IP fails with pgConfig too", async () => {
    const result = await connects(pgConfig(verifyFullEntry(other)));
    expect(result).toBeInstanceOf(Error);
    expect(`${(result as any).code ?? ''} ${(result as Error).message}`).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match|altnames/i);
  });
});
