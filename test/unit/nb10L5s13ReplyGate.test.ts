import { afterEach, describe, expect, it, vi } from 'vitest';

// NB10 survivors, chunk 13: a file write is told "writer-lost" only when its confirm answers unavailable and a
// deposition dropped its queued op. A write that landed while the deposition dropped a later op is saved, and a
// pending one is pending.

const ctl = vi.hoisted(() => ({
  confirm: null as null | ((ticket: any) => Promise<string>),
  dropped: new WeakSet<object>(),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  confirmWrite: (ticket: any) => ctl.confirm!(ticket),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  droppedByDeposition: (record: object) => ctl.dropped.has(record),
}));

import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { openLedger, type LedgerTicket } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

afterEach(() => {
  ctl.confirm = null;
});

function fileWrite(dropped: boolean): { ledger: ReturnType<typeof openLedger>; ticket: LedgerTicket & { kind: 'file' } } {
  const record = { landed: 0 };
  if (dropped) ctl.dropped.add(record);
  const ticket = { kind: 'file' as const, path: `/tmp/s13-${Math.random()}.json`, seq: 5, record };
  const ledger = openLedger('console');
  ledger.noteTicket(ticket, 'm');
  return { ledger, ticket };
}

describe('a file write whose path a deposition dropped', () => {
  it('that landed during its confirm answers ok', async () => {
    const { ledger } = fileWrite(true);
    ctl.confirm = async ticket => { ticket.record.landed = ticket.seq; return 'ok'; };
    expect(await verdictOf([ledger])).toEqual({ ok: true });
  });

  it('that is still pending answers pending, not writer-lost', async () => {
    const { ledger } = fileWrite(true);
    ctl.confirm = async () => 'pending';
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'pending', partial: false });
  });

  it('that answers unavailable is writer-lost', async () => {
    const { ledger } = fileWrite(true);
    ctl.confirm = async () => 'unavailable';
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'writer-lost', partial: false });
  });
});

describe('a file write no deposition dropped', () => {
  it('that answers unavailable stays unavailable', async () => {
    const { ledger } = fileWrite(false);
    ctl.confirm = async () => 'unavailable';
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'unavailable', partial: false });
  });
});
