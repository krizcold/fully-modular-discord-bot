import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelQueued, deleteRawAtomic, enqueueAppend, enqueueDelete, enqueueWrite, fileTicket, flushAll, writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { deleteDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { freshGuild } from '../helpers/gateRig';

// NB22: the scope record's property draws file tickets whose seq never falls on one path; these rows hold that fact.

let n = 0;
const fresh = (ext = 'json') => dataPath('global', 'nb22', `f${++n}.${ext}`);
const realMkdir = fs.promises.mkdir.bind(fs.promises);
const openGates: (() => void)[] = [];

function failMkdir(dir: string): { fail: boolean } {
  const on = { fail: true };
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, ...rest: any[]) => {
    if (on.fail && String(d) === dir) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return (realMkdir as any)(d, ...rest);
  }) as typeof fs.promises.mkdir);
  return on;
}

/** The first `count` flush mkdirs of this dir each wait on their own gate; entered[i] resolves when flush i reaches it. */
function holdFlushes(dir: string, count: number): { entered: Promise<void>[]; release: (() => void)[] } {
  const enter: (() => void)[] = [];
  const release: (() => void)[] = [];
  const entered = Array.from({ length: count }, (_, i) => new Promise<void>(resolve => { enter[i] = resolve; }));
  const gates = Array.from({ length: count }, (_, i) => new Promise<void>(resolve => { release[i] = resolve; }));
  openGates.push(...release.map(r => () => r()));
  let next = 0;
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, ...rest: any[]) => {
    if (next < count && String(d) === dir) {
      const i = next++;
      enter[i]();
      await gates[i];
    }
    return (realMkdir as any)(d, ...rest);
  }) as typeof fs.promises.mkdir);
  return { entered, release };
}

function nonDecreasing(seqs: number[]): void {
  for (let i = 1; i < seqs.length; i++) expect(seqs[i], `ticket ${i} of ${seqs.join(',')}`).toBeGreaterThanOrEqual(seqs[i - 1]);
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

beforeEach(() => {
  fs.mkdirSync(dataPath('global', 'nb22'), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const release of openGates.splice(0)) release();
  vi.restoreAllMocks();
  await flushAll();
});

describe('a file ticket\'s seq on one path never falls', () => {
  it('over every enqueue with no flush running', () => {
    const p = fresh('jsonl');
    const seqs: number[] = [];
    enqueueWrite(p, 'a\n'); seqs.push(fileTicket(p).seq);
    enqueueAppend(p, 'b\n'); seqs.push(fileTicket(p).seq);
    enqueueAppend(p, 'c\n'); seqs.push(fileTicket(p).seq);
    enqueueDelete(p); seqs.push(fileTicket(p).seq);
    enqueueAppend(p, 'd\n'); seqs.push(fileTicket(p).seq);
    expect(writeRawAtomic(p, 'e\n')).toBe(true); seqs.push(fileTicket(p).seq);
    expect(deleteRawAtomic(p)).toBe(true); seqs.push(fileTicket(p).seq);
    enqueueAppend(p, 'f\n'); seqs.push(fileTicket(p).seq);
    nonDecreasing(seqs);
  });

  it('an absent delete repeats the queued delete\'s seq', () => {
    const guildId = freshGuild();
    const p = path.join(process.env.DATA_DIR!, guildId, 'm', 'x.json');
    enqueueWrite(p, '{}');
    const before = fileTicket(p).seq;
    enqueueDelete(p);
    const queued = fileTicket(p).seq;
    const tracked = deleteDataTracked('x.json', { guildId, category: 'm' });
    expect(tracked.outcome).toBe('absent');
    const ticket = tracked.outcome === 'absent' ? tracked.ticket : undefined;
    expect(ticket?.kind).toBe('file');
    expect(ticket && ticket.kind === 'file' ? ticket.seq : null).toBe(queued);
    nonDecreasing([before, queued, queued]);
  });

  it('an append grown mid-flush, before and after its land', async () => {
    const p = fresh('jsonl');
    const hold = holdFlushes(path.dirname(p), 2);
    enqueueAppend(p, 'a\n');
    await hold.entered[0];
    const seqs = [fileTicket(p).seq];
    enqueueAppend(p, 'b\n'); seqs.push(fileTicket(p).seq);
    hold.release[0]();
    await hold.entered[1];
    expect(fs.readFileSync(p, 'utf8')).toBe('a\n');
    seqs.push(fileTicket(p).seq);
    hold.release[1]();
    nonDecreasing(seqs);
  });

  it('a whole write replaced mid-flush, before and after the first flush ends', async () => {
    const p = fresh();
    const hold = holdFlushes(path.dirname(p), 2);
    enqueueWrite(p, '{"a":1}');
    await hold.entered[0];
    const seqs = [fileTicket(p).seq];
    enqueueWrite(p, '{"a":2}'); seqs.push(fileTicket(p).seq);
    hold.release[0]();
    await hold.entered[1];
    seqs.push(fileTicket(p).seq);
    hold.release[1]();
    nonDecreasing(seqs);
  });

  it('a failed append with its retry pending, then a new append', async () => {
    const p = fresh('jsonl');
    const on = failMkdir(path.dirname(p));
    enqueueAppend(p, 'a\n');
    await tick();
    const failed = fileTicket(p).seq;
    enqueueAppend(p, 'b\n');
    nonDecreasing([failed, fileTicket(p).seq]);
    on.fail = false;
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('a\nb\n');
  });

  it('a cancel during a flush, then a new write', async () => {
    const p = fresh();
    const hold = holdFlushes(path.dirname(p), 1);
    enqueueWrite(p, '{"a":1}');
    await hold.entered[0];
    const before = fileTicket(p).seq;
    const cancel = cancelQueued([p]);
    hold.release[0]();
    await cancel;
    enqueueWrite(p, '{"a":2}');
    expect(fileTicket(p).seq).toBeGreaterThan(before);
  });
});
