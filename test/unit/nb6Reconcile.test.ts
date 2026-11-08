import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { runSharedPass, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, setView, T11, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 test 6 (wip-redesign/sheets/NB6.md section 5 rows 20, 28 and 42 to 45, row 44 as round 2 changes it, rows 98
// and 99 of round 1, row 100, row 162 of round 2; decisions 11, 21, 29, 30 and 49; part 8): the pass over every key,
// its main tag, and the 60 s timer that runs it whatever the listener's state.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6rec');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const moves = () => m.state.lines.filter(l => l.startsWith('[Shared] Moved'));
const destOf = (rel: string) => path.join(dataPath('_superseded'), ...rel.split('/'));

beforeEach(() => m.setup());
afterEach(async () => {
  _setListenClientFactory(null);
  await m.teardown();
});

describe('row 20: a crash after the mirror write, before the record', () => {
  it('the mirror equals the row: only the entry is written, the file is not touched', async () => {
    await m.landed('r20.json', { v: 1 });
    m.state.rows.put(m.keyOf('r20.json'), text({ v: 2 }));
    fs.writeFileSync(m.file('r20.json'), text({ v: 2 }));
    const ino = fs.statSync(m.file('r20.json')).ino;
    const res = await runSharedPass({ rehash: true });
    expect(res.answered).toBe(true);
    expect(m.entry('r20.json')).toMatchObject({ sha: sha(text({ v: 2 })) });
    expect(fs.statSync(m.file('r20.json')).ino).toBe(ino);
    expect(m.read('r20.json')).toBe(text({ v: 2 }));
    expect(m.superseded()).toEqual({});
  });
});

describe('row 42: a row with no mirror', () => {
  it('writes the mirror and its entry', async () => {
    m.state.rows.put(m.keyOf('r42.json'), text({ v: 42 }));
    await runSharedPass({ rehash: true });
    expect(m.read('r42.json')).toBe(text({ v: 42 }));
    expect(m.entry('r42.json')).toEqual({ sha: sha(text({ v: 42 })), stamp: null, main: null });
    expect(moves()).toEqual([]);
  });
});

describe('row 43: a mirror with no row, equal to its entry', () => {
  it('is removed and its entry dropped', async () => {
    await m.landed('r43.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('r43.json'));
    await runSharedPass({ rehash: true });
    expect(fs.existsSync(m.file('r43.json'))).toBe(false);
    expect(m.entry('r43.json')).toBeUndefined();
    expect(m.superseded()).toEqual({});
  });
});

describe('row 44: a hand-placed file with no row and no entry', () => {
  it('is moved aside with T11 (a)\'s no-row tail', async () => {
    fs.mkdirSync(path.dirname(m.file('r44.json')), { recursive: true });
    fs.writeFileSync(m.file('r44.json'), 'placed by hand');
    await runSharedPass({ rehash: true });
    expect(fs.existsSync(m.file('r44.json'))).toBe(false);
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('placed by hand');
    expect(moves()).toEqual([T11.a(m.file('r44.json'), destOf(rel)) + T11.noRow]);
    expect(m.entry('r44.json')).toBeUndefined();
  });

  it('a temp file of the file backend and a lines key are not visited', async () => {
    fs.mkdirSync(path.dirname(m.file('x')), { recursive: true });
    fs.writeFileSync(`${m.file('r44b.json')}.123.456.0.tmp`, 'temp');
    fs.writeFileSync(m.file('r44b.jsonl'), '{"a":1}\n');
    await runSharedPass({ rehash: true });
    expect(m.superseded()).toEqual({});
    expect(fs.existsSync(m.file('r44b.jsonl'))).toBe(true);
  });
});

describe('row 45: the listing fails', () => {
  it('changes nothing, logs the cause once, and the next pass applies', async () => {
    m.state.rows.put(m.keyOf('r45.json'), text({ v: 45 }));
    m.state.rows.fault = sql => (sql === LIST ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' }) : undefined);
    const first = await runSharedPass({ rehash: true });
    await runSharedPass({ rehash: true });
    expect(first).toMatchObject({ answered: false });
    expect(first.cause).toContain('statement timeout');
    expect(m.read('r45.json')).toBeNull();
    const logs = m.state.lines.filter(l => l.startsWith('[Shared] Could not check'));
    expect(logs).toHaveLength(1);
    m.state.rows.fault = undefined;
    expect((await runSharedPass({ rehash: true })).answered).toBe(true);
    expect(m.read('r45.json')).toBe(text({ v: 45 }));
  });
});

describe('rows 98 and 99: the main tag of an entry', () => {
  it('row 98: from an older main, with a row that differs: moved aside, the row written, T11 (b)', async () => {
    setView(1, 'ALPHA');
    await m.landed('r98.json', { v: 1 });
    expect(m.entry('r98.json')).toMatchObject({ main: '1:ALPHA' });
    setView(2, 'BRAVO');
    m.state.rows.put(m.keyOf('r98.json'), text({ v: 'bravo' }));
    await runSharedPass();
    expect(m.read('r98.json')).toBe(text({ v: 'bravo' }));
    expect(m.entry('r98.json')).toMatchObject({ sha: sha(text({ v: 'bravo' })), main: '2:BRAVO' });
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe(text({ v: 1 }));
    expect(moves()).toEqual([T11.b(m.file('r98.json'), destOf(rel), 'BRAVO', 2) + T11.written]);
  });

  it('row 99: from an older main, with the row equal to the entry: only the tag is rewritten', async () => {
    setView(1, 'ALPHA');
    await m.landed('r99.json', { v: 1 });
    const ino = fs.statSync(m.file('r99.json')).ino;
    setView(2, 'BRAVO');
    await runSharedPass();
    expect(m.entry('r99.json')).toMatchObject({ sha: sha(text({ v: 1 })), main: '2:BRAVO' });
    expect(fs.statSync(m.file('r99.json')).ino).toBe(ino);
    expect(moves()).toEqual([]);
  });
});

describe('row 162: the main tag changes during the pass', () => {
  it('the key\'s result is dropped, T11 gets the tag-changed tail, and the next pass writes the new main\'s version', async () => {
    setView(1, 'ALPHA');
    await m.landed('r162.json', { v: 1 });
    fs.writeFileSync(m.file('r162.json'), 'edited by hand');
    m.state.rows.put(m.keyOf('r162.json'), text({ v: 2 }));
    m.state.rows.fault = sql => {
      if (sql === BODY) setView(2, 'BRAVO');
      return undefined;
    };
    await runSharedPass({ rehash: true });
    expect(fs.existsSync(m.file('r162.json'))).toBe(false);
    expect(m.entry('r162.json')).toMatchObject({ sha: sha(text({ v: 1 })), main: '1:ALPHA' });
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('edited by hand');
    expect(moves()).toEqual([T11.a(m.file('r162.json'), destOf(rel)) + T11.tagChanged]);
    m.state.rows.fault = undefined;
    await runSharedPass();
    expect(m.read('r162.json')).toBe(text({ v: 2 }));
    expect(m.entry('r162.json')).toMatchObject({ sha: sha(text({ v: 2 })), main: '2:BRAVO' });
    expect(moves()).toHaveLength(1);
  });
});

describe('rows 28 and 100: the 60 s pass', () => {
  it('row 28: with the listener up, a change whose notification was lost is applied by the next 60 s pass', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    m.state.rows.put(m.keyOf('r28.json'), text({ v: 28 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(m.read('r28.json')).toBeNull();
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(m.read('r28.json')).toBe(text({ v: 28 })));
  });

  it('row 100: with the listener down, the 60 s pass still runs on the data pool; only the listener\'s line is logged', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rig = listenRig();
    for (let i = 0; i < 50; i++) rig.plan.push(new Error('connect ECONNREFUSED'));
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    m.state.rows.put(m.keyOf('r100.json'), text({ v: 100 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(m.read('r100.json')).toBe(text({ v: 100 })));
    expect(m.state.lines.filter(l => !l.startsWith("[Shared] Can't listen for changes from other machines"))).toEqual([]);
  });

  it('a pass prunes shared_ops rows older than 7 days at most once an hour', async () => {
    await runSharedPass();
    await runSharedPass();
    await vi.waitFor(() => expect(m.state.rows.prunes).toHaveLength(1));
  });
});
