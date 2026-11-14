import fs from 'fs';
import { describe, expect, it } from 'vitest';

// L5 run A, chunk rs3: readKeyFile, the reader of /data/owner-messages.json that the notify-owner route's key record
// moved to (it was managed.ts's readKeyRecord at a6be9133): which file bodies hold a record of keys.

import { readKeyFile } from '../../src/bot/internalSetup/utils/ownerMessageRecord';
import { dataPath } from '../../src/utils/dataRoot';

const FILE = dataPath('rs3-owner-messages.json');
const NO_RECORD = { ok: false, cause: 'it holds no record of keys' };

function read(text: string) {
  fs.mkdirSync(dataPath(), { recursive: true });
  fs.writeFileSync(FILE, text);
  try {
    return readKeyFile(FILE);
  } finally {
    fs.rmSync(FILE, { force: true });
  }
}

describe('rs3 readKeyFile', () => {
  it('rs3 a record of string times is read as it is', () => {
    expect(read('{"keys":{"a":"2026-11-01T00:00:00.000Z","b":"2026-11-02T00:00:00.000Z"}}')).toEqual({ ok: true, keys: { a: '2026-11-01T00:00:00.000Z', b: '2026-11-02T00:00:00.000Z' } });
  });

  it('rs3 a missing file holds no keys', () => {
    expect(readKeyFile(dataPath('rs3-absent.json'))).toEqual({ ok: true, keys: {} });
  });

  it.each([
    ['null', 'null'],
    ['no keys field', '{}'],
    ['keys as text', '{"keys":"abc"}'],
    ['keys as a list', '{"keys":["a"]}'],
    ['one time not text', '{"keys":{"a":"2026-11-01T00:00:00.000Z","b":1}}'],
    ['no time text', '{"keys":{"a":1,"b":2}}'],
  ])('rs3 %s is refused as no record of keys', (_label, text) => {
    expect(read(text)).toEqual(NO_RECORD);
  });
});
