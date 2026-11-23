import fs from 'fs';
import Module from 'module';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPaymentRegistry, resetPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';

// P4 (sheet P4, section R3): the registry the bot builds at boot, with no mock of it: it holds no Lemon Squeezy
// provider. The registry loads each built-in provider with a CommonJS require, which cannot load a .ts file under
// vitest; that require is answered with the module of every *Provider.ts file the payment folder holds.

const DIR = path.resolve(__dirname, '../../src/bot/internalSetup/utils/payment');
const providers = new Map<string, unknown>();

beforeAll(async () => {
  for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('Provider.ts'))) {
    providers.set(`./${file.slice(0, -'.ts'.length)}`, await import(path.join(DIR, file)));
  }
});

let built: ReturnType<typeof getPaymentRegistry> | null = null;

afterEach(() => {
  for (const p of built?.listAll() ?? []) (p as any).dispose?.();
  built = null;
  resetPaymentRegistry();
  vi.restoreAllMocks();
});

function builtRegistry() {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const real = loader._load;
  const asked: string[] = [];
  loader._load = function (request: string, ...rest: unknown[]) {
    if (providers.has(request)) {
      asked.push(request);
      return providers.get(request);
    }
    return real.call(this, request, ...rest);
  };
  try {
    built = getPaymentRegistry();
    return { registry: built, asked };
  } finally {
    loader._load = real;
  }
}

describe('the built-in providers', () => {
  it('are dummy, stripe, discord, boost, paypal and patreon, in that order, and none is lemonsqueezy', () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    resetPaymentRegistry();
    const { registry, asked } = builtRegistry();
    expect(asked).toHaveLength(6);
    expect(registry.listAll().map(p => p.id)).toEqual(['dummy', 'stripe', 'discord', 'boost', 'paypal', 'patreon']);
    expect(registry.get('lemonsqueezy')).toBeUndefined();
  });
});
