import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { bytesOf, scriptedBackend } from '../helpers/scriptedPg';

// NB12 item 10 (wip-redesign/sheets/NB12.md, section 5 P2 x operator stop and P2 x lease removal): over the real
// PostgresBackend, a small flush is admitted beside a 2 MiB flush on the wire. The drain closes the facade for good,
// so this file runs the lease row first and the drain row last.

const MIB = 1024 * 1024;
const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const H = '9700000000';
const smalls = Array.from({ length: 50 }, (_, i) => String(9_700_000_001 + i));

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 60 s for a statement of 2 MiB or more, 100 ms for any other query, on the fake clock. */
async function rig() {
  setBackendKind('postgres');
  const pg = scriptedBackend((sql, params) => new Promise(resolve => {
    setTimeout(() => resolve(undefined), bytesOf({ sql, params, raw: sql }) >= 2 * MIB ? 60_000 : 100);
  }));
  const ws = initWorkingSet(pg.backend);
  for (const id of [H, ...smalls]) {
    const hydrated = ws.hydrate(id, token);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await hydrated).toBe('ready');
  }
  expect(ws.save(H, 'm', 'big.json', 'h'.repeat(2 * MIB))).toBe('accepted');
  const hFlush = ws.flushGuildNow(H, 120_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(pg.sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_data') && bytesOf(s) >= 2 * MIB)).toHaveLength(1);
  for (const id of smalls) expect(ws.save(id, 'm', 'small.json', 's'.repeat(1024))).toBe('accepted');
  const committed = (id: string) => pg.sent.some(s => s.sql.startsWith('INSERT INTO smdb_data.guild_data') && s.params?.[0] === id);
  return { pg, ws, hFlush, committed };
}

describe('P2 x lease removal', () => {
  it("with H's flush on the wire, a small guild's final flush commits within its 5 s and the set freezes with nothing dirty", async () => {
    const { ws, hFlush, committed } = await rig();
    const id = smalls[0];
    let done = false;
    const unload = ws.unloadToFrozenRetained(id).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(true);
    await unload;
    expect(committed(id)).toBe(true);
    const set = (ws as any).sets.get(id);
    expect(set.dirtyKeys.size).toBe(0);
    expect(set.state).toBe('frozen-retained');
    expect(ws.dirtyGuildIds()).toContain(H);
    await vi.advanceTimersByTimeAsync(120_000);
    await hFlush;
    for (const s of smalls.slice(1)) ws.evict(s);
    ws.evict(id);
    ws.evict(H);
  }, 30_000);
});

describe('P2 x operator stop', () => {
  it('drainForExit(30000) with H on the wire and 50 small dirty guilds leaves only H dirty, and its warning names H alone', async () => {
    const { ws, committed } = await rig();
    const drain = dm.drainForExit(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await drain;
    expect(ws.dirtyGuildIds()).toEqual([H]);
    for (const id of smalls) expect(committed(id)).toBe(true);
    const left = warnings.filter(w => w.startsWith('[Data] Shutdown drain left'));
    expect(left).toEqual([`[Data] Shutdown drain left 1 guild(s) with unflushed writes: ${H}`]);
  }, 30_000);
});
