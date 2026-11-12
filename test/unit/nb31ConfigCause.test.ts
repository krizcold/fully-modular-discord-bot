import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseAddressList, pgConfig, pgConfigCause } from '../../src/utils/databaseAddress';

const readable = __filename.replace(/\\/g, '/');
const missing = path.join(path.dirname(__filename), 'nb31-no-such.key').replace(/\\/g, '/');
const entry = `postgresql://bot@db:5432/bot?sslmode=verify-full&sslrootcert=${readable}&sslkey=${missing}`;

const thrown = (raw: string): unknown => {
  try {
    pgConfig(raw);
  } catch (error) {
    return error;
  }
  throw new Error('pgConfig did not throw');
};

describe('NB31: an entry whose key file cannot be read', () => {
  it('names the key file, not the readable root certificate', () => {
    expect(pgConfigCause(entry, thrown(entry))).toBe(`its key file ${missing} cannot be read (ENOENT)`);
  });

  it('the address list names the same file', () => {
    const [listed] = parseAddressList(entry);
    expect(listed.usable).toBe(false);
    expect(listed.usable ? '' : listed.cause).toContain(missing);
  });

  it('an error with no path names a file only when the entry names exactly one', () => {
    const noPath = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
    expect(pgConfigCause(entry, noPath)).toBe('a file it names cannot be read (EISDIR)');
    const one = `postgresql://bot@db:5432/bot?sslmode=verify-full&sslrootcert=${missing}`;
    expect(pgConfigCause(one, noPath)).toBe(`its certificate file ${missing} cannot be read (EISDIR)`);
    const empty = `postgresql://bot@db:5432/bot?sslmode=verify-full&sslrootcert=&sslkey=${missing}`;
    expect(pgConfigCause(empty, noPath)).toBe(`its key file ${missing} cannot be read (EISDIR)`);
  });

  it('a path the entry does not name is given as the error gives it', () => {
    const other = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: 'C:/elsewhere/x.pem' });
    expect(pgConfigCause(entry, other)).toBe('the file C:/elsewhere/x.pem it names cannot be read (ENOENT)');
  });

  it('a missing root certificate is still named as the certificate file', () => {
    const bad = `postgresql://bot@db:5432/bot?sslmode=verify-full&sslrootcert=${missing}`;
    expect(pgConfigCause(bad, thrown(bad))).toBe(`its certificate file ${missing} cannot be read (ENOENT)`);
  });
});
