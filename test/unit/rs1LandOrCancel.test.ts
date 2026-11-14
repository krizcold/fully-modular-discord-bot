import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web UI chain's reconcile gate and its land-or-cancel answers, driven with the cancel results, the carried
// tickets and their states set by hand, so each reply text is pinned to the outcomes that produce it.

const st = vi.hoisted(() => ({
  results: [] as any[],
  openPaths: [] as string[],
  writes: undefined as any,
  refresh: [] as any[],
  refreshCalls: 0,
  cancelThrows: null as Error | null,
  invalidate: 0,
}));

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    queuedFilePaths: () => [],
    cancelQueued: async () => {
      if (st.cancelThrows) throw st.cancelThrows;
      return st.results;
    },
    fileTicketState: (t: any) => t.state,
    fileTicketFailure: (t: any) => t.failure ?? null,
    droppedByDeposition: (record: any) => record?.dropped === true,
    filesPending: () => false,
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/writeLedger', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/writeLedger')>();
  return { ...real, carriedWrites: () => st.writes, landed: (t: any) => t.landed === true };
});

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return { ...real, rowOpenPaths: () => st.openPaths, rowMirrorsWritten: () => null, rowTicketState: (t: any) => t.rowState };
});

vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    refreshShared: async () => {
      st.refreshCalls += 1;
      const next = st.refresh.shift() ?? { ok: true };
      if (next instanceof Error) throw next;
      return next;
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/sharedOps', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/sharedOps')>();
  return { ...real, invalidateSharedCaches: () => { st.invalidate += 1; } };
});

import { BotManager } from '../../src/webui/botManager';
import { setBackendKind } from '../helpers/backendKind';

let manager: BotManager;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  st.results = [];
  st.openPaths = [];
  st.writes = undefined;
  st.refresh = [];
  st.refreshCalls = 0;
  st.cancelThrows = null;
  st.invalidate = 0;
  manager = new BotManager();
});

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

const enqueue = (run: () => Promise<any>): Promise<any> => (manager as any).enqueueLocal({ label: 'op', provider: false, run, again: run });
const land = (reply: any): Promise<any> => (manager as any).landOrCancel({ label: 'op', provider: false, run: async () => reply, again: async () => reply }, reply);
const withResults = (...results: any[]) => {
  st.results = results;
  st.openPaths = results.map(r => r.path);
};
const writes = (tickets: any[], extra: Record<string, unknown> = {}) => {
  st.writes = { tickets, refused: false, unknowable: false, landedBefore: false, ...extra };
};
const fileT = (name: string, state: string, extra: Record<string, unknown> = {}) => ({ kind: 'file', path: `/d/global/c/${name}`, seq: 1, record: {}, state, landed: state === 'landed', ...extra });
const rowT = (name: string, isLanded: boolean, rowState = isLanded ? 'landed' : 'open') => ({ kind: 'row', path: `/d/global/c/${name}`, op: {}, landed: isLanded, rowState });

describe("the chain's reconcile after a take", () => {
  it('a JSON bot runs its op without asking the database', async () => {
    setBackendKind('file');
    st.refresh = [{ ok: false, cause: 'connect ECONNREFUSED' }];
    expect(await enqueue(async () => ({ ok: true, result: 7 }))).toEqual({ ok: true, result: 7 });
    expect(st.refreshCalls).toBe(0);
  });

  it('a Postgres chain reconciles once per take: a later op runs even when the database would not answer', async () => {
    setBackendKind('postgres');
    st.refresh = [{ ok: true }, { ok: false, cause: 'connect ECONNREFUSED' }];
    expect(await enqueue(async () => ({ ok: true, result: 1 }))).toEqual({ ok: true, result: 1 });
    expect(await enqueue(async () => ({ ok: true, result: 2 }))).toEqual({ ok: true, result: 2 });
    expect(st.refreshCalls).toBe(1);
  });

  it('a reconcile that throws answers nothing saved and drops the shared caches', async () => {
    setBackendKind('postgres');
    st.refresh = [new Error('socket hang up')];
    let ran = 0;
    const reply = await enqueue(async () => { ran += 1; return { ok: true }; });
    expect(reply).toEqual({
      ok: false, status: 503, code: 'backend-unavailable',
      error: "Can't reach the database to read the shared files (socket hang up); nothing was saved. Try again in a moment.",
    });
    expect(ran).toBe(0);
    expect(st.invalidate).toBe(1);
  });
});

describe('the answer after another process took the data files', () => {
  const depose = () => { (manager as any).chainDeposed = { role: 'bot', pid: 4242 }; };
  const lead = 'Another process took the data files (a bot process this web UI did not start, pid 4242) while your change was being saved;';

  it('a line the disk is still writing may be stored: can\'t confirm', async () => {
    depose();
    writes([fileT('a.json', 'written', { record: { dropped: true } })]);
    expect(await land({ ok: true })).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} can't confirm whether it was saved. Reload to check before you try again.` });
  });

  it('a row op of unknown fate may be stored: can\'t confirm', async () => {
    depose();
    writes([rowT('r.json', false, 'unconfirmed')]);
    expect(await land({ ok: true })).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} can't confirm whether it was saved. Reload to check before you try again.` });
  });

  it('a refused row op stored nothing', async () => {
    depose();
    writes([rowT('r.json', false, 'refused')]);
    expect(await land({ ok: true })).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: `${lead} nothing was saved.` });
  });
});

describe('a reply the op gave as saved or unconfirmed', () => {
  it('a saved reply that carries the unconfirmed code drops its note and stays saved', async () => {
    expect(await land({ ok: true, code: 'unconfirmed', note: 'n', result: 3 })).toEqual({ ok: true, code: 'unconfirmed', result: 3 });
  });
});

describe('row ops whose COMMIT answer was lost', () => {
  it('names every file and every cause, comma separated', async () => {
    withResults(
      { path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: 'ECONNRESET', cut: false, row: true },
      { path: '/d/global/c/b.json', outcome: 'unconfirmed', errno: 'ETIMEDOUT', cut: false, row: true },
      { path: '/d/global/c/b.json', outcome: 'unconfirmed', errno: null, cut: false, row: true },
    );
    expect((await land({ ok: true })).error).toBe(
      "Can't confirm whether your change to a.json, b.json was saved: the database did not answer the save (ECONNRESET, ETIMEDOUT). Reload to see the current values before you try again.",
    );
  });

  it('with no cause it says no answer', async () => {
    withResults({ path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: null, cut: false, row: true });
    expect(await land({ ok: true })).toEqual({
      ok: false, status: 503, code: 'unconfirmed',
      error: "Can't confirm whether your change to a.json was saved: the database did not answer the save (no answer). Reload to see the current values before you try again.",
    });
  });
});

describe('file writes the disk did not confirm', () => {
  const text = (names: string, codes: string) => `The disk did not confirm the write of ${names} (${codes}), so can't confirm whether your change was saved. Check the disk, then reload to check before you try again.`;

  it('a carried line still being written answers can\'t confirm', async () => {
    writes([fileT('w.json', 'written')]);
    expect(await land({ ok: true, result: 1 })).toEqual({ ok: false, status: 503, code: 'disk', error: text('w.json', 'no error code') });
  });

  it('an unconfirmed file result is named alone; a landed one beside it is not', async () => {
    withResults(
      { path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: 'EIO', cut: false },
      { path: '/d/global/c/b.json', outcome: 'landed' },
    );
    expect(await land({ ok: true })).toEqual({ ok: false, status: 503, code: 'disk', error: text('a.json', 'EIO') });
  });

  it('a landed row result beside it is not named either', async () => {
    withResults(
      { path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: 'EIO', cut: false },
      { path: '/d/global/c/r.json', outcome: 'landed', row: true },
    );
    expect((await land({ ok: true })).error).toBe(text('a.json', 'EIO'));
  });

  it('an unconfirmed result with no errno says no error code', async () => {
    withResults({ path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: null, cut: false });
    expect((await land({ ok: true })).error).toBe(text('a.json', 'no error code'));
  });

  it('a missing errno beside a known one leaves only the known one', async () => {
    withResults(
      { path: '/d/global/c/a.json', outcome: 'unconfirmed', errno: null, cut: false },
      { path: '/d/global/c/b.json', outcome: 'unconfirmed', errno: 'ENOSPC', cut: false },
    );
    expect((await land({ ok: true })).error).toBe(text('a.json, b.json', 'ENOSPC'));
  });
});

describe("a store doc's wait that gave up, with nothing cancelled", () => {
  const gaveUp = { ok: false, status: 202, code: 'unconfirmed', error: 'still saving' };

  it('with no row tickets the wait answer stands', async () => {
    writes([]);
    expect(await land(gaveUp)).toEqual(gaveUp);
  });

  it('with no carried writes the wait answer stands', async () => {
    expect(await land(gaveUp)).toEqual(gaveUp);
  });

  it('one row ticket not landed keeps the wait answer', async () => {
    writes([rowT('a.json', true), rowT('b.json', false)]);
    expect(await land(gaveUp)).toEqual(gaveUp);
  });

  it('every row ticket landed answers saved, whatever the file tickets beside them', async () => {
    writes([rowT('a.json', true), fileT('f.json', 'open')]);
    expect(await land(gaveUp)).toEqual({ ok: true, result: undefined });
  });
});

describe('row ops cancelled before their COMMIT', () => {
  it('names every file and every cause, comma separated', async () => {
    withResults(
      { path: '/d/global/c/a.json', outcome: 'cancelled', errno: 'cause one', row: true },
      { path: '/d/global/c/b.json', outcome: 'cancelled', errno: 'cause two', row: true },
    );
    expect(await land({ ok: true })).toEqual({
      ok: false, status: 503, code: 'disk',
      error: 'The database did not take the write of a.json, b.json (cause one, cause two), so your change was not saved. Try again in a moment.',
    });
  });
});
