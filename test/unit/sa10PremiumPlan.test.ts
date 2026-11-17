import { describe, expect, it } from 'vitest';
import { pausedDaysLeft, samePlan, type AdoptPlan } from '../../src/bot/internalSetup/utils/premiumManager';

// NB25 decisions 1 and 2: the days a paused orphan has left, and whether the plan a page showed is the server's.

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const ref = (metadata: Record<string, unknown>, endDate: string | null = new Date(NOW + 3 * DAY_MS).toISOString()) => ({
  providerSubId: 'orph',
  metadata: { guildId: 'g1', tierId: 'low', offeringId: 'o1', ...metadata },
  state: { status: 'paused', startDate: new Date(NOW).toISOString(), endDate, autoRenew: true },
  display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
}) as any;

describe('pausedDaysLeft', () => {
  it('a negative recorded count is not trusted: the days come from the period end', () => {
    expect(pausedDaysLeft(ref({ pausedDaysLeft: -1, pausedAt: '2026-11-01T00:00:00.000Z' }), NOW)).toEqual({ days: 3, from: 'period' });
  });

  it('zero recorded days are the recorded answer', () => {
    expect(pausedDaysLeft(ref({ pausedDaysLeft: 0, pausedAt: '2026-11-01T00:00:00.000Z' }), NOW)).toEqual({ days: 0, from: 'recorded', at: '2026-11-01T00:00:00.000Z' });
  });
});

describe('samePlan', () => {
  const install: AdoptPlan = { kind: 'install', line: 'It is active at Fake, and adopting adds it as it is.' };

  it('null shown is never the plan, and does not throw', () => {
    expect(samePlan(null, install)).toBe(false);
  });

  it('a function carrying the plan\'s fields is not an object the page showed', () => {
    const shown = Object.assign(() => undefined, { kind: 'install' });
    expect(samePlan(shown, install)).toBe(false);
  });

  it('a plain object with the same fields is the plan', () => {
    expect(samePlan({ kind: 'install' }, install)).toBe(true);
  });
});
