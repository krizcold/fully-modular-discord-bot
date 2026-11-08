import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { applySharedKeys, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, T11, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 test 5 (wip-redesign/sheets/NB6.md section 5 rows 26, 27 and 29 to 35, as rounds 1 and 2 change rows 32 and
// 35; decisions 9, 21 and 49; part 8): the applier of one key, as a notification runs it, over the real flush's rows,
// mirrors and record. The other machine's change is a row it stored (rows.put).

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6apply');
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const COULD_NOT_CHECK = '[Shared] Could not check';

beforeEach(() => m.setup());
afterEach(async () => {
  _setListenClientFactory(null);
  await m.teardown();
});

describe('row 26: another machine\'s change', () => {
  it('replaces the mirror, writes the entry, then runs the hooks registered for the key', async () => {
    await m.landed('r26.json', { v: 1 });
    const seen: string[] = [];
    const off = dm.onSharedApplied(m.keyOf(''), key => { seen.push(`${key}:${m.read('r26.json')}`); });
    m.state.rows.put(m.keyOf('r26.json'), text({ v: 2 }));
    const res = await applySharedKeys([m.keyOf('r26.json')]);
    off();
    expect(res.answered).toBe(true);
    expect(m.read('r26.json')).toBe(text({ v: 2 }));
    expect(m.entry('r26.json')).toMatchObject({ sha: sha(text({ v: 2 })) });
    expect(seen).toEqual([`${m.keyOf('r26.json')}:${text({ v: 2 })}`]);
    expect(m.superseded()).toEqual({});
    expect(m.state.lines).toEqual([]);
  });
});

describe('row 27: the notification comes twice', () => {
  it('the second apply finds the row equal to the entry: it reads no body and writes nothing', async () => {
    await m.landed('r27.json', { v: 1 });
    m.state.rows.put(m.keyOf('r27.json'), text({ v: 2 }));
    await applySharedKeys([m.keyOf('r27.json')]);
    const ino = fs.statSync(m.file('r27.json')).ino;
    m.state.pg.sent.length = 0;
    const hooks: string[] = [];
    const off = dm.onSharedApplied(m.keyOf('r27.json'), key => { hooks.push(key); });
    await applySharedKeys([m.keyOf('r27.json')]);
    off();
    expect(m.sql()).not.toContain(BODY);
    expect(fs.statSync(m.file('r27.json')).ino).toBe(ino);
    expect(hooks).toEqual([]);
  });
});

describe('row 29: a notification for a key with a local op pending', () => {
  it('the applier leaves the key while the op is queued; once the op settles (refused here), the key is applied', async () => {
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await m.landed('r29.json', { v: 1 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    m.state.rows.fault = sql => (/^BEGIN/.test(sql) ? held.then(() => undefined) : undefined);
    const save = dm.saveDataTracked('r29.json', m.opts, { v: 'mine' }) as { ticket?: RowTicket };
    m.state.rows.put(m.keyOf('r29.json'), text({ v: 'theirs' }));
    await applySharedKeys([m.keyOf('r29.json')]);
    expect(m.sql()).not.toContain(BODY);
    expect(m.read('r29.json')).toBe(text({ v: 1 }));
    release();
    m.state.rows.fault = undefined;
    await dm.flushAll();
    expect(rowTicketState(save.ticket!)).toBe('refused');
    await vi.waitFor(() => expect(m.read('r29.json')).toBe(text({ v: 'theirs' })));
    expect(rowQueue.ops(m.keyOf('r29.json'))).toEqual([]);
    expect(m.entry('r29.json')).toMatchObject({ sha: sha(text({ v: 'theirs' })) });
    expect(m.state.lines.some(l => l.includes('this machine now holds that version'))).toBe(true);
  });
});

describe('row 30: this process\'s own notification', () => {
  it('is skipped: nothing is read', async () => {
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients.length).toBe(1));
    await vi.waitFor(() => expect(rig.last().queries).toContain('LISTEN smdb_guild_requests'));
    await m.landed('r30.json', { v: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    m.state.pg.sent.length = 0;
    m.state.rows.put(m.keyOf('r30.json'), text({ v: 2 }), `node/${processId()}`);
    rig.last().notify('smdb_shared', JSON.stringify({ k: 'doc', key: m.keyOf('r30.json'), sha: sha(text({ v: 2 })), rev: 9, by: processId() }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(m.sql()).toEqual([]);
    expect(m.read('r30.json')).toBe(text({ v: 1 }));
  });
});

describe('rows 31 and 32: a deleted key', () => {
  it('row 31: the mirror equal to the entry is removed, the entry dropped, the hooks run', async () => {
    await m.landed('r31.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('r31.json'));
    const hooks: string[] = [];
    const off = dm.onSharedApplied(m.keyOf(''), key => { hooks.push(key); });
    await applySharedKeys([m.keyOf('r31.json')]);
    off();
    expect(fs.existsSync(m.file('r31.json'))).toBe(false);
    expect(m.entry('r31.json')).toBeUndefined();
    expect(hooks).toEqual([m.keyOf('r31.json')]);
    expect(m.superseded()).toEqual({});
  });

  it('row 32: a mirror that differs from the entry is moved aside with T11 (a)\'s no-row tail', async () => {
    await m.landed('r32.json', { v: 1 });
    fs.writeFileSync(m.file('r32.json'), 'edited by hand');
    m.state.rows.docs.delete(m.keyOf('r32.json'));
    await applySharedKeys([m.keyOf('r32.json')]);
    expect(fs.existsSync(m.file('r32.json'))).toBe(false);
    expect(m.entry('r32.json')).toBeUndefined();
    const moved = Object.entries(m.superseded());
    expect(moved).toHaveLength(1);
    expect(moved[0][0]).toMatch(new RegExp(`^shared-\\d+/global/nb6apply/r32\\.json$`));
    expect(moved[0][1]).toBe('edited by hand');
    const dest = path.join(dataPath('_superseded'), ...moved[0][0].split('/'));
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([T11.a(m.file('r32.json'), dest) + T11.noRow]);
  });
});

describe('row 33: the row read fails', () => {
  it('nothing changes, the cause is logged once, and the next run applies it', async () => {
    await m.landed('r33.json', { v: 1 });
    m.state.rows.put(m.keyOf('r33.json'), text({ v: 2 }));
    m.state.rows.fault = sql => (sql === BODY ? Object.assign(new Error('relation is locked'), { code: '55P03', severity: 'ERROR' }) : undefined);
    const first = await applySharedKeys([m.keyOf('r33.json')]);
    await applySharedKeys([m.keyOf('r33.json')]);
    expect(first.answered).toBe(false);
    expect(m.read('r33.json')).toBe(text({ v: 1 }));
    expect(m.state.lines.filter(l => l.startsWith(COULD_NOT_CHECK))).toHaveLength(1);
    expect(m.state.lines.find(l => l.startsWith(COULD_NOT_CHECK))).toContain('relation is locked');
    m.state.rows.fault = undefined;
    await applySharedKeys([m.keyOf('r33.json')]);
    expect(m.read('r33.json')).toBe(text({ v: 2 }));
  });
});

describe('row 34: the mirror write fails', () => {
  it('keeps the entry, logs the errno, and the next run writes it', async () => {
    await m.landed('r34.json', { v: 1 });
    const before = m.entry('r34.json');
    m.state.rows.put(m.keyOf('r34.json'), text({ v: 2 }));
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    await applySharedKeys([m.keyOf('r34.json')]);
    expect(m.entry('r34.json')).toEqual(before);
    expect(m.read('r34.json')).toBe(text({ v: 1 }));
    expect(m.state.lines).toContain(`[Shared] Could not write ${m.file('r34.json')} (ENOSPC); retrying`);
    await applySharedKeys([m.keyOf('r34.json')]);
    expect(m.read('r34.json')).toBe(text({ v: 2 }));
    expect(m.entry('r34.json')).toMatchObject({ sha: sha(text({ v: 2 })) });
  });
});

describe('row 35: a mirror that is neither the entry nor the row', () => {
  it('is moved aside, then the row\'s version is written, logged with T11 (a)\'s written tail', async () => {
    await m.landed('r35.json', { v: 1 });
    fs.writeFileSync(m.file('r35.json'), 'edited by hand');
    m.state.rows.put(m.keyOf('r35.json'), text({ v: 2 }));
    await applySharedKeys([m.keyOf('r35.json')]);
    expect(m.read('r35.json')).toBe(text({ v: 2 }));
    expect(Object.values(m.superseded())).toEqual(['edited by hand']);
    const dest = path.join(dataPath('_superseded'), ...Object.keys(m.superseded())[0].split('/'));
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([T11.a(m.file('r35.json'), dest) + T11.written]);
  });
});
