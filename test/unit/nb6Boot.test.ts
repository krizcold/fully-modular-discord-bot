import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootShared, sharedBootCause, sharedBootDone, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { lost } from '../helpers/sharedRows';

// NB6 test 8's rows 47 to 49 at bootShared (wip-redesign/sheets/NB6.md: decision 14, C24's ending paths, D9 and E3;
// part 8): the boot's wait for the database before the populate, its 5 s retries and 30 s log, its end at a stop,
// and the cause the child's gate reads. Row 49 and the order in runBot are in nb6BootOrder.test.ts.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6boot');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const waits = () => m.state.lines.filter(l => l.startsWith('[Shared] Waiting for the database to bring the shared files up to date ('));
const endHold = () => m.state.pg.backend.confirmHold((m.state.pg.backend as unknown as { epoch: number }).epoch);

beforeEach(() => m.setup());
afterEach(() => m.teardown());

describe('the boot pass', () => {
  it('row 46\'s first step: a database that answers brings every mirror up to date, and bootShared ends', async () => {
    m.state.rows.put(m.keyOf('a.json'), text({ a: 1 }));
    expect(sharedBootDone()).toBe(false);
    await expect(bootShared()).resolves.toBe('done');
    expect(m.read('a.json')).toBe(text({ a: 1 }));
    expect(sharedBootDone()).toBe(true);
    expect(sharedBootCause()).toBeNull();
    expect(waits()).toEqual([]);
  });

  it('a JSON bot has nothing to bring up to date: done at once, and sharedBootDone is true', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('file');
    expect(sharedBootDone()).toBe(true);
    await expect(bootShared()).resolves.toBe('done');
  });
});

describe('row 47: the database does not answer', () => {
  it('logs decision 14\'s line at once and every 30 s, retries every 5 s, and ends once the database answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    m.state.rows.put(m.keyOf('b.json'), text({ b: 1 }));
    let down = true;
    m.state.rows.fault = sql => (down && sql === LIST ? lost() : undefined);
    let ended: string | null = null;
    void bootShared().then(v => { ended = v; });
    await vi.advanceTimersByTimeAsync(0);
    expect(waits()).toHaveLength(1);
    expect(waits()[0]).toMatch(/^\[Shared\] Waiting for the database to bring the shared files up to date \(.+\); modules start once they are$/);
    expect(sharedBootCause()).not.toBeNull();
    expect(sharedBootDone()).toBe(false);
    const listings = () => m.sql().filter(s => s === LIST).length;
    const first = listings();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(waits()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(waits()).toHaveLength(2);
    expect(ended).toBeNull();
    down = false;
    endHold();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ended).toBe('done'));
    expect(listings()).toBeGreaterThan(first);
    expect(m.read('b.json')).toBe(text({ b: 1 }));
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootDone()).toBe(true);
  });

  it('E3: the cause is cleared once a try gets the database\'s answer, before the boot ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    m.state.rows.put(m.keyOf('c.json'), text({ c: 1 }));
    let down = true;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    m.state.rows.fault = sql => {
      if (down && sql === LIST) return lost();
      if (sql === BODY) return held.then(() => undefined);
      return undefined;
    };
    const boot = bootShared();
    await vi.advanceTimersByTimeAsync(0);
    expect(sharedBootCause()).not.toBeNull();
    down = false;
    endHold();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(m.sql()).toContain(BODY));
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootDone()).toBe(false);
    release();
    await expect(boot).resolves.toBe('done');
  });
});

describe('row 48: a stop during the wait', () => {
  it('ends the wait at the stop step: nothing more is read or written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    m.state.rows.put(m.keyOf('d.json'), text({ d: 1 }));
    m.state.rows.fault = sql => (sql === LIST ? lost() : undefined);
    let ended: string | null = null;
    void bootShared().then(v => { ended = v; });
    await vi.advanceTimersByTimeAsync(0);
    stopSharedPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe('stopped');
    const sent = m.sql().length;
    m.state.rows.fault = undefined;
    endHold();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.sql()).toHaveLength(sent);
    expect(m.read('d.json')).toBeNull();
    expect(sharedBootDone()).toBe(false);
  });
});
