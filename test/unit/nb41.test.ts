import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, saveCredentials } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

// NB41: saveCredentials writes /data/.env through the NB6F writer. Values are compared, never printed.

const ENV = dataPath('.env');
const K = 'STRIPE_NB41_VALUE';
const NEXT = 'STRIPE_NB41_NEXT';
const LS = '\u2028';
const KEYS = [K, NEXT, 'STRIPE_NB41_P0', 'STRIPE_NB41_P1', 'STRIPE_NB41_P2'];

/** What the bot reads from the file at start: loadCredentials seeds process.env with each key the container does not set. */
function loaded(key: string): string | undefined {
  loadCredentials();
  return process.env[key];
}

const tempFiles = () => fs.readdirSync(path.dirname(ENV)).filter(name => name.startsWith('.env.') && name.endsWith('.tmp'));

let before: Buffer | null;
beforeEach(() => {
  before = fs.existsSync(ENV) ? fs.readFileSync(ENV) : null;
  fs.rmSync(ENV, { force: true });
  for (const key of KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(ENV, { force: true });
  loadCredentials();
  for (const key of KEYS) delete process.env[key];
  if (before) fs.writeFileSync(ENV, before);
});

describe('saveCredentials writes each value so the loader reads it back as given', () => {
  const values: Array<[string, string]> = [
    ['a #', 'pass #word'],
    ['a # at its start', '#word'],
    ['a double quote', 'pa"ss'],
    ['double quotes around it', '"pass"'],
    ['a single quote', "pa'ss"],
    ['single quotes around it', "'pass'"],
    ['both quotes', `p'a"ss`],
    ['both quotes and a #', `p'a" #ss`],
    ['leading and trailing spaces', '  pass  '],
    ['a backslash', 'pa\\ss\\'],
    ['a backslash and an n in double quotes', '"pa\\nss"'],
    ['a $', 'pa$ss${HOME}$'],
    ['an =', '=pa=ss='],
    ['a backtick', 'pa`ss'],
    ['an empty value', ''],
    ['a tab inside', 'pa\tss'],
    ['a tab at each end', '\tpass\t'],
    ['a no-break space at each end', '\u00a0pass\u00a0'],
    ['a U+2028 line separator', 'pa\u2028ss\u2028'],
    ['letters outside ASCII', 'p\u00e4ss\u65e5\u672c\ud83d\ude00'],
    ['only spaces', '   '],
    ['a backslash before a double quote', 'pa\\"ss'],
    ['a backslash before a single quote', "pa\\'ss\\'"],
    ['a backslash before the quote that ends it', '"pass\\"'],
  ];

  it.each(values)('%s', (_name, value) => {
    expect(saveCredentials({ [K]: value, [NEXT]: 'next-value' })).toEqual({ success: true });
    expect(loaded(K) === value).toBe(true);
    expect(loaded(NEXT)).toBe('next-value');
  });

  it.each(values)('%s, over a file that already sets the key', (_name, value) => {
    fs.writeFileSync(ENV, `${K}=old\n${NEXT}=next-value\n`);
    expect(saveCredentials({ [K]: value, [NEXT]: 'next-value' })).toEqual({ success: true });
    expect(loaded(K) === value).toBe(true);
    expect(loaded(NEXT)).toBe('next-value');
  });

  it('any map of printable values without line breaks reads back equal', () => {
    const ascii = fc.integer({ min: 32, max: 126 }).map(code => String.fromCharCode(code));
    const wider = fc.constantFrom('\t', '\u00a0', '\u2028', '\u2029', '\u00e4', '\u65e5', '\ud83d\ude00', '\ufeff', '\u0001', '\u007f', '\u0085', '\u3000');
    const printable = fc.array(fc.oneof({ weight: 3, arbitrary: ascii }, { weight: 1, arbitrary: wider }), { maxLength: 12 })
      .map(chars => chars.join(''))
      .filter(v => !(v.includes("'") && v.includes('"') && v.includes('`')));
    fc.assert(fc.property(fc.dictionary(fc.constantFrom(...KEYS), printable), fc.dictionary(fc.constantFrom(...KEYS), printable), (first, second) => {
      for (const map of [first, second]) {
        const result = saveCredentials(map);
        if (!result.success) return false;
        loadCredentials();
        if (!KEYS.every(key => process.env[key] === map[key])) return false;
      }
      return true;
    }), { numRuns: 150 });
  });
});

describe('saveCredentials refuses a value the file cannot carry', () => {
  it.each([['a line feed', 'pa\nss'], ['a carriage return', 'pa\rss'], ['both', 'pa\r\nss']])('%s: refused by key name, the file byte for byte as before', (_name, value) => {
    const bytes = Buffer.from(`# head\n${K}=old\n${NEXT}=next-value\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [K]: value, [NEXT]: 'changed' });
    expect(result).toEqual({ success: false, error: `The value of ${K} holds a line break, and a save does not write one; nothing was saved` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it('a NUL character: refused by key name, the file byte for byte as before', () => {
    const bytes = Buffer.from(`# head\n${K}=old\n${NEXT}=next-value\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [K]: 'pa\u0000ss', [NEXT]: 'changed' });
    expect(result).toEqual({ success: false, error: `The value of ${K} holds a NUL character, and a save does not write one; nothing was saved` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it.each([['a lone high surrogate', 'pa\ud800ss'], ['a lone low surrogate', 'pass\udc00'], ['a pair the wrong way round', '\udc00\ud800']])('%s: refused by key name, the file byte for byte as before', (_name, value) => {
    const bytes = Buffer.from(`# head\n${K}=old\n${NEXT}=next-value\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [NEXT]: 'changed', [K]: value });
    expect(result).toEqual({ success: false, error: `The value of ${K} is not well-formed Unicode text, and a save does not write it; nothing was saved` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it('saving would change a key the save does not hold: refused naming that key, the file as before', () => {
    const bytes = Buffer.from(`${NEXT}=1\nX:`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [NEXT]: '1', [K]: 'new' });
    expect(result).toEqual({ success: false, error: `Saving would change the value of X in ${ENV}; nothing was saved. Edit that line of ${ENV}, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('saving would change two such keys: both named in the plural sentence', () => {
    const bytes = Buffer.from(['A=', `${K}=1`, "'x'", 'B=', `${NEXT}=1`, "'y'", ''].join('\n'));
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ A: '', B: '' });
    expect(result).toEqual({ success: false, error: `Saving would change the values of A, B in ${ENV}; nothing was saved. Edit those lines of ${ENV}, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('a removed key that a hidden line still sets: refused naming it, the file as before', () => {
    const bytes = Buffer.from(`${NEXT}='a\n${K}=1\nb'\u2028${K}=2\n${NEXT}=z\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [NEXT]: 'z' });
    expect(result).toEqual({ success: false, error: `${ENV} would still set ${K} after the save; nothing was saved. Remove that line from ${ENV}, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('a line break with no file before: refused, and no file is made', () => {
    expect(saveCredentials({ [K]: 'pa\nss' }).success).toBe(false);
    expect(fs.existsSync(ENV)).toBe(false);
  });

  it('a value no quoted form reads back: refused by key name, never by value, the file as before', () => {
    const value = ` p'a"s\`s #`;
    const bytes = Buffer.from(`${K}=old\n${NEXT}=next-value\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [K]: value, [NEXT]: 'next-value' });
    expect(result).toEqual({ success: false, error: `The value of ${K} cannot be written to ${ENV} so that it reads back the same; nothing was saved. Change the value, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('two removed keys that hidden lines still set: both named in the plural sentence', () => {
    const bytes = Buffer.from(`${NEXT}='a\n${K}=1\nSTRIPE_NB41_P0=1\nb'${LS}${K}='2'${LS}STRIPE_NB41_P0=2\n${NEXT}=z\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [NEXT]: 'z' });
    expect(result).toEqual({ success: false, error: `${ENV} would still set ${K}, STRIPE_NB41_P0 after the save; nothing was saved. Remove those lines from ${ENV}, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it.each(['BAD KEY', 'BAD=KEY', ''])('a key name the file cannot hold (%j): refused as the name, with no advice about its value', key => {
    const bytes = Buffer.from(`${K}=old\n`);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [K]: 'old', [key]: 'value' });
    expect(result).toEqual({ success: false, error: `"${key}" is not a key name ${ENV} can hold (letters, digits, _, . and - only); nothing was saved` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('a file that is not valid UTF-8: refused, its bytes left', () => {
    const bytes = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${K}=old\n`)]);
    fs.writeFileSync(ENV, bytes);
    const result = saveCredentials({ [K]: 'new' });
    expect(result).toEqual({ success: false, error: `${ENV} is not valid UTF-8, so it cannot be changed without changing other bytes; nothing was saved. Save the file as UTF-8, then save again` });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('a multi-line value already in the file and passed back unchanged does not refuse the save', () => {
    fs.writeFileSync(ENV, `${K}="one\ntwo"\n${NEXT}=old\n`);
    expect(saveCredentials({ [K]: 'one\ntwo', [NEXT]: 'new' })).toEqual({ success: true });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${K}="one\ntwo"\n${NEXT}=new\n`);
  });
});

describe('saveCredentials and the rest of the file', () => {
  it('comments, blank lines, unread lines and key order stay; a key not passed, or passed undefined, is removed', () => {
    fs.writeFileSync(ENV, `# head\n${NEXT}=keep # why\n\n${K}=old # was set\nnot a key line\nSTRIPE_NB41_P0=gone\nSTRIPE_NB41_P1=cleared\n# tail\n`);
    expect(saveCredentials({ [K]: 'new', STRIPE_NB41_P2: 'added', [NEXT]: 'keep', STRIPE_NB41_P1: undefined })).toEqual({ success: true });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`# head\n${NEXT}=keep # why\n\n${K}=new\nnot a key line\n# tail\nSTRIPE_NB41_P2=added\n`);
  });

  it('a key name with a dot and a hyphen is saved and read back', () => {
    const key = 'STRIPE_NB41.A-B';
    delete process.env[key];
    const result = saveCredentials({ [key]: 'dotted', [NEXT]: 'next-value' });
    const read = loaded(key);
    fs.rmSync(ENV, { force: true });
    loadCredentials();
    delete process.env[key];
    expect(result).toEqual({ success: true });
    expect(read).toBe('dotted');
  });

  it('a new file holds the keys in the order given, undefined ones left out', () => {
    expect(saveCredentials({ [NEXT]: 'b', STRIPE_NB41_P0: undefined, [K]: 'a' })).toEqual({ success: true });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${NEXT}=b\n${K}=a\n`);
  });

  it('leaves no temp file behind', () => {
    fs.writeFileSync(ENV, `${K}=old\n`);
    expect(saveCredentials({ [K]: 'pass #word' }).success).toBe(true);
    expect(saveCredentials({ [K]: 'pass #word', [NEXT]: 'x' }).success).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps the mode, uid and gid', () => {
    fs.writeFileSync(ENV, `${K}=old\n`);
    fs.chmodSync(ENV, 0o640);
    const st = fs.statSync(ENV);
    expect(saveCredentials({ [K]: 'new' }).success).toBe(true);
    const after = fs.statSync(ENV);
    expect([after.mode & 0o777, after.uid, after.gid]).toEqual([st.mode & 0o777, st.uid, st.gid]);
  });

  it('duplicate lines of a changed key: the loader reads the new value and no older line is left', () => {
    fs.writeFileSync(ENV, `${K}=first\n${NEXT}=next-value\n${K}=second\n`);
    expect(saveCredentials({ [K]: 'new', [NEXT]: 'next-value' })).toEqual({ success: true });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${NEXT}=next-value\n${K}=new\n`);
    expect(loaded(K)).toBe('new');
  });

  it('duplicate lines of an unchanged key are left as they are', () => {
    fs.writeFileSync(ENV, `${K}=first\n${NEXT}=old\n${K}=second\n`);
    expect(saveCredentials({ [K]: 'second', [NEXT]: 'new' })).toEqual({ success: true });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${K}=first\n${NEXT}=new\n${K}=second\n`);
  });

  it('a BOM and CRLF line ends stay; an appended line ends in LF', () => {
    fs.writeFileSync(ENV, `\ufeff${NEXT}=keep\r\n# note\r\n${K}=old\r\n`);
    expect(saveCredentials({ [NEXT]: 'keep', [K]: 'new', STRIPE_NB41_P0: 'added' })).toEqual({ success: true });
    expect(fs.readFileSync(ENV).equals(Buffer.from(`\ufeff${NEXT}=keep\r\n# note\r\n${K}=new\r\nSTRIPE_NB41_P0=added\n`))).toBe(true);
    expect(loaded(NEXT)).toBe('keep');
  });

  /** The read of /data/.env after the write answers `second` (a Buffer) or throws it. */
  function secondRead(second: Buffer | Error): void {
    const real = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file) === ENV && ++reads === 2) {
        if (second instanceof Error) throw second;
        return second;
      }
      return (real as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
  }

  it('answers a failure naming each key the file does not read back as given', () => {
    fs.writeFileSync(ENV, `${K}=old\n`);
    secondRead(Buffer.from(`${K}=other\nSTRIPE_NB41_P0=extra\n`));
    const result = saveCredentials({ [K]: 'new', [NEXT]: 'next-value' });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(result).toEqual({ success: false, error: `${ENV} was written but does not read back ${K}, ${NEXT}, STRIPE_NB41_P0 as given; save again` });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${K}=new\n${NEXT}=next-value\n`);
  });

  it('a read back that fails says the file was written and that the save cannot be confirmed', () => {
    fs.writeFileSync(ENV, `${K}=old\n`);
    secondRead(Object.assign(new Error(`EACCES: permission denied, open '${ENV}'`), { code: 'EACCES' }));
    const result = saveCredentials({ [K]: 'new' });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(result).toEqual({ success: false, error: `${ENV} was written, but it could not be read back (EACCES: permission denied, open '${ENV}'), so the save can't be confirmed; save again` });
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`${K}=new\n`);
  });
});
