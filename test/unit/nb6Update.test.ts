import fs from 'fs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

// NB6 test 4 (wip-redesign/sheets/NB6.md section 9, decisions 5 and 23, C11): an update of a shared key on a Postgres
// bot. Part 4 built cell 432; part 5 the flush's re-run: rows 10 and 11, cell 431 and the property.

const CATEGORY = 'nb6update';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const text = (value: unknown) => JSON.stringify(value, null, 2);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cell 432: the shared mirror does not parse', () => {
  it('refuses the update io without running fn; nothing is queued and the mirror is untouched', async () => {
    const file = dataPath('global', 'nb6update', 'bad.json');
    setBackendKind('file');
    expect(dm.writeRawAtomicTracked(file, '{not json')).toEqual({ accepted: true });
    await dm.flushAll();
    setBackendKind('postgres');
    const calls: unknown[] = [];
    const res = dm.updateGlobalData('bad.json', {}, value => {
      calls.push(value);
      return { v: 1 };
    }, 'nb6update');
    expect(res).toEqual({ outcome: 'refused', cause: 'io' });
    expect(calls).toEqual([]);
    expect(rowQueue.keys()).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('the flush re-runs an update on the stored value', () => {
  let rows: ReturnType<typeof sharedRows>;
  let rig: ReturnType<typeof scriptedBackend>;

  beforeEach(() => {
    setBackendKind('postgres');
    rows = sharedRows();
    rig = scriptedBackend(rows.answer);
    dm.setGuildDataBackend(rig.backend);
  });

  afterEach(async () => {
    dm.setGuildDataBackend(null);
    _resetRowQueue();
    await rig.backend.stop();
  });

  const update = (name: string, fn: (v: any) => any, fallback: unknown = { n: 0 }) => {
    const res = dm.updateGlobalData(name, fallback, fn, CATEGORY);
    expect(res.outcome).toBe('saved');
    return (res as { ticket: unknown }).ticket as RowTicket;
  };

  async function storedFirst(name: string, value: unknown): Promise<void> {
    const ticket = update(name, () => value);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  }

  it('row 10: another machine changed the key: each fn runs again on the stored value; the result is stored and mirrored', async () => {
    await storedFirst('r10.json', { n: 1 });
    rows.put(keyOf('r10.json'), text({ n: 5 }));
    const inc = update('r10.json', (v: any) => ({ n: v.n + 1 }));
    const dbl = update('r10.json', (v: any) => ({ n: v.n * 2 }));
    expect(dbl.op).toBe(inc.op);
    expect(inc.op.body?.toString('utf8')).toBe(text({ n: 4 }));
    await dm.flushAll();
    expect(rowTicketState(inc)).toBe('landed');
    expect(rows.docs.get(keyOf('r10.json'))?.body.toString('utf8')).toBe(text({ n: 12 }));
    expect(fs.readFileSync(dataPath('global', CATEGORY, 'r10.json'), 'utf8')).toBe(text({ n: 12 }));
    expect(dm.loadData('r10.json', { scope: 'global', category: CATEGORY }, null)).toEqual({ n: 12 });
  });

  it('row 10: with no row stored, the first fn runs on a copy of its default', async () => {
    await storedFirst('r10b.json', { n: 1 });
    rows.docs.delete(keyOf('r10b.json'));
    const seen: unknown[] = [];
    const fallback = { n: 100 };
    const ticket = update('r10b.json', (v: any) => { seen.push(v); return { n: v.n + 1 }; }, fallback);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(seen).toEqual([{ n: 1 }, { n: 100 }]);
    expect(seen[1]).not.toBe(fallback);
    expect(rows.docs.get(keyOf('r10b.json'))?.body.toString('utf8')).toBe(text({ n: 101 }));
  });

  it('row 11: a re-run that throws refuses the op changed-elsewhere with decision 5\'s text', async () => {
    await storedFirst('r11.json', { n: 1 });
    rows.put(keyOf('r11.json'), text({ n: 50 }));
    const ticket = update('r11.json', (v: any) => {
      if (v.n > 10) throw new Error('too many');
      return { n: v.n + 1 };
    });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal).toEqual({
      cause: 'changed-elsewhere',
      reason: `${keyOf('r11.json')}: the update could not be applied to the newer version another machine saved (too many)`,
      by: 'BRAVO',
      at: rows.clock.now,
    });
    expect(rows.docs.get(keyOf('r11.json'))?.body.toString('utf8')).toBe(text({ n: 50 }));
  });

  it('row 11: a re-run whose result no store takes is refused the same way, with the value rule\'s reason', async () => {
    await storedFirst('r11b.json', { n: 1 });
    rows.put(keyOf('r11b.json'), text({ n: 2 }));
    const ticket = update('r11b.json', (v: any) => (v.n === 2 ? { n: 10n } : { n: v.n + 1 }));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.reason).toMatch(new RegExp(`^${keyOf('r11b.json')}: the update could not be applied to the newer version another machine saved \\(.+\\)$`));
  });

  const RERUNS: Array<[string, (v: any) => unknown, string]> = [
    ['writes data of its own', v => {
      try {
        dm.saveGlobalData('other.json', { x: 1 }, CATEGORY);
      } catch { /* the write is refused inside an update */ }
      return v;
    }, '[Data] The update function made a data write of its own; the update was not saved'],
    ['returns undefined', () => undefined, '[Data] The update function returned undefined; it must return the new value. The update was not saved'],
    ['returns a promise', () => Promise.resolve({ n: 1 }), '[Data] The update function returned a promise; it must return the new value without awaiting. The update was not saved'],
  ];

  it.each(RERUNS)('cell 431: a re-run that %s is refused changed-elsewhere with the TypeError message', async (what, rerun, message) => {
    const name = `c431-${what.split(' ')[0]}.json`;
    await storedFirst(name, { n: 1 });
    rows.put(keyOf(name), text({ n: 7 }));
    let runs = 0;
    const ticket = update(name, (v: any) => (++runs === 1 ? { n: v.n + 1 } : rerun(v)));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal).toEqual({
      cause: 'changed-elsewhere',
      reason: `${keyOf(name)}: the update could not be applied to the newer version another machine saved (${message})`,
      by: 'BRAVO',
      at: rows.clock.now,
    });
    expect(rows.docs.get(keyOf(name))?.body.toString('utf8')).toBe(text({ n: 7 }));
  });

  it('property: the stored result is the fold of the fns over the stored value', async () => {
    let round = 0;
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.array(fc.tuple(fc.constantFrom('add', 'mul', 'neg'), fc.integer({ min: -5, max: 5 })), { minLength: 1, maxLength: 5 }),
      async (local, stored, steps) => {
        const name = `prop-${round++}.json`;
        await storedFirst(name, { n: local });
        rows.put(keyOf(name), text({ n: stored }));
        const fns = steps.map(([kind, k]) => (v: any) => ({ n: kind === 'add' ? v.n + k : kind === 'mul' ? v.n * k : -v.n }));
        const tickets = fns.map(fn => update(name, fn));
        await dm.flushAll();
        const expected = fns.reduce<{ n: number }>((v, fn) => fn(v), { n: stored });
        expect(rowTicketState(tickets[0])).toBe('landed');
        expect(rows.docs.get(keyOf(name))!.body.toString('utf8')).toBe(text(expected));
      },
    ), { numRuns: 40 });
  });
});
