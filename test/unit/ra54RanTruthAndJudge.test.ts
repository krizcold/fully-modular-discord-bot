import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stopping: false,
  confirm: new Map<object, string>(),
  dropped: new Set<object>(),
  states: new Map<object, string>(),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    isStopping: () => h.stopping,
    confirmWrite: (ticket: any, ms: number) => (h.confirm.has(ticket) ? Promise.resolve(h.confirm.get(ticket)) : real.confirmWrite(ticket, ms)),
    commitOwed: () => false,
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    droppedByDeposition: (record: any) => h.dropped.has(record) || real.droppedByDeposition(record),
    fileTicketState: (ticket: any) => (h.states.has(ticket.record) ? h.states.get(ticket.record) : real.fileTicketState(ticket)),
  };
});

import { ranTruthText, verdictOf, type TruthAnswer } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import type { WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

afterEach(() => {
  h.stopping = false;
  h.confirm.clear();
  h.dropped.clear();
  h.states.clear();
});

const ran = (cause: string) => `The action ran, but ${cause}. Check the server before you run it again.`;
const text = (answer: TruthAnswer, partial: boolean, changed?: any) => ranTruthText({ answer, partial, ...(changed !== undefined ? { changed } : {}) });

describe('ranTruthText names each cause exactly', () => {
  const causes: [TruthAnswer, string][] = [
    ['node-stopping', 'the bot is restarting, so its changes'],
    ['maintenance', 'the bot is in maintenance, so its changes'],
    ['writer-lost', "another process took over the bot's data files, so its changes"],
    ['database-unreachable', "the bot's database is unreachable, so its changes"],
    ['database-backlog', "the bot's database is behind on saving changes, so its changes"],
    ['frozen', "this server's data is not served by this bot process right now, so its changes"],
    ['not-ready', "this server's data is still loading, so its changes"],
    ['storage-failing', 'the bot cannot write to its disk right now, so its changes'],
    ['io', 'the bot could not write to storage, so its changes'],
  ];
  for (const [answer, cause] of causes) {
    it(`${answer}: whole and partial`, () => {
      expect(text(answer, false)).toBe(ran(`${cause} were not saved`));
      expect(text(answer, true)).toBe(ran(`${cause} were not saved in full`));
    });
  }

  it('changed-elsewhere with no facts says another machine changed it', () => {
    expect(text('changed-elsewhere', false)).toBe(ran("another machine changed this data while the action's changes were being saved, so they were not saved"));
  });

  it('changed-elsewhere by this machine says on this machine', () => {
    const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(text('changed-elsewhere', true, { machine: null, at })).toBe(
      ran('this data was changed on this machine at 2026-01-02T03:04:05.000Z after the action read it, so its changes were not saved in full'));
  });

  it('unavailable says it cannot confirm, with in full only when partial', () => {
    expect(text('unavailable', false)).toBe(ran("the bot can't confirm whether its changes were saved"));
    expect(text('unavailable', true)).toBe(ran("the bot can't confirm whether its changes were saved in full"));
  });

  it('held says storage refused them for now', () => {
    expect(text('held', false)).toBe(ran('its changes were not saved yet: storage refused them for now, and the bot keeps retrying'));
    expect(text('held', true)).toBe(ran('its changes were not saved in full yet: storage refused them for now, and the bot keeps retrying'));
  });

  it('pending says not confirmed as saved yet', () => {
    expect(text('pending', false)).toBe(ran('its changes are not confirmed as saved yet'));
    expect(text('pending', true)).toBe(ran('its changes are not confirmed as saved in full yet'));
  });
});

describe('ranTruthText while the bot stops', () => {
  const restarting = (full: string) => ran(`the bot is restarting and could not confirm its changes were saved${full}; they may be lost`);

  it('held and pending say the bot is restarting, with in full only when partial', () => {
    h.stopping = true;
    expect(text('pending', false)).toBe(restarting(''));
    expect(text('pending', true)).toBe(restarting(' in full'));
    expect(text('held', true)).toBe(restarting(' in full'));
  });

  it('another cause keeps its own text', () => {
    h.stopping = true;
    expect(text('io', false)).toBe(ran('the bot could not write to storage, so its changes were not saved'));
    expect(text('unavailable', false)).toBe(ran("the bot can't confirm whether its changes were saved"));
  });
});

const ledger = (tickets: any[], refused: any[] = []): WriteLedger => ({
  tickets: () => tickets.map(ticket => ({ ticket })),
  refusedDocs: () => refused,
  rewriteSeq: () => 0,
  landedDropped: false,
}) as unknown as WriteLedger;

const row = (state: string, refusal?: any, seq = 1) => ({ kind: 'row', key: 'k', op: { state, ...(refusal ? { refusal } : {}) }, seq });
const file = (state: string, dropped: boolean) => {
  const record = { landed: 0 };
  h.states.set(record, state);
  if (dropped) h.dropped.add(record);
  return { kind: 'file', path: 'x.json', seq: 1, record };
};
const IO_REFUSAL = [{ cause: 'io', doc: 'd.json', seq: 1, retried: false }];

describe('a refusal verdict says not saved in full only when another write may be stored', () => {
  it('a row the flush refused stores nothing, so the refusal is whole', async () => {
    expect(await verdictOf([ledger([row('refused')], IO_REFUSAL)])).toEqual({ ok: false, answer: 'io', partial: false });
  });

  it('a row not yet landed may be stored, so the refusal is partial', async () => {
    expect(await verdictOf([ledger([row('open')], IO_REFUSAL)])).toEqual({ ok: false, answer: 'io', partial: true });
  });

  it('a file line the deposition dropped before any byte is not stored; one already written may be', async () => {
    expect(await verdictOf([ledger([file('open', true)], IO_REFUSAL)])).toEqual({ ok: false, answer: 'io', partial: false });
    expect(await verdictOf([ledger([file('written', true)], IO_REFUSAL)])).toEqual({ ok: false, answer: 'io', partial: true });
  });
});

describe('a confirmed verdict names what a changed-elsewhere refusal met only for that answer', () => {
  const at = new Date(Date.UTC(2026, 4, 6, 7, 8, 9));
  const elsewhere = () => row('open', { cause: 'changed-elsewhere', by: 'ZULU-ra54', at });

  it('a worse answer carries no changed facts', async () => {
    const a = elsewhere();
    const b = row('open', { cause: 'maintenance' }, 2);
    h.confirm.set(a, 'refused');
    h.confirm.set(b, 'refused');
    const v = await verdictOf([ledger([a, b])]);
    expect(v).toMatchObject({ ok: false, answer: 'maintenance' });
    expect(Object.keys(v)).not.toContain('changed');
  });

  it('the facts come from the changed-elsewhere write even when another refused write is listed first', async () => {
    const c = row('open', { cause: 'io' }, 1);
    const a = elsewhere();
    a.seq = 2;
    h.confirm.set(c, 'refused');
    h.confirm.set(a, 'refused');
    const v = await verdictOf([ledger([c, a])]);
    expect(v).toMatchObject({ ok: false, answer: 'changed-elsewhere', changed: { machine: 'ZULU-ra54', at } });
    expect(text('changed-elsewhere', false, (v as any).changed)).toBe(
      ran('this data was changed on ZULU-ra54 at 2026-05-06T07:08:09.000Z after the action read it, so its changes were not saved'));
  });

  it('another cause alone carries no changed key', async () => {
    const c = row('open', { cause: 'io' });
    h.confirm.set(c, 'refused');
    const v = await verdictOf([ledger([c])]);
    expect(v).toMatchObject({ ok: false, answer: 'io' });
    expect(Object.keys(v)).not.toContain('changed');
  });
});
