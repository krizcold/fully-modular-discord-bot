/**
 * Payment Provider Registry
 *
 * Singleton that holds every registered provider and a shared event bus.
 * PremiumManager subscribes to `provider.event` to mirror provider state
 * into its own cache. Providers emit via `emitEvent()`.
 *
 * Built-in providers (Dummy) are auto-registered on first access so the
 * system is usable out of the box. Real providers register themselves at
 * boot once the HOST has configured their credentials.
 */

import { EventEmitter } from 'events';
import type { PaymentProvider, ProviderEvent } from './paymentTypes';

export class PaymentProviderRegistry extends EventEmitter {
  private providers = new Map<string, PaymentProvider>();

  register(provider: PaymentProvider): void {
    const existing = this.providers.get(provider.id);
    if (existing) {
      console.warn(`[PaymentRegistry] Replacing existing provider '${provider.id}'`);
      if (existing.stop) {
        try { existing.stop(); } catch (err) { console.error(`[PaymentRegistry] stop() failed for '${provider.id}':`, err); }
      }
    }
    this.providers.set(provider.id, provider);
    if (provider.start) {
      try { provider.start(); } catch (err) { console.error(`[PaymentRegistry] start() failed for '${provider.id}':`, err); }
    }
  }

  unregister(providerId: string): boolean {
    const p = this.providers.get(providerId);
    if (!p) return false;
    if (p.stop) {
      try { p.stop(); } catch (err) { console.error(`[PaymentRegistry] stop() failed for '${providerId}':`, err); }
    }
    return this.providers.delete(providerId);
  }

  get(id: string): PaymentProvider | undefined {
    return this.providers.get(id);
  }

  listAll(): PaymentProvider[] {
    return Array.from(this.providers.values());
  }

  listConfigured(): PaymentProvider[] {
    return this.listAll().filter(p => p.isConfigured());
  }

  /** Providers call this to push lifecycle events into the bus. */
  emitEvent(event: ProviderEvent): void {
    this.emit('provider.event', event);
  }

  /** Tear down all providers; used in tests / process shutdown. */
  stopAll(): void {
    for (const [id, p] of this.providers) {
      if (p.stop) {
        try { p.stop(); } catch (err) { console.error(`[PaymentRegistry] stop() failed for '${id}':`, err); }
      }
    }
    this.providers.clear();
  }
}

let instance: PaymentProviderRegistry | null = null;

export function getPaymentRegistry(): PaymentProviderRegistry {
  if (!instance) {
    instance = new PaymentProviderRegistry();
    // Auto-register built-in providers on first access. Lazy require avoids
    // the import cycle (DummyProvider emits via getPaymentRegistry()).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DummyProvider } = require('./dummyProvider');
    instance.register(new DummyProvider());
  }
  return instance;
}

export function resetPaymentRegistry(): void {
  if (instance) instance.stopAll();
  instance = null;
}
