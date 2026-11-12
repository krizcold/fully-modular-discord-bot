import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelQueued,
  enqueueAppend,
  fileTicket,
  fileTicketFailure,
  flushAll,
  forgetDurableFiles,
  queuedFilePaths,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let stub: AppendStub;
const L = (i: number) => `{"line":${i}}\n`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function append(p: string, text: string): FileTicket {
  enqueueAppend(p, text);
  return fileTicket(p);
}

async function until(what: string, done: () => boolean) {
  for (let i = 0; i < 400 && !done(); i++) await sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  dir = dataPath('ra35fr', String(Date.now()), String(++n));
  fs.mkdirSync(dir, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
});
afterEach(async () => {
  stub.restore();
  await flushAll();
  vi.restoreAllMocks();
});

describe('a cancel answers the errno of the try that failed the seq it drops', () => {
  it('a later failed try that also failed newer lines does not take over the errno of the dropped seq', async () => {
    const p = path.join(dir, 'a.jsonl');
    fs.writeFileSync(p, '');
    const first = stub.holdSync(p, 'EIO');
    const t1 = append(p, L(1));
    await first.reached;

    let gate!: () => void;
    const gated = new Promise<void>(resolve => { gate = resolve; });
    let sleeps = 0;
    const cancelled = cancelQueued([p], async ms => { sleeps += 1; await gated; await sleep(ms); });
    await until('the cancel to wait on the try', () => sleeps > 0);

    stub.failSync(p, 'EDQUOT');
    const t2 = append(p, L(2));
    expect(t2.record).toBe(t1.record);
    first.release();
    await until('both tries to close their handles', () => stub.appendCloses.filter(c => c === p).length >= 2);
    await until('the queue to drop the path', () => !queuedFilePaths().includes(p));
    gate();

    const [answer] = await cancelled;    expect(fs.readFileSync(p, 'utf8')).toBe(L(1) + L(2));
    expect(answer).toMatchObject({ path: p, outcome: 'unconfirmed', errno: 'EIO', cut: false, what: 'lines' });
    expect(fileTicketFailure(t1)).toMatchObject({ errno: 'EIO', cut: false });
    expect(fileTicketFailure(t2)).toMatchObject({ errno: 'EDQUOT', cut: false });
  });
});
