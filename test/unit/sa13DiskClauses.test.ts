import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 survivors, chunk 13: the web UI's landOrCancel answers a change whose file write or folder sync the disk did not
// confirm with one clause per file and the next step of the worst failure (NB19 T22). The cancel's results and the
// op's tickets are given by hand, so the answer does not depend on the platform's folder syncs.

const ctl = vi.hoisted(() => ({ results: null as null | unknown[] }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    queuedFilePaths: () => (ctl.results ? (ctl.results as { path: string }[]).map(r => r.path) : real.queuedFilePaths()),
    cancelQueued: (paths: string[], ...rest: unknown[]) => (ctl.results ? Promise.resolve(ctl.results) : real.cancelQueued(paths, ...rest)),
  };
});

import type { CancelOutcome, FileTicket } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { carryWrites, NO_WRITES } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import type { SyncKind } from '../../src/bot/internalSetup/utils/folderChain';
import { PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { BotManager } from '../../src/webui/botManager';

const HEAD = "Can't confirm whether your change was saved: ";
const RESTART = 'Check the disk, then restart the machine, then reload to check before you try again.';
const CHECK = 'Check the disk, then reload to check before you try again.';
const RELOAD = 'Reload to check before you try again.';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  ctl.results = null;
  vi.restoreAllMocks();
});

function failedTicket(p: string, what: 'lines' | 'whole', kind: SyncKind | null, dir: string, errno: string | null): FileTicket {
  const range = { from: 1, through: 1, errno, cut: false, what, ...(kind ? { kind, dir } : {}) };
  return { kind: 'file', path: p, seq: 1, record: { landed: 0, failed: [range], writing: 0, wrote: 1 } } as FileTicket;
}
function writtenTicket(p: string): FileTicket {
  return { kind: 'file', path: p, seq: 1, record: { landed: 0, failed: [], writing: 0, wrote: 1 } } as FileTicket;
}
const cancelled = (p: string, errno: string | null): CancelOutcome => ({ path: p, outcome: 'cancelled', errno });
const unconfirmed = (p: string, what: 'lines' | 'whole', kind: SyncKind, dir: string, errno: string): CancelOutcome =>
  ({ path: p, outcome: 'unconfirmed', errno, cut: false, what, kind, dir });

async function answerOf(results: CancelOutcome[], tickets: FileTicket[], provider = false): Promise<unknown> {
  ctl.results = results;
  const entry = { label: 'x', provider, run: async () => undefined, again: async () => undefined, resolve: () => undefined };
  const reply = carryWrites({ ok: false, code: 'unconfirmed', answer: 'unavailable', partial: false, error: 'e' }, { ...NO_WRITES, tickets });
  return (new BotManager() as any).landOrCancel(entry, reply);
}
const disk = (error: string) => ({ ok: false, status: 503, code: 'disk', error });

describe('one file whose folder sync failed', () => {
  it('a whole write after a failed sync: written, the sync clause and the restart step', async () => {
    const answer = await answerOf([], [failedTicket('/d/a/x.json', 'whole', 'sync', '/d/a', 'EIO')]);
    expect(answer).toEqual(disk(`${HEAD}x.json is written, but the disk did not confirm the sync of /d/a (EIO). ${RESTART}`));
  });

  it('with a payment provider call, the provider sentence follows', async () => {
    const answer = await answerOf([], [failedTicket('/d/a/x.json', 'whole', 'sync', '/d/a', 'EIO')], true);
    expect(answer).toEqual(disk(`${HEAD}x.json is written, but the disk did not confirm the sync of /d/a (EIO). ${RESTART} ${PROVIDER_SENTENCE}`));
  });

  it('appended lines under an earlier failed sync, named by the cancel: the lines clause and the restart step', async () => {
    const answer = await answerOf([unconfirmed('/d/b/y.json', 'lines', 'earlier', '/d', 'EIO')], []);
    expect(answer).toEqual(disk(
      `${HEAD}the lines of y.json are in the file and synced, but no folder sync is trusted since the disk did not confirm the sync of /d (EIO) earlier in this process. ${RESTART}`,
    ));
  });

  it('a folder that could not be opened: only the reload step', async () => {
    const answer = await answerOf([], [failedTicket('/d/c/z.json', 'whole', 'open', '/d/c', 'EMFILE')]);
    expect(answer).toEqual(disk(`${HEAD}z.json is written, but /d/c could not be opened for its sync (EMFILE). ${RELOAD}`));
  });
});

describe('several files', () => {
  it('a cancelled write, a failed sync and a written line: one clause each, in order, and the restart step', async () => {
    const answer = await answerOf(
      [cancelled('/d/p/p.json', 'EIO')],
      [failedTicket('/d/q/q.json', 'whole', 'sync', '/d/q', 'EIO'), writtenTicket('/d/r/r.json')],
    );
    expect(answer).toEqual(disk(
      `${HEAD}the disk did not confirm the write of p.json (EIO); q.json is written, but the disk did not confirm the sync of /d/q (EIO); the disk did not confirm the write of r.json (no error code). ${RESTART}`,
    ));
  });

  it('a folder not opened and a written line: both clauses and the check-the-disk step', async () => {
    const answer = await answerOf([], [failedTicket('/d/s/s.json', 'whole', 'open', '/d/s', 'EMFILE'), writtenTicket('/d/t/t.json')]);
    expect(answer).toEqual(disk(
      `${HEAD}s.json is written, but /d/s could not be opened for its sync (EMFILE); the disk did not confirm the write of t.json (no error code). ${CHECK}`,
    ));
  });
});

describe('two results for one file name', () => {
  it('a later result with a failed sync replaces an earlier cancelled one', async () => {
    const answer = await answerOf([cancelled('/d/a/x.json', 'EIO'), unconfirmed('/d/b/x.json', 'whole', 'sync', '/d/b', 'EIO')], []);
    expect(answer).toEqual(disk(`${HEAD}x.json is written, but the disk did not confirm the sync of /d/b (EIO). ${RESTART}`));
  });

  it('a later cancelled result keeps the earlier one with a failed sync', async () => {
    const answer = await answerOf([unconfirmed('/d/b/x.json', 'whole', 'sync', '/d/b', 'EIO'), cancelled('/d/a/x.json', 'EIO')], []);
    expect(answer).toEqual(disk(`${HEAD}x.json is written, but the disk did not confirm the sync of /d/b (EIO). ${RESTART}`));
  });

  it('a written ticket of the file keeps the cancel result with a failed sync', async () => {
    const answer = await answerOf([unconfirmed('/d/b/x.json', 'whole', 'sync', '/d/b', 'EIO')], [writtenTicket('/d/b/x.json')]);
    expect(answer).toEqual(disk(`${HEAD}x.json is written, but the disk did not confirm the sync of /d/b (EIO). ${RESTART}`));
  });
});
