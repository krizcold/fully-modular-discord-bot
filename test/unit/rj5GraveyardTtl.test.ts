import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteGuildDataServing, setGuildDataBackend, sweepGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import type { DataBackend } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rj5: GRAVEYARD_TTL_DAYS as the graveyard row sweep reads it: a positive number of days, else 14.

const DAY = 24 * 60 * 60 * 1000;
const TTL_BEFORE = process.env.GRAVEYARD_TTL_DAYS;

async function sweptWith(value: string | undefined): Promise<number[]> {
  if (value === undefined) delete process.env.GRAVEYARD_TTL_DAYS;
  else process.env.GRAVEYARD_TTL_DAYS = value;
  const ttls: number[] = [];
  setGuildDataBackend({
    kind: 'postgres',
    servesData: () => true,
    sweepGraveyard: async (ttlMs: number) => { ttls.push(ttlMs); return 0; },
  } as unknown as DataBackend);
  await sweepGraveyard();
  return ttls;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  setBackendKind('postgres');
  noteGuildDataServing();
});

afterEach(() => {
  if (TTL_BEFORE === undefined) delete process.env.GRAVEYARD_TTL_DAYS;
  else process.env.GRAVEYARD_TTL_DAYS = TTL_BEFORE;
  setGuildDataBackend(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the graveyard rows are kept GRAVEYARD_TTL_DAYS days', () => {
  it('a positive number of days is used as given', async () => {
    expect(await sweptWith('2')).toEqual([2 * DAY]);
  });

  it('unset, zero, negative or not a finite number: 14 days, so no row is swept early', async () => {
    expect(await sweptWith(undefined)).toEqual([14 * DAY]);
    expect(await sweptWith('0')).toEqual([14 * DAY]);
    expect(await sweptWith('-1')).toEqual([14 * DAY]);
    expect(await sweptWith('Infinity')).toEqual([14 * DAY]);
  });
});
