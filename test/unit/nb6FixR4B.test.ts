import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { bootShared, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 code review round 4, R4-B1 (out/NB6/part-rulings.md "Code review round 4"): a record write that throws in the
// bot's own passes (the 60 s timer's, the listener's, bootShared's) logs row 34's line once and leaves the key
// unanswered; no pass rejects. The record's temp file fails ENOSPC at its open, as on a full /data.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6fixr4b');
const RECORD = dataPath('.shared-mirror.json');
const LINE = `[Shared] Could not write ${RECORD} (ENOSPC); retrying`;
const rowLines = () => m.state.lines.filter(l => l === LINE);

let rejections: unknown[];
const onRejection = (reason: unknown) => { rejections.push(reason); };
let restore: (() => void) | null;

/** The mirror holds the row and the record has no entry for it (a crash between the mirror write and the record's). */
function crashState(name: string, value: unknown): void {
  m.state.rows.put(m.keyOf(name), text(value));
  fs.mkdirSync(dataPath('global', 'nb6fixr4b'), { recursive: true });
  fs.writeFileSync(m.file(name), text(value));
}

function diskFull(): void {
  const real = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(`${RECORD}.`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync);
  restore = () => spy.mockRestore();
}

beforeEach(async () => {
  await m.setup();
  rejections = [];
  restore = null;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  restore?.();
  _setListenClientFactory(null);
  await m.teardown();
  process.off('unhandledRejection', onRejection);
});

describe("R4-B1: the listener's pass", () => {
  it('the record write fails ENOSPC: no rejection, row 34 line once, and the entry is written once the disk takes writes', async () => {
    crashState('l.json', { v: 1 });
    diskFull();
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await vi.waitFor(() => expect(rowLines()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rejections).toEqual([]);
    expect(rowLines()).toHaveLength(1);
    expect(m.entry('l.json')).toBeUndefined();
    expect(m.read('l.json')).toBe(text({ v: 1 }));
  });
});

describe('R4-B1: the 60 s pass', () => {
  it('the record write fails ENOSPC: no rejection at either pass, the line once, and the next pass after the disk is back writes the entry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await new Promise(resolve => setTimeout(resolve, 50));
    crashState('t.json', { v: 1 });
    diskFull();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(rowLines()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rejections).toEqual([]);
    expect(rowLines()).toHaveLength(1);
    expect(m.entry('t.json')).toBeUndefined();
    restore!();
    restore = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(m.entry('t.json')).toMatchObject({ sha: sha(text({ v: 1 })) }));
    expect(rejections).toEqual([]);
  });
});

describe("R4-B1: bootShared's loop", () => {
  it('the record write fails ENOSPC: the boot logs, tries again every 5 s, and ends once the disk takes writes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    crashState('b.json', { v: 1 });
    diskFull();
    let ended: string | null = null;
    let failed: unknown = null;
    void bootShared().then(v => { ended = v; }, e => { failed = e; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(m.state.lines.some(l => l.startsWith('[Shared] Waiting for '))).toBe(true));
    expect(failed).toBeNull();
    expect(ended).toBeNull();
    expect(rowLines()).toHaveLength(1);
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Waiting for '))).toEqual([
      '[Shared] Waiting for this machine to write the shared files (ENOSPC: no space left on device); modules start once they are up to date',
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toBeNull();
    expect(ended).toBeNull();
    expect(rowLines()).toHaveLength(1);
    restore!();
    restore = null;
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(ended).toBe('done'));
    expect(m.entry('b.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
    expect(rejections).toEqual([]);
  });
});
