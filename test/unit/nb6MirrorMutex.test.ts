import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 test 50 (wip-redesign/sheets/NB6.md rows 157 and 158 of round 2; decision 49's mirror mutex and its step 1 and
// step 5 re-checks; part 8): the pass against this process's own writes of a key, with the pass's row read held open
// by the scripted pool while the write is accepted or lands.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6mutex');
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';

beforeEach(() => m.setup());
afterEach(() => m.teardown());

describe('row 157: an op of the key during the pass\'s row read', () => {
  it('the re-check inside the mutex skips the key: the pass writes nothing over it', async () => {
    await m.landed('k.json', { v: 1 });
    m.state.rows.put(m.keyOf('k.json'), text({ v: 'theirs' }));
    let releaseRead!: () => void;
    let releaseFlush!: () => void;
    const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
    const flushHeld = new Promise<void>(resolve => { releaseFlush = resolve; });
    let readSeen!: () => void;
    const reading = new Promise<void>(resolve => { readSeen = resolve; });
    m.state.rows.fault = sql => {
      if (sql === BODY) {
        readSeen();
        return readHeld.then(() => undefined);
      }
      if (/^BEGIN/.test(sql)) return flushHeld.then(() => undefined);
      return undefined;
    };
    const pass = runSharedPass();
    await reading;
    dm.updateGlobalData('k.json', { v: 0 }, (current: any) => ({ v: `${current.v}+mine` }), 'nb6mutex');
    expect(rowQueue.ops(m.keyOf('k.json'))).toHaveLength(1);
    releaseRead();
    await pass;
    expect(m.read('k.json')).toBe(text({ v: 1 }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 1 })));
    releaseFlush();
    m.state.rows.fault = undefined;
    await dm.flushAll();
    expect(m.read('k.json')).toBe(text({ v: 'theirs+mine' }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 'theirs+mine' })));
  });
});

describe('row 158: a key this process wrote after the listing', () => {
  it('the no-row unlink re-reads the row under the mutex and finds it: nothing is removed', async () => {
    await m.landed('a.json', { v: 1 });
    await m.landed('k.json', { v: 1 });
    m.state.rows.put(m.keyOf('a.json'), text({ v: 'a2' }));
    m.state.rows.docs.delete(m.keyOf('k.json'));
    let releaseRead!: () => void;
    const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
    let readSeen!: () => void;
    const reading = new Promise<void>(resolve => { readSeen = resolve; });
    m.state.rows.fault = (sql, params) => {
      if (sql === BODY && params?.[0] === m.keyOf('a.json')) {
        readSeen();
        return readHeld.then(() => undefined);
      }
      return undefined;
    };
    const pass = runSharedPass();
    await reading;
    const res = dm.updateGlobalData<{ v: unknown }>('k.json', { v: 0 }, () => ({ v: 'again' }), 'nb6mutex') as { ticket?: RowTicket };
    await dm.flushAll();
    expect(rowTicketState(res.ticket!)).toBe('landed');
    expect(m.read('k.json')).toBe(text({ v: 'again' }));
    releaseRead();
    await pass;
    expect(fs.existsSync(m.file('k.json'))).toBe(true);
    expect(m.read('k.json')).toBe(text({ v: 'again' }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 'again' })));
    expect(m.read('a.json')).toBe(text({ v: 'a2' }));
    expect(m.superseded()).toEqual({});
  });
});
