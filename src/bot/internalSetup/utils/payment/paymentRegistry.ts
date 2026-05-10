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
import * as fs from 'fs';
import * as path from 'path';
import type { PaymentProvider, ProviderEvent } from './paymentTypes';

// The web-UI (parent) forks the bot (child) and sets BOT_PROCESS_ROLE=bot on
// the child's env. Both processes import this registry and auto-register
// providers, but only one should run tick / scheduled-reconcile loops - if
// both do, we get duplicate 'subscription.expired' events for the same sub.
// The bot is the natural owner since it's the Discord-facing worker.
function isTickerOwner(): boolean {
  return process.env.BOT_PROCESS_ROLE === 'bot';
}

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
    if (provider.start && isTickerOwner()) {
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
    // the import cycle (providers emit via getPaymentRegistry()). All
    // providers register unconditionally; isConfigured() gates whether
    // offerings can use them at subscribe time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DummyProvider } = require('./dummyProvider');
    instance.register(new DummyProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { StripeProvider } = require('./stripeProvider');
    instance.register(new StripeProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DiscordProvider } = require('./discordProvider');
    instance.register(new DiscordProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ServerBoostingProvider } = require('./boostProvider');
    instance.register(new ServerBoostingProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LemonSqueezyProvider } = require('./lemonsqueezyProvider');
    instance.register(new LemonSqueezyProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PayPalProvider } = require('./paypalProvider');
    instance.register(new PayPalProvider());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatreonProvider } = require('./patreonProvider');
    instance.register(new PatreonProvider());

    // Custom providers: hosts drop *.js (compiled from *.ts in /app/custom)
    // into /app/build/bot/internalSetup/utils/payment-providers/. Each file
    // must default-export a class that implements PaymentProvider.
    // Loading is best-effort - one bad file logs and skips, doesn't tear
    // down the registry.
    loadCustomProviders(instance);
  }
  return instance;
}

function loadCustomProviders(registry: PaymentProviderRegistry): void {
  // The custom-providers dir lives next to this file under the build
  // tree. In dev (no overlay merge) the dir won't exist; that's fine.
  const dir = path.resolve(__dirname, '../payment-providers');
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return; }
  for (const file of entries) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(dir, file);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(full);
      const Cls = mod.default || mod[Object.keys(mod).find(k => /Provider$/.test(k)) || ''];
      if (typeof Cls !== 'function') {
        console.warn(`[PaymentRegistry] Skipping '${file}': no default export or *Provider class`);
        continue;
      }
      const provider = new Cls();
      if (!provider || typeof provider !== 'object' || !provider.id || !provider.capabilities) {
        console.warn(`[PaymentRegistry] Skipping '${file}': invalid provider shape`);
        continue;
      }
      if (registry.get(provider.id)) {
        // A custom file would silently override a built-in if we let
        // register() through; refuse so a malicious / accidental file
        // can't shadow the real Stripe/Discord/etc. handler.
        console.warn(`[PaymentRegistry] Skipping '${file}': provider id '${provider.id}' is already registered`);
        continue;
      }
      registry.register(provider as PaymentProvider);
      console.log(`[PaymentRegistry] Loaded custom provider '${provider.id}' from ${file}`);
    } catch (err) {
      console.error(`[PaymentRegistry] Failed to load custom provider '${file}':`, err);
    }
  }
}

export function resetPaymentRegistry(): void {
  if (instance) instance.stopAll();
  instance = null;
}
