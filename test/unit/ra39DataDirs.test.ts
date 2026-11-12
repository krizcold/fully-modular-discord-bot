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

const ROOT = path.resolve(DATA_ROOT);
const GRAVE = path.resolve(DATA_ROOT, '_graveyard');
const errno = (code: string) => Object.assign(new Error(`stubbed ${code}`), { code });

type Plan = { open?: string; sync?: string; close?: string };

function fakeOpen(plans: Record<string, Plan>) {
  const closed: string[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any) => {
    const at = path.resolve(String(p));
    const plan = plans[at] ?? {};
    if (plan.open) throw errno(plan.open);
    return {
      sync: async () => { if (plan.sync) throw errno(plan.sync); },
      close: async () => { closed.push(at); if (plan.close) throw errno(plan.close); },
    };
  }) as any);
  return closed;
}

function quietErrors(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return lines;
}

describe('fsyncDataDirs answers a folder it could not open', () => {
  it('answers the open error of /data when it is outside the skipped set', async () => {
    quietErrors();
    fakeOpen({ [ROOT]: { open: 'ENOENT' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: true, dir: DATA_ROOT, code: 'ENOENT', kind: 'open' });
  });

  it('answers the first folder when both fail to open', async () => {
    quietErrors();
    fakeOpen({ [ROOT]: { open: 'ENOENT' }, [GRAVE]: { open: 'ENOTDIR' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: true, dir: DATA_ROOT, code: 'ENOENT', kind: 'open' });
  });

  it('answers the graveyard when only it fails to open', async () => {
    quietErrors();
    fakeOpen({ [GRAVE]: { open: 'ENOENT' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: true, dir: path.join(DATA_ROOT, '_graveyard'), code: 'ENOENT', kind: 'open' });
  });

  it('passes over an open refused with EACCES', async () => {
    quietErrors();
    fakeOpen({ [ROOT]: { open: 'EACCES' }, [GRAVE]: { open: 'EACCES' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: false });
  });
});

describe('fsyncDataDirs answers a folder whose fsync failed', () => {
  it('answers an fsync error outside the skipped set as a sync failure', async () => {
    quietErrors();
    const closed = fakeOpen({ [ROOT]: { sync: 'EIO' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO', kind: 'sync' });
    expect(closed).toEqual([ROOT, GRAVE]);
  });
});

describe('fsyncDataDirs logs a folder handle it could not close', () => {
  it('names the folder and the close error, and still answers the sync', async () => {
    const lines = quietErrors();
    fakeOpen({ [GRAVE]: { close: 'EBADF' } });
    await expect(fsyncDataDirs()).resolves.toEqual({ failed: false });
    expect(lines).toEqual([
      `[Data] ${path.join(DATA_ROOT, '_graveyard')}: the directory could not be closed after its sync (EBADF); this does not change whether the sync succeeded`,
    ]);
  });
});
