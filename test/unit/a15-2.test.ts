import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlStore, MigrationRecord, PersistedMigrations } from '../../src/bot/internalSetup/fleet/controlStore';
import { choiceNotSavedText, CONTROL_WRITE_DEADLINE_MS, ControlWriteError, ControlWriteUnconfirmedError, declareLostRegisterRefusal, declareNotDoneText, proposalClearable, refusedWriteNote, restorePlacement } from '../../src/bot/internalSetup/fleet/controlWrites';
import { CoordinatorHooks, MigrationCoordinator } from '../../src/bot/internalSetup/fleet/migration/migrationCoordinator';
import { PostgresControlStore } from '../../src/bot/internalSetup/fleet/postgresControlStore';
import { Registry } from '../../src/bot/internalSetup/fleet/registry';

// A15-2: the held-shard choice writes the migration records before it lets
// go of the hold in memory, and a fence reason says when nobody has asked
// the node owing a cleanup to run it.

const NOW = Date.now();

function heldRecord(): MigrationRecord {
  return {
    id: 'm1', kind: 'move', state: 'DONE', term: 1, epoch: 5, shardCount: 2, createdAt: NOW, updatedAt: NOW,
    legs: [{
      legId: 'L1', shardId: 1, sourceNodeId: 'h1', targetNodeId: 'lost', direction: 'push', guilds: ['4194304'],
      committed: { epoch: 5, at: NOW, sourceName: 'holder' }, heldForChoice: { lostNodeName: 'lost', at: NOW },
    }],
    pendingSourceCleanup: [{ nodeId: 'h1', legIds: ['L1'] }],
  };
}

interface Rig {
  coordinator: MigrationCoordinator;
  registry: Registry;
  writes: PersistedMigrations[];
  refuse: { on: boolean };
  sendControl: { impl: (nodeId: string, type: string, data: any) => Promise<any> };
}

const coordinators: MigrationCoordinator[] = [];

async function rig(history: MigrationRecord[] = [heldRecord()]): Promise<Rig> {
  const registry = new Registry();
  registry.term = 1;
  registry.epoch = 5;
  registry.shardCount = 2;
  registry.upsertNode({ nodeId: 'h1', nodeName: 'holder', appVersion: 'test', capabilities: {} as any, isSelf: false, send: null });
  const writes: PersistedMigrations[] = [];
  const refuse = { on: false };
  const sendControl: Rig['sendControl'] = { impl: async () => ({ ok: false }) };
  const store = {
    loadMigrations: async (): Promise<PersistedMigrations> => ({ active: null, history, updatedAt: NOW }),
    saveMigrations: async (state: PersistedMigrations): Promise<void> => {
      if (refuse.on) throw new Error('ENOSPC: no space left on device');
      writes.push(JSON.parse(JSON.stringify(state)));
    },
  } as unknown as ControlStore;
  const hooks = {
    registry,
    selfNodeId: 'master',
    store,
    isPaused: () => false,
    holdDownRemainingMs: () => 0,
    sendControl: (nodeId: string, type: string, data: any) => sendControl.impl(nodeId, type, data),
    isSelf: () => false,
    pushStatus: () => undefined,
  } as unknown as CoordinatorHooks;
  const coordinator = new MigrationCoordinator(hooks);
  coordinators.push(coordinator);
  await coordinator.recover();
  return { coordinator, registry, writes, refuse, sendControl };
}

afterEach(() => {
  for (const c of coordinators.splice(0)) {
    for (const timer of ((c as any).cleanupTimers as Map<string, NodeJS.Timeout>).values()) clearTimeout(timer);
  }
});

describe('a held-shard choice whose record write is refused', () => {
  it('keeps the shard waiting on the choice in memory', async () => {
    const { coordinator, writes, refuse } = await rig();
    expect(coordinator.heldShards().map(h => h.shardId)).toEqual([1]);
    refuse.on = true;
    await expect(coordinator.releaseHeld(1)).rejects.toThrow('ENOSPC');
    expect(writes).toEqual([]);
    expect(coordinator.heldShards().map(h => h.shardId)).toEqual([1]);
    expect(coordinator.holdShardIds().has(1)).toBe(true);
  });

  it('a written choice drops the hold on disk and in memory, naming the node owing the cleanup', async () => {
    const { coordinator, writes } = await rig();
    expect(await coordinator.releaseHeld(1)).toEqual(['h1']);
    expect(writes).toHaveLength(1);
    expect(writes[0].history[0].legs[0].heldForChoice).toBeUndefined();
    expect(writes[0].history[0].pendingSourceCleanup).toEqual([{ nodeId: 'h1', legIds: ['L1'] }]);
    expect(coordinator.heldShards()).toEqual([]);
    expect(coordinator.holdShardIds().has(1)).toBe(false);
  });

  it('names the nodes owing the shard\'s cleanup before any release', async () => {
    const { coordinator } = await rig();
    expect(coordinator.cleanupOwersOf(1)).toEqual(['h1']);
    expect(coordinator.cleanupOwersOf(0)).toEqual([]);
  });
});

describe('the fence reason of a released shard', () => {
  it('says a connected node owing the cleanup has not been asked when no run or retry is armed', async () => {
    const { coordinator } = await rig();
    await coordinator.releaseHeld(1);
    expect(coordinator.cleanupFenceReason(1)).toBe('held back until the cleanup of an earlier move has run: holder has not been asked to run it yet');
  });

  it('says the node has not finished it while a run is under way', async () => {
    const { coordinator, sendControl } = await rig();
    await coordinator.releaseHeld(1);
    sendControl.impl = () => new Promise(() => undefined);
    void coordinator.retrySourceCleanup('h1');
    await new Promise(resolve => setImmediate(resolve));
    expect(coordinator.cleanupFenceReason(1)).toBe('held back until the cleanup of an earlier move has run: holder has not finished it yet');
  });

  it('says the node has not finished it while a retry is armed', async () => {
    const { coordinator, sendControl } = await rig();
    await coordinator.releaseHeld(1);
    sendControl.impl = async () => { throw new Error('unanswered'); };
    await coordinator.retrySourceCleanup('h1');
    await new Promise(resolve => setImmediate(resolve));
    expect(coordinator.cleanupFenceReason(1)).toBe('held back until the cleanup of an earlier move has run: holder has not finished it yet');
  });
});

function lostRecord(): MigrationRecord {
  return {
    id: 'm2', kind: 'move', state: 'DONE', term: 1, epoch: 6, shardCount: 2, createdAt: NOW, updatedAt: NOW,
    legs: [
      { legId: 'L1', shardId: 1, sourceNodeId: 'h1', targetNodeId: 'lost', direction: 'push', guilds: ['4194304'], committed: { epoch: 6, at: NOW, sourceName: 'holder' } },
      { legId: 'L2', shardId: 0, sourceNodeId: 'lost', targetNodeId: 'h1', direction: 'push', guilds: ['0'], committed: { epoch: 6, at: NOW, sourceName: 'lost' } },
    ],
    pendingSourceCleanup: [{ nodeId: 'h1', legIds: ['L1'] }, { nodeId: 'lost', legIds: ['L2'] }],
  };
}

describe('a Declare Lost whose migration record write is refused', () => {
  it('leaves the records held as they were', async () => {
    const { coordinator, writes, refuse } = await rig([lostRecord()]);
    refuse.on = true;
    await expect(coordinator.onNodeDeclaredLost('lost', 'lost', [1])).rejects.toThrow('ENOSPC');
    expect(writes).toEqual([]);
    expect(coordinator.heldShards()).toEqual([]);
    expect(coordinator.holdShardIds().has(1)).toBe(false);
    const legs = (coordinator as any).history[0].legs;
    expect(legs[0].heldForChoice).toBeUndefined();
    expect(legs[1].sourceLostAt).toBeUndefined();
  });

  it('a written verdict holds the surviving copy and marks the lost source, on disk and in memory', async () => {
    const { coordinator, writes } = await rig([lostRecord()]);
    expect(await coordinator.onNodeDeclaredLost('lost', 'lost', [1])).toEqual([1]);
    expect(writes).toHaveLength(1);
    expect(writes[0].history[0].legs[0].heldForChoice?.lostNodeName).toBe('lost');
    expect(writes[0].history[0].legs[1].sourceLostAt).toEqual(expect.any(Number));
    expect(coordinator.heldShards().map(h => h.shardId)).toEqual([1]);
    expect((coordinator as any).history[0].legs[1].sourceLostAt).toEqual(writes[0].history[0].legs[1].sourceLostAt);
  });
});

describe('a holder lease placed only once written', () => {
  it('is built without touching the table and placed on a known node only', async () => {
    const { registry } = await rig();
    const lease = registry.holderLease('h1', 1, 9);
    expect(registry.shardTable.size).toBe(0);
    registry.placeOnHolder(registry.holderLease('gone', 0, 9));
    expect(registry.shardTable.size).toBe(0);
    registry.nodes.get('h1')!.needsGrant = false;
    registry.placeOnHolder(lease);
    expect(registry.shardTable.get(1)).toEqual(lease);
    expect(lease.epoch).toBe(9);
    expect(registry.nodes.get('h1')!.needsGrant).toBe(true);
  });
});

describe('the control store write decisions', () => {
  const refusedPlan = new ControlWriteError(false, new Error('EIO'));
  const refusedRegistry = new ControlWriteError(true, new Error('EIO'));

  it('names which document a refused write left unwritten', () => {
    expect(refusedWriteNote(refusedPlan)).toBe('the control store refused the plan write (EIO), written again on a later placement pass');
    expect(refusedWriteNote(refusedRegistry)).toBe('the plan landed; the registry write was refused (EIO) and is written again on a later placement pass');
    expect(refusedWriteNote(new Error('EIO'))).toBe('the control store refused the plan write (EIO), written again on a later placement pass');
  });

  it('places a restore only as far as the store holds it, never on a node gone meanwhile', () => {
    expect(restorePlacement(refusedPlan, { connected: true })).toBe('unsaved');
    expect(restorePlacement(new Error('fenced'), { connected: true })).toBe('unsaved');
    expect(restorePlacement(refusedRegistry, { connected: true })).toBe('place');
    expect(restorePlacement(null, { connected: true })).toBe('place');
    expect(restorePlacement(null, { connected: false })).toBe('place-down');
    expect(restorePlacement(null, undefined)).toBe('holder-gone');
    expect(restorePlacement(refusedRegistry, undefined)).toBe('holder-gone');
  });

  it('clears a settled proposal only once the plan holding it is stored', () => {
    expect(proposalClearable(0, '1:a', '1:a')).toBe(true);
    expect(proposalClearable(0, '1:a', '')).toBe(false);
    expect(proposalClearable(0, '1:a', null)).toBe(false);
    expect(proposalClearable(1, '1:a', '1:a')).toBe(false);
  });
});

describe('the migration record writes', () => {
  it('run one at a time, in order, each from the records as they stand when it starts', async () => {
    const { coordinator, writes } = await rig([lostRecord()]);
    const store = (coordinator as any).hooks.store as ControlStore;
    const save = store.saveMigrations.bind(store);
    let inFlight = 0;
    let most = 0;
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let calls = 0;
    (store as any).saveMigrations = async (state: PersistedMigrations): Promise<void> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      calls += 1;
      if (calls === 1) await gate;
      try {
        await save(state);
      } finally {
        inFlight -= 1;
      }
    };
    const declared = coordinator.onNodeDeclaredLost('lost', 'lost', [1]);
    const after = (coordinator as any).persist() as Promise<void>;
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
    open();
    await Promise.all([declared, after]);
    expect(most).toBe(1);
    expect(writes).toHaveLength(2);
    expect(writes[0].history[0].legs[0].heldForChoice?.lostNodeName).toBe('lost');
    expect(writes[1].history[0].legs[0].heldForChoice?.lostNodeName).toBe('lost');
    expect(writes[1].history[0].legs[1].sourceLostAt).toEqual(writes[0].history[0].legs[1].sourceLostAt);
  });

  it('a refused write does not stop the next one', async () => {
    const { coordinator, writes, refuse } = await rig();
    refuse.on = true;
    await expect(coordinator.releaseHeld(1)).rejects.toThrow('ENOSPC');
    refuse.on = false;
    await (coordinator as any).persist();
    expect(writes).toHaveLength(1);
    expect(writes[0].history[0].legs[0].heldForChoice?.lostNodeName).toBe('lost');
  });
});

describe('a register while its node\'s Declare Lost is being written', () => {
  it('is refused and grants nothing; any other node registers as usual', () => {
    const declaring = new Set(['lost']);
    expect(declareLostRegisterRefusal(declaring, 'lost', 7)).toEqual({ accepted: false, term: 7, reason: 'declare-lost-in-flight' });
    expect(declareLostRegisterRefusal(declaring, 'h1', 7)).toBeNull();
    expect(declareLostRegisterRefusal(new Set(), 'lost', 7)).toBeNull();
  });
});

// A pool whose upsert answers when told to; a hung one never settles.
function fakePool(): { pool: any; upserts: string[]; destroyed: number; hangNext: { on: boolean } } {
  const out = { upserts: [] as string[], destroyed: 0, hangNext: { on: false }, pool: null as any };
  out.pool = {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT term')) return { rows: [{ term: 3 }] };
        if (sql.includes('INSERT INTO smdb_control.docs')) {
          if (out.hangNext.on) {
            out.hangNext.on = false;
            return new Promise(() => undefined);
          }
          out.upserts.push(String(params?.[1]));
        }
        return { rows: [] };
      },
      release: (destroy?: boolean) => { if (destroy) out.destroyed += 1; },
    }),
  };
  return out;
}

function pgStore(pool: any): PostgresControlStore {
  const store = new PostgresControlStore(pool);
  (store as any).provisioned = true;
  (store as any).mintedTerm = 3;
  return store;
}

describe('a control-store write never answered', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('gives up at the deadline as unconfirmed, discarding its client', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakePool();
    const store = pgStore(fake.pool);
    fake.hangNext.on = true;
    const hung = store.saveMigrations({ active: null, history: [], updatedAt: 1 });
    const settled = expect(hung).rejects.toBeInstanceOf(ControlWriteUnconfirmedError);
    await vi.advanceTimersByTimeAsync(CONTROL_WRITE_DEADLINE_MS);
    await settled;
    expect(fake.destroyed).toBe(1);
    await store.saveMigrations({ active: null, history: [], updatedAt: 2 });
    expect(fake.upserts.map(body => JSON.parse(body).updatedAt)).toEqual([2]);
  });

  it('lets the migration record queue move on: the choice stays waiting here and the next write lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { coordinator } = await rig();
    const fake = fakePool();
    const store = pgStore(fake.pool);
    (coordinator as any).hooks.store.saveMigrations = (state: PersistedMigrations) => store.saveMigrations(state);
    fake.hangNext.on = true;
    const choice = coordinator.releaseHeld(1);
    const refusal = choice.catch((error: unknown) => error);
    const next = (coordinator as any).persist() as Promise<void>;
    await vi.advanceTimersByTimeAsync(CONTROL_WRITE_DEADLINE_MS);
    const error = await refusal;
    expect(error).toBeInstanceOf(ControlWriteUnconfirmedError);
    expect(choiceNotSavedText(error, 1)).toContain('could not be confirmed');
    expect(coordinator.heldShards().map(h => h.shardId)).toEqual([1]);
    await next;
    expect(fake.upserts).toHaveLength(1);
    expect(JSON.parse(fake.upserts[0]).history[0].legs[0].heldForChoice.lostNodeName).toBe('lost');
  });

  it('is answered as could not be confirmed, never as refused or nothing changed', () => {
    const late = new ControlWriteUnconfirmedError('the control-store write');
    expect(refusedWriteNote(new ControlWriteError(false, late))).toMatch(/^the plan write could not be confirmed .*it can still land/);
    expect(refusedWriteNote(new ControlWriteError(true, late))).toMatch(/^the plan landed; the registry write could not be confirmed/);
    expect(declareNotDoneText(late, 'w1')).toBe('w1 is not declared lost here: the migration record write could not be confirmed (the control-store write was not answered within 45s; it can still land); declare it lost again');
    for (const text of [refusedWriteNote(new ControlWriteError(false, late)), declareNotDoneText(late, 'w1'), choiceNotSavedText(late, 1)]) {
      expect(text).not.toMatch(/refused|nothing changed|not saved/);
    }
    expect(declareNotDoneText(new Error('EIO'), 'w1')).toBe('w1 is not declared lost: the control store refused the migration record (EIO); nothing changed, try again');
  });
});
