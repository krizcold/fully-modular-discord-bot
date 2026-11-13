import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  RESTORE_TEXTS,
  deleteGuildNamespace,
  restoreGuildFromGraveyard,
  retiresToSettle,
  setGuildDataBackend,
  setOwnerInfoProvider,
  settledRetire,
} from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { LEASED } from '../helpers/readinessRig';

// A retire's entry kept for step (e) of a database move, the working set evicted or kept after a retire, and the
// Postgres restore's answers and log lines.

class Scripted extends FakeStore {
  epoch = 0;
  retireImpl: (() => Promise<RetireOutcome>) | null = null;
  restoreImpl: (() => Promise<RestoreOutcome>) | null = null;
  databaseEpoch(): number { return this.epoch; }
  override async retireGuild(): Promise<RetireOutcome> {
    if (this.retireImpl) return this.retireImpl();
    return { ok: true, moved: 1, retiredAt: 5 };
  }
  override async restoreGuild(): Promise<RestoreOutcome> {
    if (this.restoreImpl) return this.restoreImpl();
    return { ok: false, reason: 'no-entry' };
  }
}

let drivers: DataReadinessDriver[] = [];
let errors: string[];

function setup(): { store: Scripted; ws: WorkingSetManager } {
  const store = new Scripted();
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged(LEASED);
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return { store, ws };
}

async function readyGuild(ws: WorkingSetManager): Promise<string> {
  const guildId = freshGuild();
  expect(await ws.hydrate(guildId, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
  return guildId;
}

const listed = (epoch: number, guildId: string) => retiresToSettle(epoch).filter(r => r.guildId === guildId);

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('a retire whose answer came after the database epoch moved', () => {
  it('stays listed for a move at another epoch, not at its own, keeps the set, and goes once settled', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => {
      store.epoch = 1;
      return { ok: true, moved: 2, retiredAt: 44 };
    };
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: true });
    const kept = listed(1, g);
    expect(kept).toHaveLength(1);
    expect(await kept[0].answer).toEqual({ ok: true, moved: 2, retiredAt: 44 });
    expect(listed(0, g)).toEqual([]);
    expect(ws.stateOf(g)).not.toBeNull();
    settledRetire(g);
    expect(listed(1, g)).toEqual([]);
  });

  it('a retire still on the wire is listed for another epoch only', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    let answer!: (v: RetireOutcome) => void;
    store.retireImpl = () => new Promise<RetireOutcome>(resolve => { answer = resolve; });
    const deleting = deleteGuildNamespace(g, 'test', 1000);
    await vi.waitFor(() => expect(listed(3, g)).toHaveLength(1), { timeout: 2000, interval: 5 });
    expect(listed(0, g)).toEqual([]);
    answer({ ok: true, moved: 1, retiredAt: 9 });
    expect(await deleting).toEqual({ ok: true });
    expect(listed(3, g)).toEqual([]);
  });
});

describe('a retire answered at the epoch it was sent', () => {
  it('ok: the entry goes and the set is evicted', async () => {
    const { ws } = setup();
    const g = await readyGuild(ws);
    expect(await deleteGuildNamespace(g, 'test', 1000)).toEqual({ ok: true });
    expect(listed(1, g)).toEqual([]);
    expect(ws.stateOf(g)).toBeNull();
  });

  it('latched: the set is kept, since nothing was retired', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'latched', detail: 'db1 was replaced' });
    const reply = await deleteGuildNamespace(g, 'test', 1000);
    expect(reply.ok).toBe(false);
    expect(ws.stateOf(g)).not.toBeNull();
    expect(listed(1, g)).toEqual([]);
  });

  it('held: the set is kept, since nothing was retired', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'held', detail: 'the database did not answer' });
    const reply = await deleteGuildNamespace(g, 'test', 1000);
    expect(reply.ok).toBe(false);
    expect(ws.stateOf(g)).not.toBeNull();
  });

  it('unknown: the set is evicted', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.retireImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 5, moved: 1 });
    await deleteGuildNamespace(g, 'test', 1000);
    expect(ws.stateOf(g)).toBeNull();
  });
});

describe('the Postgres restore', () => {
  const late = { committed: true, old: 'db1:5432/bot', why: 'db1 was replaced' };

  it('a late unknown logs the batch the database answered, not the one asked', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', retiredAt: 9, late });
    await restoreGuildFromGraveyard(g, 5);
    expect(errors).toContain(`[Data] Guild ${g}: ${RESTORE_TEXTS.late(g, late, 9, undefined)}`);
  });

  it('a late unknown with no batch answered logs the batch asked', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'unknown', late });
    await restoreGuildFromGraveyard(g, 5);
    expect(errors).toContain(`[Data] Guild ${g}: ${RESTORE_TEXTS.late(g, late, 5, undefined)}`);
  });

  it('a plain restore answers no replaced field; a replace answers its batch', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: true, copied: 2, retiredAt: 5, reason: 'left', usedAt: 100 });
    const plain = await restoreGuildFromGraveyard(g, 5);
    expect(plain).toMatchObject({ ok: true, retiredAt: 5, reason: 'left', copied: 2 });
    expect(Object.keys(plain)).not.toContain('replaced');

    const h = await readyGuild(ws);
    const replaced = { retiredAt: 77, moved: 3, reason: 'replaced-by-restore-5' };
    store.restoreImpl = async () => ({ ok: true, copied: 2, retiredAt: 5, reason: 'left', usedAt: 100, replaced });
    expect(await restoreGuildFromGraveyard(h, 5, undefined, true)).toMatchObject({ ok: true, replaced });
  });

  it('an incomplete restore logs the step and the row counts', async () => {
    const { store, ws } = setup();
    const g = await readyGuild(ws);
    store.restoreImpl = async () => ({ ok: false, reason: 'incomplete', step: 'copy-in', taken: 4, put: 3 });
    expect(await restoreGuildFromGraveyard(g, 5)).toEqual({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.incomplete(3, 4) });
    expect(errors).toContain(`[DataManager] The restore of guild ${g} stopped at its copy-in: the database put 3 of 4 row(s) in place; rolled back`);
  });
});
