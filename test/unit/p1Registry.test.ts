import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 14 at the registry (code review 2, S1 and T3): a provider whose capabilities do not say which kinds of
// holder it sells is not registered, whichever way it comes in (the custom providers folder, a module's provider, a
// row's fake), and one [PaymentRegistry] line names it and `sells`. A custom provider written before P1 is skipped
// that way, and premium still answers for the other providers.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry, loadCustomProviders, PaymentProviderRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { gh } from '../helpers/p1Holder';
import { p1World, SERVERS, tierDef } from '../helpers/p1World';

const skipped = (id: string, from?: string) =>
  `[PaymentRegistry] Skipping provider '${id}'${from === undefined ? '' : ` from ${from}`}: its capabilities.sells must list the kinds of holder it sells (guild, user); it was not registered`;
const fake = (id: string, capabilities: unknown) => ({ id, displayName: id, capabilities, isConfigured: () => true, stop: vi.fn() }) as any;
/** The custom loader over a folder of the row's (the folder the bot reads is next to the build). */
const loadCustom = (registry: PaymentProviderRegistry, dir: string): void => loadCustomProviders(registry, dir);
/** A provider written for the interface before P1: its capabilities do not say what it sells. */
const OLD_CAPABILITIES = '{ canInitiatePurchase: true, supportsCancel: true, mechanism: "immediate" }';

afterEach(() => { vi.restoreAllMocks(); });

describe('P1 claim 14: register refuses a provider that does not say what it sells', () => {
  it.each([
    ['no capabilities', undefined],
    ['capabilities without sells', { supportsCancel: true }],
    ['sells empty', { sells: [] }],
    ['sells as a text', { sells: 'guild' }],
    ['sells naming a kind that does not exist', { sells: ['guild', 'server'] }],
  ])('%s: not registered, one line', (_what, capabilities) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new PaymentProviderRegistry();

    const added = registry.register(fake('p1bad', capabilities));

    expect(added).toBe(false);
    expect(registry.get('p1bad')).toBeUndefined();
    expect(registry.listAll()).toEqual([]);
    expect(warn.mock.calls.map(c => c.join(' '))).toEqual([skipped('p1bad')]);
  });

  it('a refused provider does not replace or stop the one registered under its id', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new PaymentProviderRegistry();
    const first = fake('p1same', { sells: ['guild'] });
    expect(registry.register(first)).toBe(true);

    expect(registry.register(fake('p1same', {}))).toBe(false);

    expect(registry.get('p1same')).toBe(first);
    expect(first.stop).not.toHaveBeenCalled();
  });

  it.each([[['guild']], [['user']], [['guild', 'user']]])('sells %j is registered', sells => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new PaymentProviderRegistry();
    const provider = fake('p1good', { sells });

    expect(registry.register(provider)).toBe(true);

    expect(registry.get('p1good')).toBe(provider);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('P1 claim 14: a custom provider written before P1', () => {
  let tmp: string;
  const providerFile = (name: string, id: string, capabilities: string): void => {
    fs.writeFileSync(path.join(tmp, name), [
      'class Custom {',
      `  constructor() { this.id = '${id}'; this.displayName = '${id}'; this.capabilities = ${capabilities}; }`,
      '  isConfigured() { return true; }',
      `  async initiatePurchase() { throw new Error('${id} was asked to sell'); }`,
      '  async listSubscriptionsFor() { return []; }',
      '}',
      'module.exports = { default: Custom };',
      '',
    ].join('\n'));
  };
  /** The provider such a file holds, as the loader makes it. */
  const oldProvider = (): any => {
    providerFile('old.js', 'p1old', OLD_CAPABILITIES);
    const Cls = createRequire(import.meta.url)(path.join(tmp, 'old.js')).default;
    return new Cls();
  };

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1custom-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the loader skips it with the line that names it, its file and sells; a custom provider that says what it sells is loaded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    providerFile('old.js', 'p1old', OLD_CAPABILITIES);
    providerFile('current.js', 'p1current', '{ canInitiatePurchase: true, supportsCancel: true, mechanism: "immediate", sells: ["guild"] }');
    const registry = new PaymentProviderRegistry();

    loadCustom(registry, tmp);

    expect(registry.get('p1old')).toBeUndefined();
    expect(registry.get('p1current')?.id).toBe('p1current');
    expect(warn.mock.calls.map(c => c.join(' '))).toEqual([skipped('p1old', 'old.js')]);
    expect(log.mock.calls.map(c => c.join(' '))).toEqual(["[PaymentRegistry] Loaded custom provider 'p1current' from current.js"]);
  });

  it('registered beside the seller, it leaves setTier, a purchase and findOrphansFor answering for the other providers', async () => {
    for (const level of ['log', 'warn'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    const w = p1World();
    try {
      await w.setup();
      getPaymentRegistry().register(oldProvider());
      const linksOld = { ...tierDef('high'), offerings: [{ id: 'o-old', label: 'Old', providerLinks: [{ providerId: 'p1old', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'v' }] } }] }] };

      expect(await w.setTier('mid', 'Mid renamed')).toMatchObject({ ok: true });
      expect(await w.op('setTier', 'high', linksOld)).toMatchObject({ ok: true });
      expect(await w.purchase(SERVERS[0], 'low')).toMatchObject({ ok: true });
      expect(w.recordOf(SERVERS[0]).active).toMatchObject({ tierId: 'low', source: 'paid' });
      await expect(w.orphans(gh(SERVERS[1]))).resolves.toEqual([]);
    } finally {
      await w.teardown();
    }
  });
});
