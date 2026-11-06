import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lossLine, releaseFailureLine, releaseLines, ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { aboveReason, claimState, claimTimings, type ClaimRow, type NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';
import type { FailureClass } from '../../src/bot/internalSetup/fleet/claimStore';
import { describeShardRow, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { mount } from '../helpers/jsxRig';

// NB4 decisions 9, 12, 16 and 21: every operator line built from what the database returned.

const pair = (shardId: number, claim: number) => ({ shardCount: 4, shardId, claim });

describe("decision 16's loss lines", () => {
  const row = (takenAt: number, holderProcess = 'p-b') => ({ row: { claim: 20, holderName: 'B', holderProcess, takenAt }, storedCount: 4 });

  it('a row taken after this process last renewed the pair carries the taken clause', () => {
    expect(lossLine(pair(1, 7), row(2000), '', 'p-a', 1000)).toBe("[Shards] Shard 1's claim row holds claim 20 of B (process p-b), not this process's claim 7; it was taken while this process could not renew it");
  });

  it('a row a restore raised (taken before the last renewal) has no taken clause', () => {
    expect(lossLine(pair(1, 7), row(500), '', 'p-a', 1000)).toBe("[Shards] Shard 1's claim row holds claim 20 of B (process p-b), not this process's claim 7");
  });

  it('no row after a count change, and a row that could not be read', () => {
    expect(lossLine(pair(1, 7), { row: null, storedCount: 8 }, '', 'p-a', 1000)).toBe("[Shards] Shard 1 has no claim row under 4 shards (the database now runs 8); this process's claim 7 is gone");
    expect(lossLine(pair(1, 7), null, 'timeout', 'p-a', 1000)).toBe('[Shards] Shard 1 is no longer held by this process; its claim row could not be read (timeout)');
  });
});

describe("decision 12's release lines", () => {
  it('kept, reserved, handed and no longer held, from what the statement returned', () => {
    const lines = releaseLines([pair(0, 5), pair(2, 6), pair(3, 9), pair(1, 8)], [pair(3, 9)], [
      { shardId: 0, claim: 5, wasReserved: false, handedTo: null },
      { shardId: 2, claim: 6, wasReserved: false, handedTo: 'C' },
      { shardId: 3, claim: 9, wasReserved: true, handedTo: null },
    ], 30_000);
    expect(lines).toEqual([
      "[Shards] Released shards 0: kept for this machine's next start for 30 s, then free to any machine with room",
      "[Shards] Reserved shards 3 stay kept for this machine's next start for 30 s, then free to any machine with room",
      '[Shards] Handed shard 2 to C',
      '[Shards] Shard 1 was no longer held by this process at the release',
    ]);
  });

  it('an empty list prints no Released or Reserved line', () => {
    expect(releaseLines([], [], [], 30_000)).toEqual([]);
  });

  it.each([
    [{ kind: 'unreachable', detail: 'x' }, false, 'unreachable'],
    [{ kind: 'unreachable', detail: 'x' }, true, 'unreachable'],
    [{ kind: 'timeout' }, true, 'timeout'],
    [{ kind: 'refused' }, false, 'refused'],
    [{ kind: 'error', code: '55P03', message: 'canceling statement due to lock timeout' }, true, 'error: SQLSTATE 55P03 canceling statement due to lock timeout'],
  ] as Array<[FailureClass, boolean, string]>)('a failure with no pair asked (%o, COMMIT sent: %s) names no shard and no take', (failure, sent, cause) => {
    expect(releaseFailureLine([], failure, sent)).toBe(`[Shards] The release did not complete (${cause}); any shard row still naming this process frees once its claim expires`);
  });
});

describe("decision 9's refusal shard part", () => {
  it.each([
    [{ claim: 9, holder_name: 'B', released: false, reserved: false }, 'shard 1 of 4 is held by claim 9 (B)'],
    [{ claim: 9, holder_name: 'B', released: true, reserved: true }, 'shard 1 of 4 is reserved by claim 9 (B) for its restart'],
    [{ claim: 9, holder_name: 'A', released: true, reserved: false }, 'shard 1 of 4 was released by claim 9 (kept for A)'],
    [undefined, 'shard 1 of 4 has no claim row'],
  ])('%s', (row, text) => {
    expect(describeShardRow(1, 4, row)).toBe(text);
  });
});

describe("decision 16's drop line", () => {
  it('names each guild and the count, and adds the may-have-landed clause for a COMMIT with no answer, kept through a check that failed with 53300', async () => {
    const store = new FakeStore();
    const ws = new WorkingSetManager(store);
    const g = '999';
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    ws.save(g, 'm', 'a.json', '1');
    const real = store.flushGuild.bind(store);
    let answer: any = { ok: false, reason: 'unavailable', commitUnanswered: true };
    store.flushGuild = (async (...args: Parameters<typeof real>) => { await real(...args); return answer; }) as any;
    await ws.flushGuildNow(g, 50);
    store.checkMode = 'unknown';
    store.checkCode = '53300';
    store.checkDetail = 'too many connections';
    expect(await ws.flushGuildNow(g, 50)).toBe('pending');
    store.checkMode = 'answer';
    store.takeOver(g, true);
    await ws.flushGuildNow(g, 50);
    expect(ws.takeDropLines()).toEqual([`[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: ${g}; guild(s) ${g} had a save whose answer never came, so some of these changes may have landed`]);
    expect(ws.takeDropLines()).toEqual([]);
    ws.evict(g);
  });

  describe('through a real PostgresBackend whose COMMIT got a server answer (NB4-R3-DL-1)', () => {
    const backends: PostgresBackend[] = [];
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const b of backends.splice(0)) await b.stop();
    });

    async function dropAfter(commitError: Error, afterTake: 'deposed' | 'unavailable'): Promise<string[]> {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
      backends.push(backend);
      (backend as unknown as { state: string }).state = 'ready';
      let phase: 'hydrate' | 'commit-fails' | 'taken' = 'hydrate';
      const client = {
        query: async (config: string | { text: string }) => {
          const q = (typeof config === 'string' ? config : config.text).trim();
          if (/INSERT INTO smdb_data\.guild_ownership AS o/.test(q)) return { rows: [], rowCount: phase === 'taken' ? 0 : 1 };
          if (q === 'COMMIT' && phase === 'commit-fails') throw commitError;
          if (phase === 'taken' && /^SELECT claim, last_flush[\s\S]*FOR SHARE$/.test(q)) return { rows: [{ claim: '20', last_flush: '00000000-0000-4000-8000-000000000000' }], rowCount: 1 };
          if (/SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(q)) return { rows: [{ node_id: 'node-b', claim: '20' }], rowCount: 1 };
          if (/FROM smdb_data\.shard_claims WHERE shard_count = \$1 AND shard_id = \$2/.test(q)) return { rows: [{ claim: '20', holder_name: 'B', released: false, reserved: false }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
      (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
      const ws = new WorkingSetManager(backend);
      const g = '777';
      expect(await ws.hydrate(g, { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 3, shardCount: 4 })).toBe('ready');
      ws.save(g, 'm', 'a.json', '1');
      phase = 'commit-fails';
      expect(await ws.flushGuildNow(g, 50)).not.toBe('ok');
      // NB5 decision 13: a COMMIT that ended the session starts the hold; the chooser's confirmation ends it.
      backend.noteEntryAnswered(backend.databaseEpoch());
      backend.confirmHold(backend.databaseEpoch());
      phase = 'taken';
      expect(await ws.flushGuildNow(g, 50)).toBe(afterTake);
      const lines = ws.takeDropLines();
      ws.evict(g);
      return lines;
    }

    it.each(['FATAL', 'PANIC'])('a COMMIT ended by a %s, then a deposed retry, carries the may-have-landed clause', async severity => {
      const lines = await dropAfter(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity }), 'unavailable');
      expect(lines).toEqual(['[Shards] 1 unsaved change(s) of 1 guild(s) of shard 3 were dropped: 777; guild(s) 777 had a save whose answer never came, so some of these changes may have landed']);
    });

    it('a COMMIT answered with an ERROR, then a deposed retry, has no such clause', async () => {
      const lines = await dropAfter(Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' }), 'deposed');
      expect(lines).toEqual(['[Shards] 1 unsaved change(s) of 1 guild(s) of shard 3 were dropped: 777']);
    });
  });
});

describe("decision 21's page state and above-target reason", () => {
  const row = (over: Partial<ClaimRow>): ClaimRow => ({
    shardCount: 4, shardId: 0, claim: 5, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 100_000, extended: false, ...over,
  });
  const node = (over: Partial<NodeRow>): NodeRow => ({
    nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true,
    returns: true, seenAgoMs: 1000, healthyForMs: 400_000, ...over,
  });

  it('held, reserved within 3R, kept once the reservation is 3R old, expired, and expired-deferred', () => {
    expect(claimState(row({}), 0, undefined, 50_000).state).toBe('held');
    expect(claimState(row({ released: true, reserved: true }), 14_999, undefined, 50_000).state).toBe('reserved');
    expect(claimState(row({ released: true, reserved: true }), 15_000, undefined, 50_000).state).toBe('kept');
    expect(claimState(row({ released: true }), 0, undefined, 50_000).state).toBe('kept');
    expect(claimState(row({ expiresUpMs: 40_000 }), 0, undefined, 50_000).state).toBe('expired');
    const restarted = node({ nodeId: 'node-a', processId: 'p-new' });
    expect(claimState(row({ expiresUpMs: 40_000 }), 0, restarted, 50_000)).toEqual({ state: 'expired-deferred', deferredMs: 20_000 });
  });

  it('each above-target reason, the first that applies', () => {
    const a = node({ nodeId: 'node-a', nodeName: 'A', processId: 'p-a' });
    const rows = [row({ shardId: 0 }), row({ shardId: 1 }), row({ shardId: 2 })];
    expect(aboveReason({ ...a, restartable: false }, [a], rows, 0).kind).toBe('no-web-ui');
    expect(aboveReason({ ...a, returns: false }, [a], rows, 0).kind).toBe('returns-off');
    expect(aboveReason(a, [a, node({ capacity: 2 })], rows, 0)).toEqual({ kind: 'moving', to: 'B' });
    expect(aboveReason(a, [a, node({ capacity: 2, healthyForMs: 100_000 })], rows, 0)).toEqual({ kind: 'waiting-healthy', name: 'B', leftMs: 200_000 });
    expect(aboveReason(a, [a, node({ capacity: 0 })], rows, 0).kind).toBe('no-room');
  });
});

const FLEET_VIEW = fileURLToPath(new URL('../../src/webui/public/components/usage/FleetView.jsx', import.meta.url));

/** The fleet page's claims card rendered from a fleet state, as its lines of text. */
function card(over: Record<string, unknown>): string[] {
  const fleet = { dataBackend: 'postgres', claims: [], nodes: [], claimsReadAgoMs: 1000, renewalError: null, stillConnected: [], pendingRestart: null, restartWaiting: null, ...over };
  const view = mount(FLEET_VIEW, 'FleetClaimsCard', { fleet }, {});
  return view.all(el => el.type === 'div' || el.type === 'td').map(el => view.text(el));
}
const claimRow = (over: Record<string, unknown>) => ({
  shardId: 3, claim: 17, holderName: 'B', holderNode: 'node-b', mine: false, homeName: 'B', state: 'held', expiresInMs: 24_000,
  expiredAgoMs: null, deferredMs: null, ...over,
});
const nodeRow = (over: Record<string, unknown>) => ({
  nodeId: 'node-a', name: 'A', target: 1, held: 3, fit: true, restartable: true, returns: true, healthyForMs: 400_000,
  seenAgoMs: 2000, takeoverSeconds: 30, aboveReason: null, ...over,
});

describe("the fleet page's claims texts (decision 21, section 10)", () => {
  it.each([
    [{ state: 'held', expiresInMs: 24_000 }, 'in 24s'],
    [{ state: 'reserved', expiresInMs: 24_000 }, 'reserved by B for its restart; not served meanwhile'],
    [{ state: 'kept', expiresInMs: 12_000 }, 'released: kept for B, or free to any machine in 12s'],
    [{ state: 'expired-deferred', expiresInMs: null, expiredAgoMs: 4_000, deferredMs: 26_000 }, "expired 4s ago: kept for B's restart for 26s more, then any machine with room may take it"],
    [{ state: 'expired', expiresInMs: null, expiredAgoMs: 4_000 }, 'expired 4s ago: any machine with room may take it'],
    [{ state: 'never-taken', holderName: null, claim: null, expiresInMs: null }, 'never taken'],
  ])('a %o row reads %s, and a reservation never reads released or a countdown', (row, text) => {
    const shown = card({ claims: [claimRow(row)] });
    expect(shown).toContain(text);
    if (row.state === 'reserved') expect(shown.some(l => /released|in \d+s$/.test(l))).toBe(false);
  });

  it.each([
    [{ kind: 'no-web-ui' }, '3 of target 1 (2 above target: it gives no shard away while it runs, having no web UI)'],
    [{ kind: 'returns-off' }, '3 of target 1 (2 above target: moves are off on this machine, FLEET_SHARD_RETURN=false)'],
    [{ kind: 'moving', to: 'B' }, '3 of target 1 (2 above target: moves to B when this machine restarts for it)'],
    [{ kind: 'waiting-healthy', name: 'B', leftMs: 200_000 }, '3 of target 1 (2 above target: moves to B once B has been healthy for 5 minutes, in 3m 20s)'],
    [{ kind: 'no-room' }, '3 of target 1 (2 above target: no other machine has room)'],
  ])('the Machines row for %o', (reason, text) => {
    expect(card({ nodes: [nodeRow({ aboveReason: reason })] })).toContain(text);
  });

  it.each([
    [{ kind: 'refused' }, 'Claims as last read 40s ago; the database refused the login'],
    [{ kind: 'timeout' }, 'Claims as last read 40s ago; the renewal timed out'],
    [{ kind: 'unreachable', detail: 'ECONNREFUSED' }, 'Claims as last read 40s ago; the database did not answer'],
    [{ kind: 'error', code: '53100', message: 'could not extend file' }, 'Claims as last read 40s ago; the database refused the renewal: SQLSTATE 53100 could not extend file'],
  ])('a failed renewal (%o) reads its cause', (renewalError, text) => {
    expect(card({ renewalError, claimsReadAgoMs: 40_000 })).toContain(text);
  });

  it('claims read long ago are shown as such even while renewals succeed (NB4-RUN-3)', () => {
    expect(card({ claimsReadAgoMs: 40_000, claimsStale: true })).toContain('Claims as last read 40s ago');
    expect(card({ claimsReadAgoMs: 1_000, claimsStale: false }).some(l => l.startsWith('Claims as last read'))).toBe(false);
    expect(card({ claimsReadAgoMs: 40_000, claimsStale: true, claimsReadError: { kind: 'timeout' } })).toContain('Claims as last read 40s ago; the claims read timed out');
  });

  it('the state marks claims read more than 2R ago as stale (NB4-RUN-3)', async () => {
    const { _setFleetStateSources, getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    const snapshot = { processId: 'p-a', held: [], reserved: [], page: null, pageReadAt: performance.now() - 11_000, renewalError: null, pageReadError: null, pendingRestart: null, restartWaiting: null, returning: [], stopped: null, renewMs: 5000 };
    const claims = { snapshot: () => snapshot } as any;
    const runtime = { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] } as any;
    const ledger = { getRecommendation: () => null, getBudgetInfo: () => null } as any;
    _setFleetStateSources({ nodeId: 'n', nodeName: 'N', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null, runtime, ingest: { getClient: () => null } as any, ledger, claims });
    expect(getFleetState()).toMatchObject({ claimsStale: true });
    snapshot.pageReadAt = performance.now() - 9_000;
    expect(getFleetState()).toMatchObject({ claimsStale: false });
  });

  it('a shard whose gateway stop did not settle', () => {
    expect(card({ stillConnected: [3] })).toContain('Shard 3 may still be connected to Discord');
  });

  it('a restart shows only once its request was sent; while it waits, the wait (NB4-DL-3, NB4-RUN-4)', () => {
    expect(card({ pendingRestart: 'take shard 3', restartWaiting: null })).toContain('Restarting to take shard 3');
    const waiting = card({ pendingRestart: 'take shard 3', restartWaiting: 'a save is failing' });
    expect(waiting).toContain('Restarting to take shard 3 (waiting: a save is failing)');
    expect(waiting).not.toContain('Restarting to take shard 3');
  });
});

describe('the boot take lines (decision 13, decision 10)', () => {
  function claims(store: MemClaimStore, capacity: number, log: string[]) {
    const sink = (line: unknown) => { log.push(String(line)); };
    return new ShardClaims({
      store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: claimTimings(30), capacity,
      takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0, fitness: () => null, gateClosed: () => false,
      isStopping: () => false, stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined,
      restartForShards: () => false, log: { log: sink, warn: sink, error: sink },
    });
  }

  it('the count line names the local and the stored count and its condition', async () => {
    const store = new MemClaimStore(() => 0);
    store.count = 2;
    store.rows.set('2:0', { shardCount: 2, shardId: 0, claim: 5, holderProcess: 'p-x', holderNode: 'node-x', holderName: 'X', homeNode: 'node-x', released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 100_000, extended: false });
    const log: string[] = [];
    const c = claims(store, 4, log);
    await c.firstRenewal();
    await c.bootTake(async () => 4);
    expect(log).toContain('[Shards] This machine resolves 4 shards; the database runs 2, and the count changes only when no machine holds a shard under 2: stop the bot on the other machines, then restart this one');
  });

  it('the above-target warnings: no other machine has room only for the rows above the room, and a kept row of this machine', async () => {
    const store = new MemClaimStore(() => 0);
    store.count = 3;
    store.rows.set('3:2', { shardCount: 3, shardId: 2, claim: 5, holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', released: true, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 100_000, extended: false });
    const log: string[] = [];
    const c = claims(store, 0, log);
    await c.firstRenewal();
    await c.bootTake(async () => 3);
    expect(log.filter(l => l.startsWith('[Shards] Taking shard'))).toEqual([
      "[Shards] Taking shard 2 above this machine's target (FLEET_SHARD_CAPACITY 0): it was this machine's shard",
      "[Shards] Taking shard 0 above this machine's target (FLEET_SHARD_CAPACITY 0): no other machine has room for it",
      "[Shards] Taking shard 1 above this machine's target (FLEET_SHARD_CAPACITY 0): no other machine has room for it",
    ]);
  });
});

describe("decision 6's stopped-serving text", () => {
  it('is the wording the sheet gives', () => {
    expect(STOPPED_SERVING_TEXT).toBe('This bot process stopped serving its shards (its claims lapsed or a shard was lost) and restarts once its unsaved changes are saved or reported in its log; try again after the restart');
  });
});
