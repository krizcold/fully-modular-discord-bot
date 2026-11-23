import crypto from 'crypto';
import { afterEach, expect, it, vi } from 'vitest';

// P3 claim 2: the stripe package is loaded at the first webhook verification, not when the registry is made or the
// Stripe provider required. This file signs with node's crypto and imports nothing that requires `stripe`.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));

const loaded = (): string[] => Object.keys(require.cache).filter(p => p.replace(/\\/g, '/').includes('node_modules/stripe/cjs/'));

afterEach(() => { vi.unstubAllEnvs(); });

it('require.cache holds no stripe package path until the first handleWebhook', async () => {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_lazy');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_lazy');
  const { getPaymentRegistry } = await import('../../src/bot/internalSetup/utils/payment/paymentRegistry');
  const { StripeProvider } = await import('../../src/bot/internalSetup/utils/payment/stripeProvider');
  const provider = new StripeProvider();
  getPaymentRegistry().register(provider);
  const before = loaded();
  const body = JSON.stringify({ id: 'evt_lazy', object: 'event', type: 'p3.unhandled', data: { object: { id: 'x_1' } } });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_lazy').update(`${t}.${body}`).digest('hex')}`;
  const outcome = await provider.handleWebhook(Buffer.from(body), header).then(() => 'handled', (e: Error) => e.message);
  expect(before).toEqual([]);
  expect(outcome).toBe('handled');
  expect(loaded().length).toBeGreaterThan(0);
});
