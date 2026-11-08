import fs from 'fs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowCommitOwed, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { lost, sha, sharedRows } from '../helpers/sharedRows';

// NB6 test 38 (wip-redesign/sheets/NB6.md decisions 24 and 52; part 5): op ids and the landing check's end. Rows 85
// and 176 (the check's own now() 6 days past the oldest unknown id), 177 (the process clock is not read), and the
// property: with the key's lock, lost answers and other machines' writes in any order, every op is stored at most once
// and never over a write whose bytes it did not read.

const CATEGORY = 'nb6opid';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);
const DAY = 24 * 60 * 60 * 1000;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const endHold = () => rig.backend.confirmHold((rig.backend as unknown as { epoch: number }).epoch);

function save(name: string, value: unknown): RowTicket {
  const res = dm.saveDataTracked(name, opts, value);
  return (res as { ticket: unknown }).ticket as RowTicket;
}

/** An attempt whose COMMIT never reached the database and whose answer was lost: one unknown id that did not land. */
async function lostAttempt(name: string): Promise<RowTicket> {
  let commits = 0;
  rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? lost() : undefined);
  const ticket = save(name, { v: 1 });
  await dm.flushAll();
  expect(rowCommitOwed(ticket)).toBe(true);
  endHold();
  return ticket;
}

describe('rows 85 and 176: the oldest unknown id is 6 days old by the check\'s now()', () => {
  it('ends unconfirmed with decision 24\'s log; nothing is written', async () => {
    const ticket = await lostAttempt('r176.json');
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('unconfirmed');
    expect(rows.docs.has(keyOf('r176.json'))).toBe(false);
    expect(errors).toContain(`[Shared] Can't confirm whether ${keyOf('r176.json')} was saved: the database's answer to the save was lost and could not be checked (its oldest attempt was made 6 or more days ago)`);
    await dm.flushAll();
    expect(rig.sent.filter(s => /^BEGIN/.test(s.sql))).toHaveLength(2);
  });

  it('a check that finds the id lands, however old the id', async () => {
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = save('r176b.json', { v: 1 });
    await dm.flushAll();
    endHold();
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY + 1);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  });

  it('5 days and 23 hours later the check goes on and writes', async () => {
    const ticket = await lostAttempt('r176c.json');
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY - 60 * 60 * 1000);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.docs.get(keyOf('r176c.json'))?.body.toString('utf8')).toBe(text({ v: 1 }));
  });
});

describe('row 177: the process clock is not read', () => {
  it('a process clock 10 days ahead of the database ends nothing early', async () => {
    const ticket = await lostAttempt('r177.json');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(rows.clock.now.getTime() + 10 * DAY);
    rows.clock.now = new Date(rows.clock.now.getTime() + DAY);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  });

  it('a process clock 10 days behind ends it at the database\'s 6 days', async () => {
    const ticket = await lostAttempt('r177b.json');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(rows.clock.now.getTime() - 10 * DAY);
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('unconfirmed');
  });
});

type Event = 'save' | 'other' | 'lose-applied' | 'lose-dropped' | 'check-fails' | 'flush';

describe('property: each op is stored at most once and only over the bytes it read', () => {
  it('holds for any order of saves, other machines\' writes, lost answers and failed checks', async () => {
    let round = 0;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<Event>('save', 'save', 'other', 'lose-applied', 'lose-dropped', 'check-fails', 'flush', 'flush'), { minLength: 1, maxLength: 14 }),
      async events => {
        const name = `p${round++}.json`;
        const key = keyOf(name);
        const faults: Array<'lose-applied' | 'lose-dropped' | 'check-fails'> = [];
        rows.fault = sql => {
          if (sql === 'COMMIT' && (faults[0] === 'lose-applied' || faults[0] === 'lose-dropped')) return faults.shift() === 'lose-applied' ? 'lose' : lost();
          if (sql === 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)' && faults[0] === 'check-fails') {
            faults.shift();
            return lost();
          }
          return undefined;
        };
        const saves: Array<{ value: string; ticket: RowTicket }> = [];
        let n = 0;
        for (const event of events) {
          if (event === 'save') {
            const value = text({ round, n: n++ });
            saves.push({ value, ticket: save(name, JSON.parse(value)) });
          } else if (event === 'other') {
            rows.put(key, text({ round, other: n++ }));
          } else if (event === 'flush') {
            endHold();
            await dm.flushAll();
          } else {
            faults.push(event);
          }
        }
        faults.length = 0;
        for (let i = 0; i < 20 && saves.some(s => rowTicketState(s.ticket) === 'open'); i++) {
          endHold();
          await dm.flushAll();
        }
        for (const s of saves) expect(rowTicketState(s.ticket)).not.toBe('open');
        const ours = rows.history.filter(h => h.key === key && h.ids.length > 0);
        for (const h of ours) expect(h.ids).toHaveLength(1);
        for (const s of saves) {
          const stored = ours.filter(h => h.after === sha(s.value));
          expect(stored.length).toBeLessThanOrEqual(1);
          for (const h of stored) expect(h.before).toBe(s.ticket.op.base);
        }
        expect(ours.length).toBeLessThanOrEqual(new Set(saves.map(s => s.ticket.op)).size);
      },
    ), { numRuns: 60 });
  });
});
