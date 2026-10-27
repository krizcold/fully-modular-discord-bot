import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dataUnavailableMessage } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { appendData, deleteData, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { tokenFor } from '../helpers/fakeStore';
import { fakeClock, readinessRig, stopDrivers } from '../helpers/readinessRig';

// The acceptance window (notes/BT.md, "The acceptance-window job: design sheet (L0)"): its age is the oldest accepted
// write not yet in a landed flush, so a closure means a write has waited that long, or the backlog passed its bound,
// and the refusal says which.

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
});

const MIN = 60_000;
type Rig = ReturnType<typeof readinessRig>;
const health = (r: Rig) => r.ws.getBackendHealth();
/** The debounce fires; a flight goes on the wire (and lands at once unless the store holds it). */
const debounce = () => vi.advanceTimersByTimeAsync(600);
/** Every flight held on the wire comes off it with this outcome. */
async function release(r: Rig, mode: 'commit' | 'unavailable' | 'deposed' = 'commit') {
  r.store.mode = mode;
  r.store.release();
  await vi.advanceTimersByTimeAsync(0);
}
function thrown(fn: () => unknown): DataBackendUnavailableError {
  try { fn(); } catch (error) { return error as DataBackendUnavailableError; }
  throw new Error('nothing was thrown');
}
const verbs = {
  save: (guildId: string) => saveData('v.json', { guildId, category: 'm' }, { v: 1 }),
  append: (guildId: string) => appendData('v.log', { guildId, category: 'm' }, 'line\n'),
  delete: (guildId: string) => deleteData('v.json', { guildId, category: 'm' }),
};
const BACKLOG = (kib: number) => `[Data] Write acceptance is closed: unsaved writes hold ${kib} KiB (acceptance reopens below 32 MiB); the write was not saved`;

describe('the age of the oldest unsaved write', () => {
  it('a delete of a doc clean for over 5 minutes, on a healthy store, leaves acceptance open', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    expect(r.ws.save(g, 'm', 'old.json', '{"v":1}')).toBe('accepted');
    await debounce();
    expect(health(r).oldestDirtyMs).toBe(0);
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(r.ws.delete(g, 'm', 'old.json')).toBe('accepted');
    expect(health(r).state).not.toBe('refusing');
    expect(health(r).oldestDirtyMs).toBe(0);
    await debounce();
    expect(health(r).oldestDirtyMs).toBe(0);
  });

  it('a doc rewritten during each of many flights, each landing, keeps acceptance open', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'hot.json', '{"n":0}')).toBe('accepted');
    await debounce();
    for (let n = 1; n <= 12; n++) {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(r.ws.save(g, 'm', 'hot.json', `{"n":${n}}`)).toBe('accepted');
      await release(r);
      await debounce();
    }
    expect(health(r).state).not.toBe('refusing');
    expect(health(r).oldestDirtyMs).toBe(600);
  });

  it('an append stream written during each of many flights, each landing, keeps acceptance open', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 'hot.log', 'line 0\n')).toBe('accepted');
    await debounce();
    for (let n = 1; n <= 12; n++) {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(r.ws.append(g, 'm', 'hot.log', `line ${n}\n`)).toBe('accepted');
      await release(r);
      await debounce();
    }
    expect(health(r).state).not.toBe('refusing');
    expect(health(r).oldestDirtyMs).toBe(600);
  });

  it('a buffer a landing left empty takes a later append at that append\'s own time', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 'mixed.log', 'line 1\n')).toBe('accepted');
    await debounce();
    expect(r.ws.save(g, 'm', 'mixed.log', '{}')).toBe('accepted');
    await release(r);
    await debounce();
    await release(r);
    expect(health(r).oldestDirtyMs).toBe(0);
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(r.ws.append(g, 'm', 'mixed.log', 'line 2\n')).toBe('accepted');
    expect(health(r).state).not.toBe('refusing');
    expect(health(r).oldestDirtyMs).toBe(0);
  });

  it('a key re-dirtied mid-flight reads its re-dirty\'s age once the flight lands, not its first write\'s or the landing\'s', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'k.json', '{"v":1}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(r.ws.save(g, 'm', 'k.json', '{"v":2}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(health(r).oldestDirtyMs).toBe(150_600);
    await release(r);
    expect(health(r).oldestDirtyMs).toBe(50_000);
  });

  it('a key re-dirtied only by its append stream leaves its doc with no age once the flight lands', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'both.log', '{}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(r.ws.append(g, 'm', 'both.log', 'line\n')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(50_000);
    await release(r);
    expect(health(r).oldestDirtyMs).toBe(50_000);
  });

  it('a flight on the wire keeps its writes\' age, and one hung over 5 minutes closes acceptance until it lands', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(health(r).oldestDirtyMs).toBe(100_600);
    await vi.advanceTimersByTimeAsync(201_000);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(r.ws.save(g, 'm', 'b.json', '{}')).toBe('accepted');
    expect(errors.mock.calls.map(call => String(call[0]))).toEqual([
      '[Data] Write acceptance CLOSED (backlog 0 KiB, oldest 302s); guild writes are refused until unsaved writes are under 32 MiB and none has waited 300 s',
    ]);
    errors.mockRestore();
    expect(health(r).state).toBe('refusing');
    expect(r.ws.save(g, 'm', 'c.json', '{}')).toBe('refusing');
    await release(r);
    expect(health(r).state).toBe('healthy');
  });

  it('a refused flush keeps every write\'s age', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(r.store.flushesSent).toBeGreaterThan(1);
    expect(health(r).oldestDirtyMs).toBe(100_000);
  });

  it('a refused flush degrades health, and its landing restores it with no reopen logged, as acceptance never closed', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await debounce();
    expect(health(r).state).toBe('degraded');
    r.store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(31_000);
    expect(health(r).state).toBe('healthy');
    expect(warns.mock.calls.filter(call => String(call[0]).includes('Write acceptance reopened'))).toEqual([]);
    warns.mockRestore();
  });
});

describe('a closure and what it says', () => {
  it('a store failing every flush for over 5 minutes closes acceptance, names the age, and a landing reopens it', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    expect(health(r).state).toBe('refusing');
    const error = thrown(() => saveData('b.json', { guildId: g, category: 'm' }, { v: 1 }));
    expect(error.causeKey).toBe('database-backlog');
    expect(error.message).toMatch(/^\[Data\] Write acceptance is closed: the oldest unsaved write has waited 33\d s \(acceptance reopens below 300 s\); the write was not saved$/);
    r.store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(31_000);
    expect(health(r).state).toBe('healthy');
    expect(health(r).oldestDirtyMs).toBe(0);
  });

  it('a closure is logged once, not again at each failed retry while it stays closed', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    expect(health(r).state).toBe('refusing');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.store.flushesSent).toBeGreaterThan(12);
    expect(errors.mock.calls.filter(call => String(call[0]).includes('Write acceptance CLOSED'))).toHaveLength(1);
    errors.mockRestore();
  });

  it('a backlog over 64 MiB closes acceptance and names the bytes', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'big.json', 'x'.repeat(65 * 1024 * 1024))).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    const error = thrown(() => saveData('b.json', { guildId: g, category: 'm' }, { v: 1 }));
    expect(error.causeKey).toBe('database-backlog');
    expect(error.message).toBe(BACKLOG(66560));
  });

  it('a backlog closure drained below 64 MiB but not below 32 MiB stays closed, and says so; under 32 MiB it reopens', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g1, 'm', 'big.json', 'x'.repeat(40 * 1024 * 1024))).toBe('accepted');
    expect(r.ws.save(g2, 'm', 'big.json', 'x'.repeat(25 * 1024 * 1024))).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    r.ws.evict(g2);
    expect(health(r).dirtyBytes).toBe(40 * 1024 * 1024);
    const error = thrown(() => saveData('b.json', { guildId: g1, category: 'm' }, { v: 1 }));
    expect(error.causeKey).toBe('database-backlog');
    expect(error.message).toBe(BACKLOG(40960));
    r.ws.evict(g1);
    const g3 = await r.ready();
    expect(r.ws.save(g3, 'm', 'a.json', '{}')).toBe('accepted');
  });

  it('an age closure with a backlog of exactly 32 MiB names both bounds', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'big.json', 'x'.repeat(32 * 1024 * 1024))).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    expect(health(r).state).toBe('refusing');
    const error = thrown(() => saveData('b.json', { guildId: g, category: 'm' }, { v: 1 }));
    expect(error.causeKey).toBe('database-backlog');
    expect(error.message).toMatch(/^\[Data\] Write acceptance is closed: unsaved writes hold 32768 KiB \(acceptance reopens below 32 MiB\) and the oldest unsaved write has waited 33\d s \(acceptance reopens below 300 s\); the write was not saved$/);
  });

  it.each(['save', 'append', 'delete'] as const)('%s while the backlog holds acceptance closed throws database-backlog with the window\'s text', async verb => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'v.json', 'x'.repeat(65 * 1024 * 1024))).toBe('accepted');
    const error = thrown(() => verbs[verb](g));
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-backlog');
    expect(error.message).toBe(BACKLOG(66560));
  });

  it.each([
    ['node-stopping', 'The bot is restarting, so your change was not saved. Please try again in a moment.'],
    ['database-backlog', "The bot's database is behind on saving changes, so your change was not saved. Please try again in a moment."],
    ['guild-fenced', "Another bot process took over this server's data; please try again in a moment."],
    ['database-unreachable', "The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support."],
  ] as const)('a handler\'s refusal for %s tells the member its own cause', (cause, text) => {
    expect(dataUnavailableMessage(cause)).toBe(text);
  });

  it('a backlog closure tells the member the database is behind, not unreachable', () => {
    expect(dataUnavailableMessage('database-backlog')).toBe("The bot's database is behind on saving changes, so your change was not saved. Please try again in a moment.");
    expect(truthText('database-backlog', false)).toBe("The bot's database is behind on saving changes, so your change was not saved. Please try again in a moment.");
    expect(truthText('database-backlog', true)).toBe("The bot's database is behind on saving changes, so your change was not saved in full. Please try again in a moment.");
  });
});

describe('acceptance reopens once what closed it has left, landed or not', () => {
  it('a hung flight\'s closure, then that flight deposed: a write to another guild is accepted', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g1, 'm', 'a.json', '{}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(r.ws.save(g1, 'm', 'b.json', '{}')).toBe('accepted');
    expect(r.ws.save(g2, 'm', 'c.json', '{}')).toBe('refusing');
    await release(r, 'deposed');
    expect(r.ws.stateOf(g1)).toBe('fenced');
    expect(r.ws.save(g2, 'm', 'c.json', '{}')).toBe('accepted');
    expect(health(r).state).not.toBe('refusing');
  });

  it('a failing store\'s closure, then a deposition: a write to another guild is accepted', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g1, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    expect(r.ws.save(g2, 'm', 'c.json', '{}')).toBe('refusing');
    r.store.mode = 'deposed';
    // Until the next retry comes back deposed (its fenced set is evicted 30 s later).
    for (let s = 0; s < 31 && r.ws.stateOf(g1) !== 'fenced'; s++) await vi.advanceTimersByTimeAsync(1000);
    expect(r.ws.stateOf(g1)).toBe('fenced');
    expect(r.ws.save(g2, 'm', 'c.json', '{}')).toBe('accepted');
    // No flush has landed since the store failed, and the deposition's error stands.
    expect(health(r).state).toBe('degraded');
  });

  it('a reopen is logged with what still waits, at the write gate or the health read', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    const g3 = await r.ready();
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.store.holding = true;
    expect(r.ws.save(g1, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(290_000);
    expect(r.ws.save(g2, 'm', 'b.json', 'x'.repeat(2048))).toBe('accepted');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.ws.save(g3, 'm', 'c.json', '{}')).toBe('accepted');
    expect(r.ws.save(g3, 'm', 'd.json', '{}')).toBe('refusing');
    await vi.advanceTimersByTimeAsync(4000);
    r.ws.evict(g1);
    expect(r.ws.save(g3, 'm', 'd.json', '{}')).toBe('accepted');
    expect(warns.mock.calls.map(call => String(call[0])).filter(text => text.includes('Write acceptance reopened')))
      .toEqual(['[Data] Write acceptance reopened: unsaved writes hold 2 KiB, the oldest waiting 15 s']);
    warns.mockRestore();
  });

  it('a landing that drains the backlog logs the reopen itself, before any write or health read', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    expect(health(r).state).toBe('refusing');
    r.store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.store.commits.length).toBeGreaterThan(0);
    expect(warns.mock.calls.map(call => String(call[0])).filter(text => text.includes('Write acceptance reopened')))
      .toEqual(['[Data] Write acceptance reopened: unsaved writes hold 0 KiB, the oldest waiting 0 s']);
    warns.mockRestore();
  });

  it.each([
    [1, 'refusing'],
    [2, 'healthy'],
  ] as const)('a write that has waited 300 s holds acceptance closed, and one under it does not (the second write %i ms later)', async (later, state) => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    const g3 = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g1, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(later);
    expect(r.ws.save(g2, 'm', 'b.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(300_001 - later);
    expect(r.ws.save(g3, 'm', 'c.json', '{}')).toBe('accepted');
    expect(r.ws.save(g3, 'm', 'd.json', '{}')).toBe('refusing');
    r.ws.evict(g1);
    expect(health(r).state).toBe(state);
    if (state === 'refusing') {
      const error = thrown(() => saveData('e.json', { guildId: g3, category: 'm' }, { v: 1 }));
      expect(error.causeKey).toBe('database-backlog');
      expect(error.message).toBe('[Data] Write acceptance is closed: the oldest unsaved write has waited 300 s (acceptance reopens below 300 s); the write was not saved');
    }
  });

  it('a backlog of exactly 32 MiB holds acceptance closed, and one byte less does not', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    const g3 = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g1, 'm', 'a.json', 'x'.repeat(32 * 1024 * 1024 - 1))).toBe('accepted');
    expect(r.ws.append(g3, 'm', 'one.log', 'x')).toBe('accepted');
    expect(r.ws.save(g2, 'm', 'b.json', 'x'.repeat(33 * 1024 * 1024))).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    r.ws.evict(g2);
    expect(health(r).dirtyBytes).toBe(32 * 1024 * 1024);
    expect(health(r).state).toBe('refusing');
    r.ws.evict(g3);
    expect(health(r).state).not.toBe('refusing');
  });

  it('an evicted set\'s hung flight: the health reads open again, and a write to another guild is accepted', async () => {
    fakeClock();
    const r = readinessRig();
    const g1 = await r.ready();
    const g2 = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g1, 'm', 'a.json', '{}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(r.ws.save(g1, 'm', 'b.json', '{}')).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    r.ws.evict(g1);
    expect(health(r).state).not.toBe('refusing');
    expect(r.ws.save(g2, 'm', 'c.json', '{}')).toBe('accepted');
  });
});

describe('the backlog is what waits unsaved', () => {
  it('a deposed flight\'s bytes leave the backlog', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'a.json', 'x'.repeat(1000))).toBe('accepted');
    await debounce();
    expect(health(r).dirtyBytes).toBe(1000);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await release(r, 'deposed');
    errors.mockRestore();
    expect(health(r).dirtyBytes).toBe(0);
    // Acceptance never closed, and a deposition is not a failing store.
    expect(health(r).state).toBe('healthy');
  });

  it('the backlog counts the bytes stored, not the characters', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 's.log', '\u4e00'.repeat(512))).toBe('accepted');
    await debounce();
    expect(r.ws.append(g, 'm', 's.log', '\u4e00'.repeat(256))).toBe('accepted');
    expect(r.ws.save(g, 'm', 'x.json', '\u4e00'.repeat(1024))).toBe('accepted');
    expect(health(r).dirtyBytes).toBe(1536 + 768 + 3072);
    await release(r);
    expect(health(r).dirtyBytes).toBe(768 + 3072);
  });

  it('a store that answers yet holds every flush for 5 minutes refuses as behind, never as unreachable', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(331_000);
    // A held flush degrades nothing: the write that finds the oldest past 300 s is taken, and closes acceptance.
    expect(r.ws.save(g, 'm', 'b.json', '{}')).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    const error = thrown(() => saveData('c.json', { guildId: g, category: 'm' }, { v: 1 }));
    expect(error.causeKey).toBe('database-backlog');
    expect(dataUnavailableMessage(error.causeKey)).not.toMatch(/unreachable/);
  });

  it('a tombstone waiting to land holds no bytes', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'a.json', 'abcd')).toBe('accepted');
    expect(r.ws.delete(g, 'm', 'a.json')).toBe('accepted');
    expect(health(r).dirtyBytes).toBe(0);
  });

  it('a delete that drops a buffer on the wire neither counts it twice nor keeps it', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 's.log', 'abcd')).toBe('accepted');
    await debounce();
    expect(r.ws.save(g, 'm', 'other.json', '123456')).toBe('accepted');
    expect(r.ws.delete(g, 'm', 's.log')).toBe('accepted');
    expect(health(r).dirtyBytes).toBe(6);
    await release(r);
    expect(health(r).dirtyBytes).toBe(6);
    await debounce();
    await release(r);
    expect(health(r).dirtyBytes).toBe(0);
  });
});

describe('the default texts', () => {
  it.each([
    ['guild-fenced', '[Data] Another bot process took over this guild; the write was not saved'],
    ['node-stopping', '[Data] This process is stopping and its exit drain has closed; the write was not saved'],
    ['database-unreachable', '[Data] The data backend is unreachable; the write was not saved'],
    ['database-backlog', '[Data] The data backend is behind on storing writes; the write was not saved'],
  ] as const)('%s, with no buffer named where none is involved (the graveyard paths)', (cause, text) => {
    expect(new DataBackendUnavailableError(cause).message).toBe(text);
    expect(new DataBackendUnavailableError(cause).name).toBe('DataBackendUnavailableError');
    expect(new DataBackendUnavailableError(cause, 'a detail').message).toBe('a detail');
  });
});

describe('the bounds, exactly', () => {
  it('a backlog of exactly 64 MiB keeps acceptance open, and one byte more closes it', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.save(g, 'm', 'big.json', 'x'.repeat(64 * 1024 * 1024))).toBe('accepted');
    expect(health(r).state).not.toBe('refusing');
    expect(r.ws.append(g, 'm', 'one.log', 'x')).toBe('accepted');
    expect(health(r).state).toBe('refusing');
  });

  it('an oldest write of exactly 300 s keeps acceptance open, and one millisecond more closes it', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'a.json', '{}')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(300_000 - 600);
    expect(r.ws.save(g, 'm', 'b.json', '{}')).toBe('accepted');
    expect(health(r).state).not.toBe('refusing');
    await vi.advanceTimersByTimeAsync(1);
    expect(r.ws.save(g, 'm', 'c.json', '{}')).toBe('accepted');
    expect(health(r).state).toBe('refusing');
  });
});

describe('the write paths, each', () => {
  it('a delete mid-flight reads its own age once the flight lands', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.save(g, 'm', 'gone.json', '{}')).toBe('accepted');
    await debounce();
    expect(r.ws.delete(g, 'm', 'gone.json')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(50_000);
    await release(r);
    expect(health(r).oldestDirtyMs).toBe(50_000);
  });

  it('a delete keeps the age of the lines it drops: a line on a hung wire, deleted at 250 s, closes acceptance past 300 s', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.holding = true;
    expect(r.ws.append(g, 'm', 's.log', 'line\n')).toBe('accepted');
    await debounce();
    await vi.advanceTimersByTimeAsync(249_400);
    expect(r.ws.delete(g, 'm', 's.log')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(51_000);
    expect(health(r).oldestDirtyMs).toBe(301_000);
    expect(r.ws.save(g, 'm', 'x.json', '{}')).toBe('accepted');
    expect(health(r).state).toBe('refusing');
    await release(r);
    expect(health(r).oldestDirtyMs).toBe(51_000);
    expect(health(r).state).toBe('healthy');
  });

  it('a delete of a stream whose lines wait unsent keeps their age until the delete lands', async () => {
    fakeClock();
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'unavailable';
    expect(r.ws.append(g, 'm', 's.log', 'line\n')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(r.ws.delete(g, 'm', 's.log')).toBe('accepted');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(health(r).oldestDirtyMs).toBe(110_000);
    r.store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(31_000);
    expect(health(r).oldestDirtyMs).toBe(0);
    expect(r.store.commits.length).toBeGreaterThan(0);
  });

  it('a doc read from the store is clean: a save over it counts only its own bytes', async () => {
    const r = readinessRig();
    const g = await r.ready();
    expect(r.ws.save(g, 'm', 'stored.json', '0123456789')).toBe('accepted');
    expect(await r.ws.flushGuildNow(g, 1000)).toBe('ok');
    r.ws.evict(g);
    expect(await r.ws.hydrate(g, tokenFor())).toBe('ready');
    expect(r.ws.save(g, 'm', 'stored.json', 'abcd')).toBe('accepted');
    expect(health(r).dirtyBytes).toBe(4);
  });

  it('a tombstone holds no bytes: a save over a stream\'s delete counts only its own', async () => {
    const r = readinessRig();
    const g = await r.ready();
    expect(r.ws.append(g, 'm', 'stream.log', 'line\n')).toBe('accepted');
    expect(await r.ws.flushGuildNow(g, 1000)).toBe('ok');
    expect(r.ws.delete(g, 'm', 'stream.log')).toBe('accepted');
    expect(r.ws.save(g, 'm', 'stream.log', 'abcd')).toBe('accepted');
    expect(health(r).dirtyBytes).toBe(4);
  });
});

describe('the facade\'s refusals, per verb', () => {
  it.each(Object.keys(verbs) as (keyof typeof verbs)[])('%s on a fenced set throws guild-fenced', async verb => {
    const r = readinessRig();
    const g = await r.ready();
    r.store.mode = 'deposed';
    expect(r.ws.save(g, 'm', 'x.json', '{}')).toBe('accepted');
    await r.ws.flushGuildNow(g, 1000);
    expect(r.ws.stateOf(g)).toBe('fenced');
    const error = thrown(() => verbs[verb](g));
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('guild-fenced');
  });
});

describe('the scenario the oracle saw live', () => {
  it('two guilds: a write stream on one and a delete of a doc on the other written 6 minutes earlier, none refused', async () => {
    fakeClock();
    const r = readinessRig();
    const quiet = await r.ready();
    const busy = await r.ready();
    expect(r.ws.save(quiet, 'm', 'old.json', '{"v":1}')).toBe('accepted');
    await debounce();
    const answers: string[] = [];
    for (let n = 0; n < 40; n++) {
      answers.push(r.ws.save(busy, 'm', `doc-${n % 5}.json`, `{"n":${n}}`) as string);
      if (n === 36) {
        // The live closure lasted until the delete's own flush landed: a write in that moment was refused.
        answers.push(r.ws.delete(quiet, 'm', 'old.json') as string);
        answers.push(r.ws.save(busy, 'm', 'right-after.json', '{}') as string);
      }
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(answers.filter(answer => answer !== 'accepted')).toEqual([]);
    expect(health(r).state).not.toBe('refusing');
    expect(r.store.doc(quiet, 'old.json')).toBeUndefined();
  });
});

describe('the age against a model', () => {
  const FILES = ['a.json', 'b.json', 'c.log'];
  type Op =
    | { kind: 'save' | 'delete' | 'append'; key: number }
    | { kind: 'advance'; ms: number }
    | { kind: 'land' | 'fail' };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constantFrom('save' as const, 'delete' as const, 'append' as const), key: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 120_000 }) }),
    fc.record({ kind: fc.constantFrom('land' as const, 'fail' as const) }),
  );

  it('oldestDirtyMs is the age of the oldest accepted write no landed flush holds, after every step', async () => {
    fakeClock();
    await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 40 }), async ops => {
      const r = readinessRig();
      try {
        const g = await r.ready();
        r.store.holding = true;
        // Each accepted write until a landed flush holds it: a doc write by its key, an appended line by its key. A
        // line a delete dropped waits until a landed flush holds it or that delete.
        let pending: { id: number; at: number; key: number; line: boolean; deletedBy?: number }[] = [];
        let batch: Set<number> | null = null;
        let ids = 0;
        for (const step of ops) {
          const sent = r.store.flushesSent;
          const landed = r.store.commits.length;
          if (step.kind === 'save' || step.kind === 'delete' || step.kind === 'append') {
            const file = FILES[step.key];
            const answer = step.kind === 'save' ? r.ws.save(g, 'm', file, `{"n":${ids}}`)
              : step.kind === 'delete' ? r.ws.delete(g, 'm', file)
                : r.ws.append(g, 'm', file, `line ${ids}\n`);
            if (answer === 'accepted') {
              const id = ++ids;
              if (step.kind === 'delete') for (const p of pending) if (p.key === step.key && p.line) p.deletedBy ??= id;
              pending.push({ id, at: Date.now(), key: step.key, line: step.kind === 'append' });
            }
          } else if (step.kind === 'advance') {
            await vi.advanceTimersByTimeAsync(step.ms);
          } else if (batch) {
            await release(r, step.kind === 'land' ? 'commit' : 'unavailable');
          }
          if (r.store.commits.length > landed) {
            const held = batch;
            pending = pending.filter(p => !held?.has(p.id) && !(p.deletedBy !== undefined && held?.has(p.deletedBy)));
            batch = null;
          } else if (step.kind === 'fail' && batch && r.store.flushesSent === sent) {
            batch = null;
          }
          if (r.store.flushesSent > sent) batch = new Set(pending.map(p => p.id));
          const oldest = pending.length > 0 ? Date.now() - Math.min(...pending.map(p => p.at)) : 0;
          expect(health(r).oldestDirtyMs).toBe(oldest);
        }
      } finally {
        r.store.mode = 'commit';
        r.store.release();
        stopDrivers();
      }
    }), { numRuns: 60 });
  });
});
