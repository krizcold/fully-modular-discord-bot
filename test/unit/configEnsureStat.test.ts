import path from 'path';
import { describe, expect, it, vi } from 'vitest';

// Node's own behaviour for a config.json it cannot stat or read while the file is in place. EIO: a stat that fails
// with something other than ENOENT (EIO or ESTALE on a network or overlay volume, EACCES on a parent), so statSync,
// lstatSync and a read throw it and existsSync answers false. A dangling link: the entry is there (lstatSync finds
// it), but statSync and a read follow the link and throw ENOENT, and existsSync answers false.
const fault = vi.hoisted(() => ({ path: '', on: false, code: 'EIO', lstatToo: true }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const hit = (p: unknown) => fault.on && String(p) === fault.path;
  const fail = () => Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
  const existsSync = (p: import('fs').PathLike) => (hit(p) ? false : real.existsSync(p));
  const wrap = <F extends (...a: never[]) => unknown>(f: F, always = true) => ((p: unknown, ...rest: unknown[]) => {
    if (hit(p) && (always || fault.lstatToo)) throw fail();
    return (f as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as F;
  const mocked = { ...real, existsSync, statSync: wrap(real.statSync), lstatSync: wrap(real.lstatSync, false), readFileSync: wrap(real.readFileSync) };
  return { ...mocked, default: mocked };
});

import fs from 'fs';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { getConfigProperty, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';

const readUnder = (code: string, lstatToo: boolean) => {
  Object.assign(fault, { path: ROOT_CONFIG_PATH, on: true, code, lstatToo });
  try {
    getConfigProperty('DEVS');
  } finally {
    fault.on = false;
  }
};

// Its own file: the fault is in place before the first config read of the process.
describe('a config.json the bot cannot stat or read while it is in place', () => {
  it('is never replaced by the default when its stat fails with EIO', async () => {
    fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(ROOT_CONFIG_PATH, JSON.stringify({ DEVS: ['111'] }));
    expect(() => readUnder('EIO', true)).not.toThrow();
    expect(getPending(ROOT_CONFIG_PATH)).toBeUndefined();
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ DEVS: ['111'] });
  });

  it('is never replaced by the default when it is a link whose target is away', async () => {
    expect(() => readUnder('ENOENT', false)).not.toThrow();
    expect(getPending(ROOT_CONFIG_PATH)).toBeUndefined();
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ DEVS: ['111'] });
  });
});
