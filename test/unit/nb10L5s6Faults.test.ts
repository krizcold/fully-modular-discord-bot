import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivors of dummyProvider.ts (decision 12): a failed re-read of state.json in the web UI, a save that
// throws, and a save the stop refuses in the bot. The facade's read and save are wrapped so a test can make them fail.

const hooks = vi.hoisted(() => ({
  save: null as null | ((...args: any[]) => any),
  read: null as null | ((absPath: string) => string | null),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (...args: any[]) => (hooks.save ? hooks.save(...args) : (real.saveDataTracked as any)(...args)),
    readRawStrict: (absPath: string) => (hooks.read ? hooks.read(absPath) : real.readRawStrict(absPath)),
  };
});

import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { clearGlobal, DUMMY_STATE, settleQueue } from './nb10PremiumRig';

const FILE = 'payment-providers/dummy/state.json';
const role = process.env.BOT_PROCESS_ROLE;
const made: DummyProvider[] = [];
let errors: ReturnType<typeof vi.spyOn>;

const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));
const variant = (id: string) => ({ variantId: id, label: id, amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true });

function provider(): DummyProvider {
  const p = new DummyProvider();
  made.push(p);
  return p;
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  hooks.save = null;
  hooks.read = null;
  delete process.env.BOT_PROCESS_ROLE;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  hooks.save = null;
  hooks.read = null;
  for (const p of made.splice(0)) p.dispose();
  await settleQueue();
  delete process.env.BOT_PROCESS_ROLE;
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the web UI cannot re-read a loaded state.json', () => {
  it('keeps the loaded copy and logs the cause once', () => {
    fs.mkdirSync(path.dirname(DUMMY_STATE), { recursive: true });
    fs.writeFileSync(DUMMY_STATE, JSON.stringify({ variants: { z: variant('z') } }));
    const dummy = provider();
    expect(dummy.adminListVariants().map(v => v.variantId)).toEqual(['z']);
    hooks.read = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(dummy.adminListVariants().map(v => v.variantId)).toEqual(['z']);
    expect(dummy.adminListVariants().map(v => v.variantId)).toEqual(['z']);
    expect(lines(errors).filter(l => l.includes('could not be read to check for changes'))).toEqual([
      `[DummyProvider] ${FILE} could not be read to check for changes (EACCES); kept the loaded copy`,
    ]);
  });
});

describe('a save that throws an unexpected error', () => {
  it('logs that the state failed to save, with the error', () => {
    const boom = new Error('disk on fire');
    hooks.save = () => { throw boom; };
    provider().adminSetVariant(variant('z'));
    expect(errors.mock.calls.some((c: unknown[]) =>c[0] === '[DummyProvider] Failed to save state:' && c[1] === boom)).toBe(true);
  });
});

describe('in the bot, a save the stop refuses is not held for a retry', () => {
  beforeEach(() => {
    process.env.BOT_PROCESS_ROLE = 'bot';
  });

  it('node-stopping: the final stop step logs no held change', () => {
    hooks.save = () => { throw new DataBackendUnavailableError('node-stopping'); };
    const dummy = provider();
    dummy.adminSetVariant(variant('z'));
    dummy.finalStop();
    expect(lines(errors).filter(l => l.includes('holds changes'))).toEqual([]);
  });

  it('an io refusal is held, and the final stop step logs it as lost', () => {
    hooks.save = () => ({ outcome: 'refused', cause: 'io' });
    const dummy = provider();
    dummy.adminSetVariant(variant('z'));
    dummy.finalStop();
    expect(lines(errors).filter(l => l.includes('holds changes'))).toEqual([
      `[DummyProvider] ${FILE} holds changes the disk refused; they are lost with this stop`,
    ]);
  });
});
