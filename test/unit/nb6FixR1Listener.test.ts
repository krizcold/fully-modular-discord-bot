import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setListenClientFactory, startSharedListener, stopSharedListener, type ListenerDeps } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';

// NB6 code review round 1, lane B findings 5 and 6 (out/NB6/review1-B.md; ruled in part-rulings.md "Code review round
// 1"): the listener hands a 'module' notice to the pass, and a LISTEN that never answers is bounded like the check.

const CANT = "[Shared] Can't listen for changes from other machines";

let rig: ReturnType<typeof listenRig>;
let lines: string[];
let calls: { docs: string[]; modules: string[]; connected: number };

function deps(): ListenerDeps {
  return {
    entry: () => 'postgres://bot@db-a.example:5432/bot',
    onDoc: key => { calls.docs.push(key); },
    onModule: module => { calls.modules.push(module); },
    onConnected: () => { calls.connected += 1; },
    onGuildRequest: () => undefined,
  } as ListenerDeps;
}

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  rig = listenRig();
  calls = { docs: [], modules: [], connected: 0 };
  _setListenClientFactory(rig.factory as never);
});

afterEach(() => {
  stopSharedListener();
  _setListenClientFactory(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("B5: a 'module' notice", () => {
  it("of another process reaches onModule with the module's name; this process's own is skipped", async () => {
    startSharedListener(deps());
    await vi.advanceTimersByTimeAsync(0);
    const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
    rig.last().notify('smdb_shared', JSON.stringify({ k: 'module', module: 'm', sha: 'abc', rev: 3, by: 'p-bravo' }));
    rig.last().notify('smdb_shared', JSON.stringify({ k: 'module', module: 'own', sha: 'abc', rev: 4, by: processId() }));
    expect(calls.modules).toEqual(['m']);
    expect(calls.docs).toEqual([]);
  });
});

describe('B6: a LISTEN that never answers', () => {
  it('is dropped after 5 s with row 36\'s line, and the connect is tried again 5 s later', async () => {
    startSharedListener(deps());
    rig.last().answer = text => (text.startsWith('LISTEN') ? 'hang' : undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.connected).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines.filter(l => l.startsWith(CANT))).toEqual([`${CANT} (no answer within 5 s); this machine takes them at its check every 60 seconds until it can`]);
    expect(rig.clients[0].destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    expect(calls.connected).toBe(1);
  });
});
