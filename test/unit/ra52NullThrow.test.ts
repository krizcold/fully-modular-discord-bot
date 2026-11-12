import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ throwNull: false }));

vi.mock('fs', async orig => {
  const real = await orig<typeof import('fs')>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    if (h.throwNull && String(args[0]).endsWith('module-crashes.json')) throw null;
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

import { _resetModuleCrashes, crashLineOf } from '../../src/bot/internalSetup/utils/moduleCrashes';

afterEach(() => {
  h.throwNull = false;
  _resetModuleCrashes();
});

it('a read of the crash file that throws a bare null is logged with that value, not a TypeError', () => {
  h.throwNull = true;
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  let line: unknown;
  try {
    line = crashLineOf('ra52null');
  } finally {
    console.error = orig;
  }
  expect(line).toBeNull();
  expect(errors).toEqual(['[Error] The module crash count could not be written (null)']);
});
