import { describe, expect, it } from 'vitest';

import { pgConfigCause } from '../../src/utils/databaseAddress';

// Why a DATA_BACKEND_URL entry was refused, as the operator reads it.

const enoent = (file: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT', errno: -2, path: file });

describe('pgConfigCause', () => {
  it('names the client certificate file that cannot be read', () => {
    expect(pgConfigCause('postgresql://bot@db.example/bot?sslcert=/certs/client.pem', enoent('/certs/client.pem')))
      .toBe('its client certificate file /certs/client.pem cannot be read (ENOENT)');
  });

  it('names the file when the entry has spaces around it', () => {
    expect(pgConfigCause('  postgresql://bot@db.example/bot?sslrootcert=/certs/ca.pem  ', enoent('/certs/ca.pem')))
      .toBe('its certificate file /certs/ca.pem cannot be read (ENOENT)');
  });

  it('says the entry cannot be parsed for an error with no code, also when the entry names a certificate file', () => {
    expect(pgConfigCause('postgresql://bot@db.example/bot?sslrootcert=/certs/ca.pem', new Error('Invalid URL')))
      .toBe('it cannot be parsed as a database address');
  });

  it('says the entry cannot be parsed when it names no file, whatever the error says', () => {
    expect(pgConfigCause('postgresql://bot@db.example/bot', enoent('/certs/other.pem')))
      .toBe('it cannot be parsed as a database address');
    expect(pgConfigCause('postgresql://bot@db.example/bot', { code: 'ENOENT' }))
      .toBe('it cannot be parsed as a database address');
  });
});
