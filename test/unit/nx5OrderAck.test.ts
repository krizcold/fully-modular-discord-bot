import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 2 (sheets/NX5.md decision 9): every answer comes from a saveHeldWrites run that enterForOrder made for the
// current order (ruling G3). True gives saved true with zero counts and the process's ids; false gives the counts and
// a new save and answer at each read until true; null gives null; an answer to an earlier or void order writes
// nothing; a hook that answered saved false, then the order read, answers false from its own save; after a true
// answer, a write held again at the next read gives a new save and a new answer. Fails today.

type Left = { unsavedGuilds: number; unsavedFiles: number; unansweredGuilds: number; unconfirmedFiles: number; unansweredFiles?: number; resaveGuilds?: number };
const ctl = vi.hoisted(() => ({ saves: [] as Left[], calls: 0, held: false }));
const ZERO: Left = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => {
    ctl.calls += 1;
    return ctl.saves.length > 1 ? ctl.saves.shift()! : ctl.saves[0] ?? { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 };
  },
  hasHeldWrites: () => ctl.held,
}));

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';

const m = maintenance as any;

beforeEach(() => {
  ctl.saves = [];
  ctl.calls = 0;
  ctl.held = false;
  maintenance._setMaintenanceSender(() => undefined);
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  m.attachSaveOrderSource?.(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.restoreAllMocks();
});

function attached(): OrderStore {
  const store = new OrderStore();
  m.attachSaveOrderSource?.({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  return store;
}

const ids = { orderId: 'o-1', processId: ME.processId, nodeId: ME.nodeId, nodeName: ME.nodeName };

describe('test 2: the answer to the order', () => {
  it('saveHeldWrites answering true gives one insert with saved true, zero counts, the process id, node id, node name and order id', async () => {
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toEqual({
      ...ids, saved: true, unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, resaveGuilds: 0,
    });
    expect(ctl.calls).toBe(1);
    expect(maintenanceCause()).toBe('order');
  });

  it('false gives the counts, then a new save and a new answer at each read until true', async () => {
    ctl.saves = [{ ...ZERO, unsavedGuilds: 2, unsavedFiles: 1 }, { ...ZERO, unsavedGuilds: 1 }, ZERO];
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toMatchObject({ ...ids, saved: false, unsavedGuilds: 2, unsavedFiles: 1 });
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(2));
    expect(store.acks[1]).toMatchObject({ saved: false, unsavedGuilds: 1, unsavedFiles: 0 });
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(3));
    expect(store.acks[2]).toMatchObject({ saved: true, unsavedGuilds: 0 });
    expect(ctl.calls).toBe(3);
    m.noteSaveOrder?.(order());
    await settle();
    expect(store.acks).toHaveLength(3);
  });

  it('a save the database did not answer gives saved null with its counts', async () => {
    ctl.saves = [{ ...ZERO, unansweredGuilds: 3, unconfirmedFiles: 1, unansweredFiles: 2 }];
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toMatchObject({ ...ids, saved: null, unansweredGuilds: 3, unconfirmedFiles: 1, unansweredFiles: 2 });
  });

  it('G8-5: every count of a null answer is one the save counted, so the row carries numbers and no NULL', async () => {
    ctl.saves = [{ ...ZERO, unansweredGuilds: 1 }];
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0]).toEqual({
      ...ids, saved: null, unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 1, unconfirmedFiles: 0, unansweredFiles: 0, resaveGuilds: 0,
    });
  });

  it('a hook that answered saved false, then the order read: the order\'s answer is false from its own save, never the hook\'s', async () => {
    ctl.saves = [{ ...ZERO, unsavedGuilds: 4 }, { ...ZERO, unsavedGuilds: 1, unsavedFiles: 2 }];
    const store = attached();
    const hook = await maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'h-1', data: { message: 'From the hook.' } });
    expect(hook).toEqual({ requestId: 'h-1', data: expect.objectContaining({ saved: false, unsavedGuilds: 4 }) });
    expect(ctl.calls).toBe(1);
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(ctl.calls).toBe(2);
    expect(store.acks[0]).toMatchObject({ saved: false, unsavedGuilds: 1, unsavedFiles: 2 });
  });

  it('after a true answer, a write held again at the next read (an entitlement event) gives a new save and a new answer', async () => {
    ctl.saves = [ZERO, { ...ZERO, unsavedFiles: 1 }];
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    expect(store.acks[0].saved).toBe(true);
    ctl.held = true;
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(2));
    expect(ctl.calls).toBe(2);
    expect(store.acks[1]).toMatchObject({ saved: false, unsavedFiles: 1 });
  });

  it('a new order id gets its own save and answer', async () => {
    const store = attached();
    m.noteSaveOrder?.(order());
    await vi.waitFor(() => expect(store.acks).toHaveLength(1));
    m.noteSaveOrder?.(order({ orderId: 'o-2' }));
    await vi.waitFor(() => expect(store.acks).toHaveLength(2));
    expect(ctl.calls).toBe(2);
    expect(store.acks[1]).toMatchObject({ orderId: 'o-2', saved: true });
  });

  it('a read of a void order (a lower generation) writes no answer', async () => {
    const store = attached();
    m.noteSaveOrder?.(order({ current: false }));
    await settle();
    expect(store.acks).toEqual([]);
    expect(ctl.calls).toBe(0);
  });
});

describe('test 2: the answer statement', () => {
  function storeAnswering(rowCount: number) {
    const texts: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      async connect() {
        return {
          query(config: any, values?: unknown[]) {
            const text = typeof config === 'string' ? config : config.text;
            texts.push({ text, values: (typeof config === 'string' ? values : config.values) ?? [] });
            return Promise.resolve({ rows: [], rowCount });
          },
          release() { /* kept */ },
        };
      },
      async end() { /* nothing open */ },
      on() { return pool; },
    };
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', claimTimings(30), () => undefined);
    void (store as any).pool.end().catch(() => undefined);
    (store as any).pool = pool;
    return { store: store as any, texts };
  }

  const ack = { ...ids, saved: true, unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, resaveGuilds: 0 };

  it('is one insert into save_acks guarded by the order being current at maintenance, upserted on process_id', async () => {
    const { store, texts } = storeAnswering(1);
    expect(await store.writeSaveAck(ack)).toBe(true);
    expect(texts).toHaveLength(1);
    const { text, values } = texts[0];
    expect(text).toMatch(/INSERT INTO smdb_manager\.save_acks/);
    expect(text).toMatch(/WHERE EXISTS \(SELECT 1 FROM smdb_manager\.save_order o WHERE o\.order_id = \$\d+ AND o\.state = 'maintenance' AND o\.generation = coalesce\(\(SELECT generation FROM smdb_manager\.generation\), 0\)\)/i);
    expect(text).toMatch(/ON CONFLICT \(process_id\) DO UPDATE SET/);
    expect(values).toEqual(expect.arrayContaining(['o-1', ME.processId, ME.nodeId, ME.nodeName, true]));
  });

  it('an answer to an earlier or void order writes nothing: the guard finds no row and the write answers false', async () => {
    const { store } = storeAnswering(0);
    expect(await store.writeSaveAck({ ...ack, orderId: 'o-0' })).toBe(false);
  });
});
