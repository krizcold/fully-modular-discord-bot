import fs from 'fs';
import * as dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as envLoader from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

// NB6F: the writer of /data/.env (design.md D5 as V1, W1 to W3, X1, Y1, Y2, Z1 and Z3 leave it) on made-up text.
// Values are compared, never printed.

const ENV = dataPath('.env');
const K = 'STRIPE_SECRET_KEY';
const K2 = 'STRIPE_WEBHOOK_SECRET';
const T5 = (key: string) => `The value of ${key} cannot be written to ${ENV} so that it reads back the same; change ${key} in the premium tab, then run the migration again`;
const T5b = (keys: string, other: string) => `Writing ${keys} would change the value of ${other} in ${ENV}; edit that line of ${ENV}, then run the migration again`;
const T11b = `${ENV} is not valid UTF-8, so the migration cannot write DATA_BACKEND to it without changing other bytes; save it as UTF-8, then run the migration again`;

type Writer = (text: string, changes: Record<string, string | null>, unread?: Record<string, string>) => string;
const envKeysText: Writer = (...args) => (envLoader as unknown as { envKeysText: Writer }).envKeysText(...args);
const writeEnvKeys = (changes: Record<string, string | null>, unread: Record<string, string>, kept: string | null) =>
  (envLoader as unknown as { writeEnvKeys: (c: typeof changes, u: typeof unread, k: string | null) => void }).writeEnvKeys(changes, unread, kept);

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let before: Buffer | null;
beforeEach(() => {
  before = fs.existsSync(ENV) ? fs.readFileSync(ENV) : null;
  fs.rmSync(ENV, { force: true });
});
afterEach(() => {
  fs.rmSync(ENV, { force: true });
  if (before) fs.writeFileSync(ENV, before);
});

describe('envKeysText keeps every byte outside the changed spans', () => {
  it('comments, export lines, a CRLF line and a quoted multi-line value of another key stay; the key is set', () => {
    const text = '# head\nexport A=1\r\nM="one\ntwo"\nSTRIPE_SECRET_KEY=old\n# tail\n';
    expect(envKeysText(text, { [K]: 'new' })).toBe('# head\nexport A=1\r\nM="one\ntwo"\nSTRIPE_SECRET_KEY=new\n# tail\n');
  });

  it('an export line of the key is replaced whole', () => {
    expect(envKeysText('A=1\nexport STRIPE_SECRET_KEY=old\n', { [K]: 'new' })).toBe('A=1\nSTRIPE_SECRET_KEY=new\n');
  });

  it('a blank line and a comment line after the key stay byte for byte', () => {
    expect(envKeysText('STRIPE_SECRET_KEY=old\n\n# note\nB=2\n', { [K]: 'new' })).toBe('STRIPE_SECRET_KEY=new\n\n# note\nB=2\n');
    expect(envKeysText('STRIPE_SECRET_KEY=old\n\n# note\nB=2\n', { [K]: null })).toBe('\n# note\nB=2\n');
  });

  it('an inline comment on the key line goes with the span', () => {
    expect(envKeysText('STRIPE_SECRET_KEY=old # was set\nB=2\n', { [K]: 'new' })).toBe('STRIPE_SECRET_KEY=new\nB=2\n');
  });

  it('CRLF line ends of the other lines stay; a dropped span takes its own CRLF; an appended line ends in LF', () => {
    expect(envKeysText('A=1\r\nSTRIPE_SECRET_KEY=old\r\nB=2\r\n', { [K]: 'new' })).toBe('A=1\r\nSTRIPE_SECRET_KEY=new\r\nB=2\r\n');
    expect(envKeysText('A=1\r\nSTRIPE_SECRET_KEY=old\r\nB=2\r\n', { [K]: null })).toBe('A=1\r\nB=2\r\n');
    expect(envKeysText('A=1\r\n', { [K]: 'new' })).toBe('A=1\r\nSTRIPE_SECRET_KEY=new\n');
  });

  it('a lone CR line end maps one to one', () => {
    expect(envKeysText('A=1\rSTRIPE_SECRET_KEY=old\rB=2\r', { [K]: null })).toBe('A=1\rB=2\r');
  });

  it('a file with no line end at its end gains one before an appended line, and no other byte (Z3)', () => {
    expect(envKeysText('A=1', { [K]: 'new' })).toBe('A=1\nSTRIPE_SECRET_KEY=new\n');
    expect(envKeysText('STRIPE_SECRET_KEY=old\nX:', { [K]: 'new' })).toBe('STRIPE_SECRET_KEY=new\nX:');
    expect(dotenv.parse('STRIPE_SECRET_KEY=new\nX:').X).toBeUndefined();
  });

  it('the same key twice: the last is replaced and the earlier dropped; a null key drops every line', () => {
    expect(envKeysText('STRIPE_SECRET_KEY=a\nB=2\nSTRIPE_SECRET_KEY=b\n', { [K]: 'new' })).toBe('B=2\nSTRIPE_SECRET_KEY=new\n');
    expect(envKeysText('STRIPE_SECRET_KEY=a\nB=2\nSTRIPE_SECRET_KEY=b\n', { [K]: null })).toBe('B=2\n');
  });

  it('a missing key is appended; an empty text gains the line alone', () => {
    expect(envKeysText('A=1\n', { [K]: 'new' })).toBe('A=1\nSTRIPE_SECRET_KEY=new\n');
    expect(envKeysText('', { [K]: 'new' })).toBe('STRIPE_SECRET_KEY=new\n');
  });

  it('a value that needs quotes takes the first form that reads back', () => {
    for (const value of ['a #b', ' lead', '"q"']) {
      const out = envKeysText('STRIPE_SECRET_KEY=old\n', { [K]: value });
      expect(dotenv.parse(out)[K] === value, JSON.stringify(out.length)).toBe(true);
    }
    expect(envKeysText('STRIPE_SECRET_KEY=old\n', { [K]: '"q"' })).toBe(`STRIPE_SECRET_KEY='"q"'\n`);
  });
});

describe('V1: the spans dotenv itself reads', () => {
  it("a key line inside another key's value is no match: OTHER keeps its value and the key is appended", () => {
    const out = envKeysText('OTHER:\nSTRIPE_SECRET_KEY=old\n', { [K]: 'new' });
    expect(dotenv.parse(out)).toEqual({ OTHER: 'STRIPE_SECRET_KEY=old', [K]: 'new' });
  });

  it('a quoted two-line value of the key is replaced and dropped whole, with no tail left', () => {
    const text = 'STRIPE_SECRET_KEY="first\nsecond"\nB=2\n';
    expect(envKeysText(text, { [K]: 'new' })).toBe('STRIPE_SECRET_KEY=new\nB=2\n');
    expect(envKeysText(text, { [K]: null })).toBe('B=2\n');
    expect(envKeysText('STRIPE_SECRET_KEY=`first\nsecond`\nB=2\n', { [K]: null })).toBe('B=2\n');
  });

  it('a `KEY: old` line is replaced', () => {
    expect(envKeysText('A=1\nSTRIPE_SECRET_KEY: old\n', { [K]: 'new' })).toBe('A=1\nSTRIPE_SECRET_KEY=new\n');
  });

  it('W4: a `KEY:` line at the end of a line and the value line it takes are dropped, cleared or unread', () => {
    expect(envKeysText('STRIPE_SECRET_KEY:\nold\nB=2\n', { [K]: null })).toBe('B=2\n');
    expect(envKeysText('STRIPE_SECRET_KEY:\nold\nB=2\n', { [K]: null }, { [K]: 'stripe' })).toBe('B=2\n');
  });

  it('an empty value that reads the next quoted line: the span covers that line', () => {
    expect(envKeysText("A=1\nSTRIPE_SECRET_KEY=\n'x'\nB=2\n", { [K]: null })).toBe('A=1\nB=2\n');
  });
});

describe('W1: a BOM stays', () => {
  it('a BOM file whose first line is the key, set, then dropped, keeps its first 3 bytes', () => {
    const text = '\uFEFFSTRIPE_SECRET_KEY=old\nA=1\n';
    const set = envKeysText(text, { [K]: 'new' });
    expect(Buffer.from(set, 'utf8').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(set).toBe('\uFEFFSTRIPE_SECRET_KEY=new\nA=1\n');
    expect(envKeysText(set, { [K]: null })).toBe('\uFEFFA=1\n');
  });

  it('a file holding only a BOM gains a line break and the line', () => {
    expect(envKeysText('\uFEFF', { [K]: 'new' })).toBe('\uFEFF\nSTRIPE_SECRET_KEY=new\n');
  });
});

describe('W2, X1, Y1, Y2, Z1: the forms and the one check', () => {
  it('a file ending `OTHER:\\n` gains the key after an empty line, and OTHER reads empty as before', () => {
    const out = envKeysText('A=1\nOTHER:\n', { [K]: 'new' });
    expect(out).toBe('A=1\nOTHER:\n\nSTRIPE_SECRET_KEY=new\n');
    expect(dotenv.parse(out)).toEqual({ A: '1', OTHER: '', [K]: 'new' });
  });

  it('a file ending `X:` with no line end refuses with T5b naming X', () => {
    expect(thrown(() => envKeysText('A=1\nX:', { [K]: 'new' }))).toBe(T5b(K, 'X'));
  });

  it('an unterminated quote above the key: the form \'pq"\' is written (W3)', () => {
    const out = envKeysText('X="abc\nSTRIPE_SECRET_KEY=old\n', { [K]: 'pq"' });
    expect(out).toBe(`X="abc\nSTRIPE_SECRET_KEY='pq"'\n`);
    expect(dotenv.parse(out)).toEqual({ X: '"abc', [K]: 'pq"' });
  });

  it("an empty value above the key's line keeps reading empty when the key is replaced", () => {
    const out = envKeysText("A=\nSTRIPE_SECRET_KEY=old\n'x'\n", { [K]: 'new' });
    expect(dotenv.parse(out)).toEqual({ A: '', [K]: 'new' });
  });

  it('two set keys that both have a line are both written', () => {
    const out = envKeysText('STRIPE_SECRET_KEY=a\nSTRIPE_WEBHOOK_SECRET=b\nC=3\n', { [K]: 'x', [K2]: 'y' });
    expect(out).toBe('STRIPE_SECRET_KEY=x\nSTRIPE_WEBHOOK_SECRET=y\nC=3\n');
  });

  it('Y2: K1 set to " lead" and K2 to "new" over an empty value and a quoted line read right', () => {
    const out = envKeysText("K1=old\nA=\nK2=old\n'x'\n", { K1: ' lead', K2: 'new' });
    expect(dotenv.parse(out)).toEqual({ K1: ' lead', A: '', K2: 'new' });
  });

  it('Y1: a value no form reads back: T5 names the key and no new key is written', () => {
    expect(thrown(() => envKeysText('A=1\nSTRIPE_SECRET_KEY=old\n', { [K]: 'x\rB=1' }))).toBe(T5(K));
  });

  it('Z1: T5 names only the key whose value cannot be written', () => {
    expect(thrown(() => envKeysText('A=1\nK1=old\nK2=old\n', { K1: '"abc', K2: 'y\rz"' }))).toBe(T5('K2'));
  });

  it('T5 for DATA_BACKEND sends the operator to its lines', () => {
    expect(thrown(() => envKeysText('DATA_BACKEND=file\n', { DATA_BACKEND: 'x\rB=1' })))
      .toBe(`The value of DATA_BACKEND cannot be written to ${ENV} so that it reads back the same; edit the DATA_BACKEND lines of ${ENV}, then run the migration again`);
  });
});

describe('writeEnvKeys and writeEnvDataBackend', () => {
  it('writeEnvKeys writes the keys and reads them back; a new file is made', () => {
    writeEnvKeys({ [K]: 'new' }, {}, null);
    expect(fs.readFileSync(ENV, 'utf8')).toBe('STRIPE_SECRET_KEY=new\n');
    fs.writeFileSync(ENV, 'A=1\nSTRIPE_SECRET_KEY=new\n');
    writeEnvKeys({ [K]: null }, {}, null);
    expect(fs.readFileSync(ENV, 'utf8')).toBe('A=1\n');
  });

  it.skipIf(process.platform === 'win32')('writeEnvKeys keeps the mode, uid and gid', () => {
    fs.writeFileSync(ENV, 'A=1\n');
    fs.chmodSync(ENV, 0o640);
    const st = fs.statSync(ENV);
    writeEnvKeys({ [K]: 'new' }, {}, null);
    const after = fs.statSync(ENV);
    expect([after.mode & 0o777, after.uid, after.gid]).toEqual([st.mode & 0o777, st.uid, st.gid]);
  });

  it('writeEnvDataBackend replaces the line as before and keeps the rest', () => {
    fs.writeFileSync(ENV, 'A=1\nDATA_BACKEND=file\nB=2\n');
    envLoader.writeEnvDataBackend('postgres');
    expect(fs.readFileSync(ENV, 'utf8')).toBe('A=1\nDATA_BACKEND=postgres\nB=2\n');
    fs.writeFileSync(ENV, 'A=1\n');
    envLoader.writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf8')).toBe('A=1\nDATA_BACKEND=file\n');
  });

  it('U3: writeEnvDataBackend refuses a file that is not valid UTF-8 and leaves its bytes', () => {
    const bytes = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nDATA_BACKEND=file\n')]);
    fs.writeFileSync(ENV, bytes);
    expect(thrown(() => envLoader.writeEnvDataBackend('postgres'))).toBe(T11b);
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });
});
