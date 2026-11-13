import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileTicketState, flushAll, forgetDurableFiles, type FileTicket } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { appendDataTracked, confirmSaved, saveMark } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// L5 run A, chunk rj5: NB13 decision 8 in confirmSaved: a file line whose sync the disk did not confirm, found so while
// the confirms waited, answers 'unavailable', and only for the module folder it is in.

let n = 0;
let stub: AppendStub;

const ticketOf = (tracked: ReturnType<typeof appendDataTracked>): FileTicket => {
  if (tracked.outcome !== 'appended' || tracked.ticket.kind !== 'file') throw new Error(`not appended: ${tracked.outcome}`);
  return tracked.ticket;
};

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  forgetDurableFiles();
});

afterEach(async () => {
  stub.restore();
  await flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

/** L1's sync is held and then refused; L2, appended while it was held, lands. confirmSaved is asked while L1 is held. */
async function lineLostWhileConfirming() {
  const category = `rj5cf${++n}x${Date.now()}`;
  const opts = { scope: 'global' as const, category };
  const name = 's.jsonl';
  const p = dataPath('global', category, name);
  ticketOf(appendDataTracked(name, opts, 'T1\n'));
  await flushAll();
  const before = saveMark();
  const hold = stub.holdSync(p, 'EIO');
  const l1 = ticketOf(appendDataTracked(name, opts, 'L1\n'));
  await hold.reached;
  const l2 = ticketOf(appendDataTracked(name, opts, 'L2\n'));
  const answer = confirmSaved('global', { since: before, deadlineMs: 2000, category });
  hold.release();
  await flushAll();
  return { p, before, l1, l2, answer: await answer };
}

describe("confirmSaved and a file line the disk did not confirm", () => {
  it('a line found unconfirmed while the confirms waited answers unavailable, though a later line of the file landed', async () => {
    const { p, l1, l2, answer } = await lineLostWhileConfirming();
    expect(fileTicketState(l1)).toBe('unconfirmed');
    expect(fileTicketState(l2)).toBe('landed');
    expect(fs.readFileSync(p, 'utf8')).toBe('T1\nL1\nL2\n');
    expect(answer).toBe('unavailable');
  });

  it("another module's folder is not judged by that line", async () => {
    const { before } = await lineLostWhileConfirming();
    expect(await confirmSaved('global', { since: before, deadlineMs: 100, category: `rj5other${n}` })).toBe('ok');
  });
});
