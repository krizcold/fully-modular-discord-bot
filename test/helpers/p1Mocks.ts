// The module mocks of the P1 rows that run on p1World. This file imports nothing from src: a mock factory that
// imports a helper which imports the mocked module never finishes loading.
//
// A test file mocks two modules with them, as the nb10Premium files do with their own:
//   vi.mock('<src>/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig()));
//   vi.mock('<src>/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

/** The registry module with a registry of its own that holds no built-in provider; `_dropRegistry` starts a new one. */
export function bareRegistry<T extends { PaymentProviderRegistry: new () => any }>(real: T): T {
  let registry: any = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()), _dropRegistry: () => { registry = null; } };
}

// On the process, as the factory and the test may hold two copies of this module.
const KEY = Symbol.for('smdb.p1Notices');
const holder = globalThis as Record<PropertyKey, unknown>;
/** Every notice premium dispatched: whom it named and its kind. */
export const notices = (holder[KEY] ??= { sent: [] }) as { sent: Array<{ to: string; kind: string }> };
/** The payload of each notice in `notices.sent`, at the same index. */
export const noticePayloads = ((holder[KEY] as any).payloads ??= []) as unknown[];

/** The notices module: every notice is delivered and recorded. */
export function noticeModule(): Record<string, unknown> {
  return {
    dispatchPremiumNotification: async (to: string, kind: string, payload?: unknown) => {
      notices.sent.push({ to, kind });
      ((holder[KEY] as any).payloads ??= []).length = notices.sent.length - 1;
      (holder[KEY] as any).payloads.push(payload);
      return { delivered: true, via: 'dm' };
    },
  };
}
