import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ value: {} as any, writes: 0 }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const update = (_f: string, ...rest: any[]) => {
    const apply = rest[rest.length - 1];
    db.writes++;
    db.value = apply(structuredClone(db.value));
    return { outcome: 'saved' };
  };
  return {
    ...(await importOriginal<object>()),
    isClosedForExit: () => true,
    loadModuleData: () => structuredClone(db.value),
    loadGlobalModuleData: () => structuredClone(db.value),
    updateModuleData: update,
    updateGlobalModuleData: update,
  };
});

import {
  cleanupExpiredPanels,
  cleanupInvalidPanels,
  updatePersistentPanelState,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_000_000_000_000;
const inst = (messageId: string, channelId: string, extra: object = {}) =>
  ({ messageId, channelId, userId: '13', createdAt: 0, lastUpdated: T0, state: 'a', ...extra });

const client = (good: string[]) => ({
  channels: {
    fetch: async (channelId: string) => {
      if (!good.includes(channelId)) throw new Error('unknown channel');
      return { isTextBased: () => true, messages: { fetch: async (id: string) => ({ id }) } };
    },
  },
}) as never;

beforeEach(() => { db.value = {}; db.writes = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe('updatePersistentPanelState and its additional data', () => {
  it('leaves sessionData absent when no additional data is given', async () => {
    db.value = { p: inst('m1', 'c1') };
    expect(await updatePersistentPanelState('p', 'b', 'm1', 'g1')).toBe(true);
    expect(db.value.p.state).toBe('b');
    expect(db.value.p.sessionData).toBeUndefined();
  });

  it('merges additional data into the stored sessionData', async () => {
    db.value = { p: inst('m1', 'c1', { sessionData: { a: 1, b: 1 } }) };
    expect(await updatePersistentPanelState('p', 'b', 'm1', 'g1', undefined, { b: 2 })).toBe(true);
    expect(db.value.p.sessionData).toEqual({ a: 1, b: 2 });
  });
});

describe('cleanupExpiredPanels removes sessions older than one day', () => {
  const seed = () => { db.value = { p: { sessions: { s: inst('m1', 'c1') } } }; };

  it('keeps a session one hour old and writes nothing', async () => {
    seed();
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 60 * 60 * 1000);
    expect(await cleanupExpiredPanels(client([]), 'g1')).toBe(0);
    expect(db.value.p.sessions.s).toBeDefined();
    expect(db.writes).toBe(0);
  });

  it('keeps a session exactly one day old', async () => {
    seed();
    vi.spyOn(Date, 'now').mockReturnValue(T0 + DAY);
    expect(await cleanupExpiredPanels(client([]), 'g1')).toBe(0);
    expect(db.value.p.sessions.s).toBeDefined();
  });

  it('removes a session older than one day and its emptied panel', async () => {
    seed();
    vi.spyOn(Date, 'now').mockReturnValue(T0 + DAY + 1);
    expect(await cleanupExpiredPanels(client([]), 'g1')).toBe(1);
    expect(db.value.p).toBeUndefined();
  });

  it('skips single panels and entries that are not objects', async () => {
    db.value = { legacy: inst('m1', 'c1'), odd: 5 };
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 2 * DAY);
    expect(await cleanupExpiredPanels(client([]), 'g1')).toBe(0);
    expect(db.value).toEqual({ legacy: inst('m1', 'c1'), odd: 5 });
  });
});

describe('cleanupInvalidPanels', () => {
  it('removes only the session whose message is gone', async () => {
    db.value = { p: { sessions: { ok: inst('m1', 'good'), gone: inst('m2', 'bad') } } };
    expect(await cleanupInvalidPanels(client(['good']), 'g1')).toBe(1);
    expect(Object.keys(db.value.p.sessions)).toEqual(['ok']);
  });

  it('leaves entries that are neither a session panel nor a single panel, and writes nothing', async () => {
    db.value = { odd: 5, bare: { foo: 1 }, legacy: inst('m1', 'good') };
    expect(await cleanupInvalidPanels(client(['good']), 'g1')).toBe(0);
    expect(db.value).toEqual({ odd: 5, bare: { foo: 1 }, legacy: inst('m1', 'good') });
    expect(db.writes).toBe(0);
  });
});
