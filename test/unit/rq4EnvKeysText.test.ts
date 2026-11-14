import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envKeysText, writeEnvKeys } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

const ENV = dataPath('.env');
const BOM = String.fromCharCode(0xfeff);

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let saved: Buffer | null;
beforeEach(() => {
  saved = fs.existsSync(ENV) ? fs.readFileSync(ENV) : null;
  fs.rmSync(ENV, { force: true });
});
afterEach(() => {
  fs.rmSync(ENV, { force: true });
  if (saved) fs.writeFileSync(ENV, saved);
});

describe('envKeysText finds the lines dotenv reads for a key', () => {
  it('a key with a space before = is replaced in place, not appended', () => {
    expect(envKeysText('K =old\nB=2\n', { K: 'new' })).toBe('K=new\nB=2\n');
  });

  it('an empty value does not take the next line into the span', () => {
    expect(envKeysText('K=\nB=2\n', { K: 'new' })).toBe('K=new\nB=2\n');
  });

  it('a single-quoted two-line value is replaced whole', () => {
    expect(envKeysText("K='a\nb'\nB=2\n", { K: 'new' })).toBe('K=new\nB=2\n');
  });

  it('a single-quoted two-line value with a comment after it is replaced whole', () => {
    expect(envKeysText("K='a\nb' # c\nB=2\n", { K: 'new' })).toBe('K=new\nB=2\n');
  });

  it('a double quote after other text opens no quoted value: the next line stays', () => {
    expect(envKeysText('K=x"a\nb"\nB=2\n', { K: 'new' })).toBe('K=new\nb"\nB=2\n');
  });

  it('a backtick after other text opens no quoted value: the next line stays', () => {
    expect(envKeysText('K=x`a\nb`\nB=2\n', { K: 'new' })).toBe('K=new\nb`\nB=2\n');
  });

  it('a one-letter key with = on the next line is replaced from its own line', () => {
    expect(envKeysText('K\n=old\nB=2\n', { K: 'new' })).toBe('K=new\nB=2\n');
  });

  it('in a BOM file the BOM stays and only the second line is replaced', () => {
    expect(envKeysText(`${BOM}A=1\nK=old\n`, { K: 'new' })).toBe(`${BOM}A=1\nK=new\n`);
  });

  it('a last line with no line end is replaced and keeps no line end', () => {
    expect(envKeysText('A=1\nK=old', { K: 'new' })).toBe('A=1\nK=new');
  });

  it('a last line with no line end is dropped and the line before stays', () => {
    expect(envKeysText('A=1\nK=old', { K: null })).toBe('A=1\n');
  });
});

describe('envKeysText picks the form that reads back', () => {
  it('a value with a single quote and a comment sign is written in double quotes', () => {
    expect(envKeysText('K=old\n', { K: "a'b #c" })).toBe('K="a\'b #c"\n');
  });

  it('a value with both quotes and a comment sign is written in backticks', () => {
    expect(envKeysText('K=old\n', { K: 'a\'b"c #d' })).toBe('K=`a\'b"c #d`\n');
  });

  it('keys are placed in file order, each over the old lines below it', () => {
    expect(envKeysText('K1=old\nK2=x"\n', { K2: 'new', K1: '"abc' })).toBe('K1=\'"abc\'\nK2=new\n');
  });
});

describe('envKeysText refusals name the keys', () => {
  it('two keys that would change another key are listed with a comma', () => {
    expect(thrown(() => envKeysText('X:', { K: 'a', K2: 'b' }))).toBe(
      `Writing K, K2 would change the value of X in ${ENV}; edit that line of ${ENV}, then run the migration again`);
  });

  it('a form that leaves a cleared key set is not taken: the set key is refused', () => {
    expect(thrown(() => envKeysText('N:', { N: null, K: 'v' }))).toBe(
      `The value of K cannot be written to ${ENV} so that it reads back the same; change K in the premium tab, then run the migration again`);
  });

  it('a key no line can hold is the one refused; the key before it still takes its quoted form', () => {
    const odd = 'Stryker was here';
    expect(thrown(() => envKeysText('K=old\n', { K: "a'b #c", [odd]: 'x' }))).toBe(
      `The value of ${odd} cannot be written to ${ENV} so that it reads back the same; change ${odd} in the premium tab, then run the migration again`);
  });
});

describe('writeEnvKeys on a file that is not UTF-8', () => {
  it('refuses with the payment provider words and leaves the bytes', () => {
    const bytes = Buffer.from([0x41, 0x3d, 0xff, 0x0a]);
    fs.writeFileSync(ENV, bytes);
    expect(thrown(() => writeEnvKeys({ STRIPE_SECRET_KEY: 'v' }, {}, null))).toBe(
      `${ENV} is not valid UTF-8, so the payment provider keys cannot be written to it without changing other bytes; save it as UTF-8, then run the migration again`);
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });
});
