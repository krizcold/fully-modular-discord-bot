import { afterEach, describe, expect, it, vi } from 'vitest';

import { onSharedApplied, runSharedAppliedHooks } from '../../src/bot/internalSetup/utils/dataManager';

// The hooks run after this machine's applier brings a shared key up to date: by prefix, removable, a throw logged.

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

describe('runSharedAppliedHooks', () => {
  it('runs a hook only for keys that start with its prefix', () => {
    const seen: string[] = [];
    offs.push(onSharedApplied('rk3a/', key => { seen.push(key); }));
    runSharedAppliedHooks('rk3a/one.json');
    runSharedAppliedHooks('rk3b/two.json');
    runSharedAppliedHooks('xrk3a/three.json');
    expect(seen).toEqual(['rk3a/one.json']);
  });

  it('a removed hook no longer runs', () => {
    const seen: string[] = [];
    const off = onSharedApplied('rk3c/', key => { seen.push(key); });
    runSharedAppliedHooks('rk3c/a.json');
    off();
    runSharedAppliedHooks('rk3c/b.json');
    expect(seen).toEqual(['rk3c/a.json']);
  });

  it('a hook that throws is logged with its key, and the next hook still runs', () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    const boom = new Error('cache gone');
    const seen: string[] = [];
    offs.push(onSharedApplied('rk3d/', () => { throw boom; }));
    offs.push(onSharedApplied('rk3d/', key => { seen.push(key); }));
    runSharedAppliedHooks('rk3d/x.json');
    expect(errors).toEqual([['[Shared] A step run after rk3d/x.json was brought up to date failed:', boom]]);
    expect(seen).toEqual(['rk3d/x.json']);
  });
});
