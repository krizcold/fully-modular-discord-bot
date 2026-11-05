import fs from 'fs';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';

// Helpers of the nb10Premium*.test.ts files (decisions 12, 13, 20 and 23 of NB10). Each file mocks the data facade's
// tracked writes (to inject refusals), the payment registry (a real registry the test fills) and the notices.

export const PREMIUM = dataPath('global', 'premium-tiers.json');
export const AUDIT = dataPath('global', 'premium-tiers.audit.jsonl');
export const JOURNAL = dataPath('global', 'premium-tiers.events.jsonl');
export const DUMMY_STATE = dataPath('global', 'payment-providers', 'dummy', 'state.json');

export const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Lands everything queued (a path whose flush keeps failing stays queued). */
export async function settleQueue(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushAll();
    await tick(2);
  }
}

export function clearGlobal(): void {
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global'), { recursive: true });
}

export const rawOf = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

export function jsonOf(file: string): any {
  const raw = rawOf(file);
  return raw === null ? null : JSON.parse(raw);
}

export function linesOf(file: string): any[] {
  const raw = rawOf(file);
  if (raw === null) return [];
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export const TIERS = {
  free: { displayName: 'Free', priority: 0, overrides: {}, offerings: [] },
  low: { displayName: 'Low', priority: 1, overrides: {}, offerings: [{ id: 'o1', label: 'Low', providerLinks: [] }] },
  high: { displayName: 'High', priority: 2, overrides: {}, offerings: [{ id: 'o2', label: 'High', providerLinks: [] }] },
};

/** A premium-tiers.json with the tiers above and the subscriptions given. */
export function writePremium(subscriptions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dataPath('global'), { recursive: true });
  fs.writeFileSync(PREMIUM, JSON.stringify({ tiers: TIERS, subscriptions, messages: {}, providerAccountLinks: {}, activatedProviders: {}, migrations: [], migrationSilencePolicy: 'cancel', ...extra }, null, 2));
}

export const state = (status: 'active' | 'paused' | 'expired' = 'active', days = 30) => ({
  status,
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + days * 86_400_000).toISOString(),
  autoRenew: true,
});

/** A paid subscription record as premium-tiers.json stores it. */
export function paidSub(id: string, providerSubId: string, tierId = 'low', providerId = 'fake'): Record<string, unknown> {
  return {
    id, tierId, source: 'paid', offeringId: tierId === 'low' ? 'o1' : 'o2', providerId, providerSubId,
    purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 30, tierDisplayName: tierId, tierPriority: 1, purchasedAt: new Date().toISOString() },
    ...state(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

export function quiet(): { error: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> } {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

export const logged = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));

/** A promise the test resolves. */
export function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}
