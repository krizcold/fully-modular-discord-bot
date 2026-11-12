import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { fsyncDataDirs } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const errno = (code: unknown) => Object.assign(new Error(`stubbed ${String(code)}`), { code });

type Plan = { openCode?: string; syncCode?: string; closeError?: unknown };

function fakeOpen(plan: Plan) {
  const opened: string[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any) => {
    opened.push(path.resolve(String(p)));
    if (plan.openCode) throw errno(plan.openCode);
    return {
      sync: async () => { if (plan.syncCode) throw errno(plan.syncCode); },
      close: async () => { if (plan.closeError !== undefined) throw plan.closeError; },
    };
  }) as any);
  return opened;
}

describe('fsyncDataDirs passes over the folder errors that mean the operation is not supported', () => {
  for (const code of ['EISDIR', 'EPERM', 'EACCES']) {
    it(`answers not failed when opening a data folder fails with ${code}`, async () => {
      const opened = fakeOpen({ openCode: code });
      await expect(fsyncDataDirs()).resolves.toEqual({ failed: false });
      expect(opened).toEqual([path.resolve(DATA_ROOT), path.resolve(DATA_ROOT, '_graveyard')]);
    });
  }

  for (const code of ['ENOTSUP', 'EOPNOTSUPP']) {
    it(`answers not failed when a data folder's fsync fails with ${code}`, async () => {
      fakeOpen({ syncCode: code });
      await expect(fsyncDataDirs()).resolves.toEqual({ failed: false });
    });
  }

  it('still answers an open error outside the skipped set', async () => {
    fakeOpen({ openCode: 'ENOENT' });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: true, dir: DATA_ROOT, code: 'ENOENT', kind: 'open' });
  });
});

describe('fsyncDataDirs logs a close error by its code', () => {
  it('names a close error whose code is null as having no error code', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    fakeOpen({ closeError: errno(null) });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: false });
    expect(errors).toHaveLength(2);
    for (const line of errors) {
      expect(line).toContain('the directory could not be closed after its sync (no error code)');
      expect(line).not.toContain('(null)');
    }
  });

  it('names a close error by its code when it has one', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    fakeOpen({ closeError: errno('EBADF') });
    await fsyncDataDirs();
    expect(errors[0]).toContain(`[Data] ${DATA_ROOT}: the directory could not be closed after its sync (EBADF)`);
  });
});
