import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { enqueueDelete, flushAll, getFlushFailures, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

// NB12 (wip-redesign/sheets/NB12.md), empty folders: a delete's flush on a guild path removes each folder it emptied,
// up to the guild folder; ENOTEMPTY, ENOENT or EEXIST ends the walk quietly, another error is logged and ends it, and
// the delete still landed.

let guilds = 9_413_000_000;
let errorCalls: unknown[][];

beforeEach(() => {
  errorCalls = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errorCalls.push(args); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
});

function guild(files: Record<string, string>) {
  const g = String(++guilds);
  const p = (rel = '') => (rel ? dataPath(g, ...rel.split('/')) : dataPath(g));
  for (const [key, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p(key)), { recursive: true });
    fs.writeFileSync(p(key), text);
  }
  return { g, p };
}

const COULD_NOT = '[DataManager] Could not remove the emptied folder';
const logged = () => errorCalls.filter(args => String(args[0]).includes(COULD_NOT));
const flushFailedLogs = () => errorCalls.filter(args => String(args[0]).includes('Flush failed'));

async function deleteLanded(abs: string): Promise<void> {
  const failures = getFlushFailures();
  enqueueDelete(abs);
  await flushAll();
  expect(fs.existsSync(abs)).toBe(false);
  expect(queuedFilePaths()).not.toContain(abs);
  expect(getFlushFailures()).toBe(failures);
  expect(flushFailedLogs()).toEqual([]);
}

function rmdirFailsOnce(error: unknown) {
  return vi.spyOn(fs.promises, 'rmdir').mockRejectedValueOnce(error as never);
}

const coded = (code: string) => Object.assign(new Error(code), { code });

describe('the folders a delete emptied', () => {
  it('a folder that still holds a file stays, and nothing is logged', async () => {
    const { p } = guild({ 'm/a/x.json': '{}', 'm/a/y.json': '{}' });
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m/a/y.json'))).toBe(true);
    expect(logged()).toEqual([]);
  });

  it('a folder that is already gone ends the walk quietly', async () => {
    const { p } = guild({ 'm/a/x.json': '{}' });
    rmdirFailsOnce(coded('ENOENT'));
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m/a'))).toBe(true);
    expect(logged()).toEqual([]);
  });

  it('EEXIST from the rmdir ends the walk quietly', async () => {
    const { p } = guild({ 'm/a/x.json': '{}' });
    rmdirFailsOnce(coded('EEXIST'));
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m/a'))).toBe(true);
    expect(logged()).toEqual([]);
  });

  it('another rmdir error is logged with its code, the folder stays empty and the delete still landed', async () => {
    const { p } = guild({ 'm/a/x.json': '{}' });
    rmdirFailsOnce(coded('EPERM'));
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m/a'))).toBe(true);
    expect(logged()).toEqual([[`${COULD_NOT} ${path.dirname(p('m/a/x.json'))}; it stays empty:`, 'EPERM']]);
  });

  it('an rmdir failure that carries no error is logged, and the delete still landed', async () => {
    const { p } = guild({ 'm/a/x.json': '{}' });
    rmdirFailsOnce(undefined);
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m/a'))).toBe(true);
    expect(logged()).toEqual([[`${COULD_NOT} ${path.dirname(p('m/a/x.json'))}; it stays empty:`, undefined]]);
  });

  it('every emptied folder up to the guild folder is removed, and the guild folder stays', async () => {
    const { p } = guild({ 'm/a/x.json': '{}' });
    await deleteLanded(p('m/a/x.json'));
    expect(fs.existsSync(p('m'))).toBe(false);
    expect(fs.existsSync(p())).toBe(true);
  });

  it('a top folder that is no guild\'s keeps the folders a delete emptied', async () => {
    for (const top of ['9q', 'q9']) {
      const file = dataPath(top, 'm', 'f.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
      await deleteLanded(file);
      expect(fs.existsSync(dataPath(top, 'm'))).toBe(true);
    }
  });

  it.skipIf(process.platform !== 'win32')('a delete under another letter case of the data root never removes the guild folder', async () => {
    fs.writeFileSync(dataPath('marker'), '');
    const { g, p } = guild({ 'm/x.json': '{}' });
    const upper = path.join(dataPath().toUpperCase(), g, 'm', 'x.json');
    expect(upper).not.toBe(p('m/x.json'));
    await deleteLanded(upper);
    expect(fs.existsSync(p('m/x.json'))).toBe(false);
    expect(fs.existsSync(p())).toBe(true);
  });
});
