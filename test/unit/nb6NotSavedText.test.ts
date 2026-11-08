import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { openLedger, recordRefusal, runInLedger, markRetried } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { scriptedBackend } from '../helpers/scriptedPg';
import { pgError, sha, sharedRows } from '../helpers/sharedRows';

// NB6 test 11 (wip-redesign/sheets/NB6.md decision 26, row 82, T22 and D1; part 5 built its truthText row, part 6 the
// rest): the 'changed-elsewhere' refusal's text, NB10's never-retried list holding it, and a row ticket the flush
// refuses through confirmWrite, confirmSaved, verdictOf, its RANK place and a global.write op's answer.

describe('the changed-elsewhere refusal', () => {
  it('truthText answers decision 26\'s text, whole and partial', () => {
    expect(truthText('changed-elsewhere', false)).toBe('Another machine changed this data while your change was being saved, so your change was not saved. Reload to see the current values, then try again.');
    expect(truthText('changed-elsewhere', true)).toBe('Another machine changed this data while your change was being saved, so your change was not saved in full. Reload to see the current values, then try again.');
  });

  it('is never marked retried in a ledger', () => {
    const ledger = openLedger('console');
    runInLedger(ledger, 'm', () => {
      recordRefusal('changed-elsewhere', 'global:a.json');
      recordRefusal('io', 'global:a.json');
      markRetried('global:a.json');
    });
    expect(ledger.refusedDocs().map(({ cause, retried }) => ({ cause, retried })).sort((a, b) => a.cause.localeCompare(b.cause))).toEqual([
      { cause: 'changed-elsewhere', retried: false },
      { cause: 'io', retried: true },
    ]);
  });
});

const CATEGORY = 'nb6notsaved';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);
const UPSERT = /^INSERT INTO smdb_data\.shared_docs/;
const T22_BRAVO = 'This data was changed on BRAVO at 2026-11-07T11:30:00.000Z after your change read it, so your change was not saved. Reload to see the current values, then try again.';

describe('row 82: a row ticket the flush refuses', () => {
  let rows: ReturnType<typeof sharedRows>;
  let rig: ReturnType<typeof scriptedBackend>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    // A fresh take clears a deposition this process saw; the release leaves no lock file.
    freshWriterLock('webui');
    takeWriterLock();
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    vi.restoreAllMocks();
  });

  const save = (name: string, value: unknown): RowTicket => {
    const res = dm.saveDataTracked(name, opts, value);
    expect(res.outcome).toBe('saved');
    return (res as { ticket: unknown }).ticket as RowTicket;
  };

  /** A key landed by the real flush, then changed by BRAVO at 11:30. */
  async function changedByBravo(name: string): Promise<void> {
    save(name, { v: 1 });
    await dm.flushAll();
    rows.clock.now = new Date('2026-11-07T11:30:00.000Z');
    rows.put(keyOf(name), text({ v: 'bravo' }));
  }

  it('confirmWrite and confirmSaved answer refused; the verdict is the refusal with its cause; the reply is T22', async () => {
    await changedByBravo('r82.json');
    const ledger = openLedger('console');
    const since = dm.saveMark();
    const ticket = runInLedger(ledger, 'm', () => save('r82.json', { v: 2 }));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(await dm.confirmWrite(ticket, 50)).toBe('refused');
    expect(await dm.confirmSaved('global', { since, deadlineMs: 50 })).toBe('refused');
    expect(await dm.confirmSaved('global', { since, deadlineMs: 50, category: CATEGORY })).toBe('refused');
    expect(await dm.confirmSaved('global', { since, deadlineMs: 50, category: 'elsewhere' })).toBe('ok');
    const verdict = await verdictOf([ledger]);
    expect(verdict).toMatchObject({ ok: false, answer: 'changed-elsewhere', partial: false });
    expect(verdict.ok === false && truthText(verdict.answer, verdict.partial, verdict.changed)).toBe(T22_BRAVO);
  });

  it('RANK: changed-elsewhere is worse than io and than writer-lost, so it names the text', async () => {
    await changedByBravo('rank.json');
    const ledger = openLedger('console');
    runInLedger(ledger, 'm', () => save('rank.json', { v: 2 }));
    rows.fault = (sql, params) => (UPSERT.test(sql) && params?.[0] === keyOf('io.json') ? pgError('22021') : undefined);
    runInLedger(ledger, 'm', () => save('io.json', { v: 1 }));
    await dm.flushAll();
    dm.setGuildDataBackend(null);
    const unsent = runInLedger(ledger, 'm', () => save('lost.json', { v: 1 }));
    freshWriterLock('bot', new Set([process.pid, 6464]));
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 6464, start: null, role: 'bot', at: Date.now() }));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    expect(unsent.op.refusal?.cause).toBe('writer-lost');
    const verdict = await verdictOf([ledger]);
    expect(verdict).toMatchObject({ ok: false, answer: 'changed-elsewhere', partial: false });
  });

  it("a global.write op's answer is T22", async () => {
    await changedByBravo('op.json');
    const reply = await applySharedOp({
      op: 'global.write',
      args: { rel: `${CATEGORY}/op.json`, contentJson: text({ v: 2 }), expectSha: sha(text({ v: 1 })) },
    });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'changed-elsewhere', partial: false, error: T22_BRAVO });
  });
});
