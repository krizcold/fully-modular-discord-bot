import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAddressList, parseAddressList, showEntry } from '../../src/utils/databaseAddress';

// NB5 section 8 test 1 (decision 1) and decision 18's check: the list, its unusable entries and the display form.

const SECRET = 'S3cretPw';
const A = `postgresql://bot:${SECRET}@db1:5432/bot`;
const B = `postgres://bot:${SECRET}@10.0.0.5:6432/bot?sslmode=no-verify`;

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the address list', () => {
  it.each([
    ['one entry', A, [true]],
    ['two entries', `${A},${B}`, [true, true]],
    ['spaces around commas', ` ${A} ,  ${B} `, [true, true]],
    ['a trailing comma', `${A},`, [true, false]],
    ['an empty middle entry', `${A},,${B}`, [true, false, true]],
    ['a mysql entry', `${A},mysql://u:${SECRET}@db2/x`, [true, false]],
  ])('%s', (_name, value, usable) => {
    const list = parseAddressList(value);
    expect(list.map(e => e.usable)).toEqual(usable);
    for (const entry of list) expect(entry.shown).not.toContain(SECRET);
  });

  it('names an empty entry by its position', () => {
    const list = parseAddressList(`${A},,${B}`);
    expect(list[1]).toMatchObject({ usable: false, cause: 'entry 2 is empty' });
  });

  it('keeps a percent-encoded comma inside one entry and decodes it', () => {
    const list = parseAddressList(`postgresql://bot:a%2Cb@db1/bot,${B}`);
    expect(list).toHaveLength(2);
    expect(list[0].usable).toBe(true);
    if (list[0].usable) expect(list[0].config.password).toBe('a,b');
  });

  it('marks an entry whose sslrootcert file is missing, and takes it once the file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-cert-'));
    tmp.push(dir);
    const file = path.join(dir, 'ca.crt');
    const entry = `postgresql://bot:${SECRET}@10.0.0.7:5432/bot?sslmode=verify-full&sslrootcert=${file}`;
    const first = parseAddressList(entry)[0];
    expect(first.usable).toBe(false);
    if (!first.usable) expect(first.cause).toContain(file);
    fs.writeFileSync(file, 'not a real certificate');
    expect(parseAddressList(entry)[0].usable).toBe(true);
  });

  it('shows host, port and database only', () => {
    expect(showEntry(A)).toBe('db1:5432/bot');
    expect(showEntry('postgresql://u:p@[::1]/db')).toBe('::1:5432/db');
    expect(showEntry('', 3)).toBe('entry 3');
  });
});

describe('decision 18: the setting check', () => {
  it.each([
    [A, null],
    [`${A}, ${B}`, null],
    ['postgresql://a, mysql://b', 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://'],
    ['mysql://b', 'DATA_BACKEND_URL must start with postgresql:// or postgres://'],
    [`${A},`, 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://'],
  ])('%s', (value, error) => {
    expect(checkAddressList(value)).toBe(error);
  });
});
