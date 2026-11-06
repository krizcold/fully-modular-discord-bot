import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { pgConfig } from '../../src/utils/databaseAddress';

// NB5 section 8 test 2 (decision 2): pgConfig sets the TLS host for an IP address.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-pgconfig-'));
const ca = path.join(dir, 'ca.crt');
fs.writeFileSync(ca, 'CA-BYTES');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('pgConfig', () => {
  it('gives an IPv4 host with verify-full its address as ssl.host and the CA from the file', () => {
    const config = pgConfig(`postgresql://u:p@10.0.0.5:5432/bot?sslmode=verify-full&sslrootcert=${ca}`);
    expect(config.host).toBe('10.0.0.5');
    expect(config.ssl).toMatchObject({ host: '10.0.0.5', ca: 'CA-BYTES' });
  });

  it('strips the brackets of an IPv6 host in host and ssl.host', () => {
    const config = pgConfig(`postgresql://u:p@[::1]:5432/bot?sslmode=verify-full&sslrootcert=${ca}`);
    expect(config.host).toBe('::1');
    expect(config.ssl).toMatchObject({ host: '::1' });
  });

  it('gives a DNS host no ssl.host', () => {
    const config = pgConfig(`postgresql://u:p@db.example:5432/bot?sslmode=verify-full&sslrootcert=${ca}`);
    expect((config.ssl as { host?: string }).host).toBeUndefined();
  });

  it('keeps no-verify as rejectUnauthorized false with no ssl.host', () => {
    const config = pgConfig('postgresql://u:p@10.0.0.5/bot?sslmode=no-verify');
    expect(config.ssl).toMatchObject({ rejectUnauthorized: false });
    expect((config.ssl as { host?: string }).host).toBeUndefined();
  });

  it('leaves ssl unset with no sslmode', () => {
    expect(pgConfig('postgresql://u:p@10.0.0.5/bot').ssl).toBeUndefined();
  });

  it("lets a URL application_name win over the caller's when spread last", () => {
    const merged = { application_name: 'smdb-probe', ...pgConfig('postgresql://u:p@db/bot?application_name=mine') };
    expect(merged.application_name).toBe('mine');
  });
});
