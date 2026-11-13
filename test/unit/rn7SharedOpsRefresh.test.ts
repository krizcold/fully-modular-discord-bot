import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sharedOps.ts (NB6 decisions 13 and 40): before a premium op a Postgres bot brings the premium files up to the rows
// and reads the events journal. A refresh that failed answers only once its pass ended; the journal is read as an op's
// read, not as the mirror pass's. The refresh and the manager are scripted; the op path is the real one.

const h = vi.hoisted(() => ({
  refresh: null as null | ((keys: string[] | null, passEnd?: (end: Promise<void>) => void) => Promise<unknown>),
  journal: { ok: true } as { ok: true } | { ok: false; cause: string },
  journalReads: [] as boolean[],
}));

vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, refreshShared: (keys: string[] | null, passEnd?: (end: Promise<void>) => void) => h.refresh!(keys, passEnd) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  const manager = {
    readSharedJournal: async (fromPass: boolean) => {
      h.journalReads.push(fromPass);
      return h.journal;
    },
    unreadableText: () => null,
    heldEventsText: () => null,
  };
  return { ...real, getPremiumManager: () => manager };
});

import { applySharedOp, type SharedOpReply } from '../../src/bot/internalSetup/utils/sharedOps';
import { setBackendKind } from '../helpers/backendKind';

const unreachable = (cause: string) => `Can't reach the database to read the current premium settings (${cause}); nothing was saved. Try again in a moment.`;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  h.journal = { ok: true };
  h.journalReads = [];
  setBackendKind('postgres');
});

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
};

describe('a refresh that failed while its pass still writes', () => {
  it('answers only after the pass ended', async () => {
    let endPass!: () => void;
    const end = new Promise<void>(resolve => { endPass = resolve; });
    let called = 0;
    h.refresh = async (_keys, passEnd) => {
      called += 1;
      passEnd?.(end);
      return { ok: false, cause: 'connect ECONNREFUSED 10.0.0.1:5432' };
    };
    let reply: SharedOpReply | undefined;
    const pending = applySharedOp({ op: 'premium.setTier', args: { args: [] } }).then(r => { reply = r; });
    await vi.waitFor(() => expect(called).toBe(1), { timeout: 2000, interval: 1 });
    await turns(20);
    expect(reply).toBeUndefined();
    endPass();
    await pending;
    expect(reply).toEqual({ ok: false, code: 'failed', error: unreachable('connect ECONNREFUSED 10.0.0.1:5432') });
    expect(h.journalReads).toEqual([]);
  });
});

describe('the events journal before a premium op', () => {
  it("is read as the op's read, and a failed read refuses the op", async () => {
    h.refresh = async () => ({ ok: true });
    h.journal = { ok: false, cause: 'Connection terminated unexpectedly' };
    const reply = await applySharedOp({ op: 'premium.setTier', args: { args: [] } });
    expect(reply).toEqual({ ok: false, code: 'failed', error: unreachable('Connection terminated unexpectedly') });
    expect(h.journalReads).toEqual([false]);
  });
});
