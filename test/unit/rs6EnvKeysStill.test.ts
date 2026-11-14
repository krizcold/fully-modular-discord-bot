import { describe, expect, it } from 'vitest';
import { envKeysText } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';

const LS = String.fromCharCode(0x2028);
const ENV = dataPath('.env');
const T1 = `Q='a\nK=1\nb'${LS}K=2\nQ=z\n`;
const T2 = `Q='a\nK=1\nJ=1\nb'${LS}K='2'${LS}J=2\nQ=z\n`;

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('envKeysText refuses a removed key that a hidden line still sets', () => {
  it('names one key cleared in the database when its line reappears', () => {
    expect(thrown(() => envKeysText(T1, { K: null }))).toBe(
      `K was cleared in the database, but a line of ${ENV} still sets it; remove that line, then run the migration again`);
  });

  it('names every key cleared in the database when their lines reappear', () => {
    expect(thrown(() => envKeysText(T2, { K: null, J: null }))).toBe(
      `K, J were cleared in the database, but lines of ${ENV} still set them; remove those lines, then run the migration again`);
  });

  it('names the unread provider of one key whose line reappears', () => {
    expect(thrown(() => envKeysText(T1, { K: null }, { K: 'stripe' }))).toBe(
      `The database's keys of stripe cannot be read, so K must not be set, but a line of ${ENV} still sets it; remove that line, then run the migration again`);
  });

  it('names only the keys of the first unread provider', () => {
    expect(thrown(() => envKeysText(T2, { K: null, J: null }, { K: 'stripe', J: 'paypal' }))).toBe(
      `The database's keys of stripe cannot be read, so K must not be set, but a line of ${ENV} still sets it; remove that line, then run the migration again`);
  });

  it('names every key of one unread provider whose lines reappear', () => {
    expect(thrown(() => envKeysText(T2, { K: null, J: null }, { K: 'stripe', J: 'stripe' }))).toBe(
      `The database's keys of stripe cannot be read, so K, J must not be set, but lines of ${ENV} still set them; remove those lines, then run the migration again`);
  });
});

describe('envKeysText refuses a value that cannot read back while another key stays', () => {
  it('says the value cannot be written, not that another key changes', () => {
    expect(thrown(() => envKeysText(`S='o'${LS}Q=2\n`, { S: `x'${LS}Q='2` }))).toBe(
      `The value of S cannot be written to ${ENV} so that it reads back the same; change S in the premium tab, then run the migration again`);
  });
});
