import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { getNodeName } from '../../src/bot/internalSetup/fleet/nodeName';
import { _resetRowQueue, rowCommitOwed, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { readDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { scriptedBackend, type Sent } from '../helpers/scriptedPg';
import { lost, pgError, sha, sharedRows } from '../helpers/sharedRows';

// NB6 test 3 (wip-redesign/sheets/NB6.md section 5 and the rows of rounds 1 to 8, C4, C6, C9, D1, D6 and E1; part 5):
// the row queue's flush through the real PostgresBackend over scripted clients that answer as the shared tables do
// (helpers/sharedRows.ts). Rows 7 to 9, 12 to 18, 25, 80, 81, 84, 165, 169, 379, 380, and the ticket halves of
// cells 421, 422, 424 and 455.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const CATEGORY = 'nb6flush';
const file = (name: string) => dataPath('global', CATEGORY, name);
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);

const LOCK = /^SELECT now\(\) AS now, pg_advisory_xact_lock\(hashtext\('smdb_shared'\), hashtext\(\$1\)\)$/;
const DOC = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1';
const UPSERT = /^INSERT INTO smdb_data\.shared_docs \(key, body, sha, rev, updated_by\)/;
const OPS_READ = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let warns: string[];
let errors: string[];

beforeEach(() => {
  warns = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
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

function ticketOf(res: dm.SaveTracked | dm.DeleteTracked): RowTicket {
  const ticket = (res as { ticket?: { kind: string } }).ticket;
  expect(ticket?.kind).toBe('row');
  return ticket as unknown as RowTicket;
}

const save = (name: string, value: unknown) => ticketOf(dm.saveDataTracked(name, opts, value));

/** The statements an op's attempts sent, SET LOCAL raises left out. */
const statements = () => rig.sent.map(s => s.sql).filter(sql => !/^SET LOCAL/.test(sql));

/** A statement's values, sent as parameters or inside a query config with a client bound. */
const valuesOf = (s: Sent) => s.params ?? (s.raw as { values?: unknown[] }).values;

/** NB5's hold, started by a silence, confirmed as the chooser would. */
const endHold = () => rig.backend.confirmHold((rig.backend as unknown as { epoch: number }).epoch);

/** Lands a first version through the real flush, so its row, mirror and record are the flush's own. */
async function landed(name: string, value: unknown): Promise<RowTicket> {
  const ticket = save(name, value);
  await dm.flushAll();
  expect(rowTicketState(ticket)).toBe('landed');
  rig.sent.length = 0;
  rows.notices.length = 0;
  return ticket;
}

describe('row 7: the stored sha is the base', () => {
  it('a new key: the row, the op id and one notification at COMMIT; then the mirror and the record', async () => {
    const ticket = save('r7.json', { v: 1 });
    expect(ticket.op.base).toBe('absent');
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rowCommitOwed(ticket)).toBe(false);
    const sent = statements();
    expect(sent[0]).toMatch(/^BEGIN; SET LOCAL statement_timeout = \d+$/);
    expect(sent[1]).toMatch(LOCK);
    expect(sent[2]).toBe(DOC);
    expect(sent[3]).toMatch(UPSERT);
    expect(sent.slice(4)).toEqual(['INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', "SELECT pg_notify('smdb_shared', $1)", 'COMMIT']);
    const stored = rows.docs.get(keyOf('r7.json'))!;
    expect(stored.body.toString('utf8')).toBe(text({ v: 1 }));
    expect(stored.sha).toBe(sha(text({ v: 1 })));
    expect(stored.updated_by.endsWith(`/${processId()}`)).toBe(true);
    expect(rows.ops.size).toBe(1);
    expect(rows.notices.map(n => JSON.parse(n))).toEqual([{ k: 'doc', key: keyOf('r7.json'), sha: stored.sha, rev: Number(stored.rev), by: processId() }]);
    expect(fs.readFileSync(file('r7.json'), 'utf8')).toBe(text({ v: 1 }));
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('r7.json')]).toEqual({ sha: stored.sha, stamp: null, main: null });
    expect(rowQueue.ops(keyOf('r7.json'))).toEqual([]);
  });

  it('a key with a row: the next save carries its sha and raises the rev', async () => {
    await landed('r7b.json', { v: 1 });
    const before = rows.docs.get(keyOf('r7b.json'))!;
    const ticket = save('r7b.json', { v: 2 });
    expect(ticket.op.base).toBe(before.sha);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    const after = rows.docs.get(keyOf('r7b.json'))!;
    expect(after.body.toString('utf8')).toBe(text({ v: 2 }));
    expect(Number(after.rev)).toBeGreaterThan(Number(before.rev));
    expect(rows.notices).toHaveLength(1);
    expect(fs.readFileSync(file('r7b.json'), 'utf8')).toBe(text({ v: 2 }));
  });

  it('a delete removes the row and the mirror and drops the record entry', async () => {
    await landed('r7d.json', { v: 1 });
    const ticket = ticketOf(dm.deleteDataTracked('r7d.json', opts));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.docs.has(keyOf('r7d.json'))).toBe(false);
    expect(fs.existsSync(file('r7d.json'))).toBe(false);
    expect(JSON.parse(rows.notices[0]).sha).toBe('absent');
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('r7d.json')]).toBeUndefined();
  });
});

describe('rows 8 and 25: the stored sha is the new sha', () => {
  it('row 8: nothing is written and nothing announced; the ticket lands', async () => {
    await landed('r8.json', { v: 1 });
    const rev = rows.docs.get(keyOf('r8.json'))!.rev;
    const ticket = save('r8.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements().some(sql => UPSERT.test(sql))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
    expect(rows.docs.get(keyOf('r8.json'))!.rev).toBe(rev);
    expect(rows.notices).toEqual([]);
  });

  it('row 25: a repeated save after a reload from the mirror lands as row 8', async () => {
    await landed('r25.json', { a: 1 });
    expect(dm.loadData('r25.json', opts, null)).toEqual({ a: 1 });
    const ticket = save('r25.json', dm.loadData('r25.json', opts, null));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.notices).toEqual([]);
  });
});

describe('row 9: a plain op meets another machine\'s change', () => {
  it('rolls back, refuses changed-elsewhere and logs decision 6', async () => {
    await landed('r9.json', { v: 1 });
    rows.clock.now = new Date('2026-11-07T11:30:00.000Z');
    rows.put(keyOf('r9.json'), text({ v: 'bravo' }));
    const ticket = save('r9.json', { v: 3 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal).toEqual({ cause: 'changed-elsewhere', by: 'BRAVO', at: new Date('2026-11-07T11:30:00.000Z') });
    expect(statements().some(sql => UPSERT.test(sql))).toBe(false);
    expect(statements()[statements().length - 1]).toBe('ROLLBACK');
    expect(rows.docs.get(keyOf('r9.json'))!.body.toString('utf8')).toBe(text({ v: 'bravo' }));
    expect(warns).toContain(`[Shared] Not saved: ${keyOf('r9.json')}: BRAVO changed it at 2026-11-07T11:30:00.000Z after this machine read it; this machine now holds that version`);
    expect(rowQueue.ops(keyOf('r9.json'))).toEqual([]);
  });
});

describe('row 12: the database refuses the content', () => {
  it.each(['22021', '23514', '54000'])('SQLSTATE %s: rolled back, refused io with the SQLSTATE', async code => {
    rows.fault = sql => (UPSERT.test(sql) ? pgError(code) : undefined);
    const ticket = save(`r12-${code}.json`, { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.cause).toBe('io');
    expect(ticket.op.refusal?.reason).toContain(`SQLSTATE ${code}`);
    expect(statements()).toContain('ROLLBACK');
    expect(rows.docs.size).toBe(0);
  });
});

describe('rows 13 and 14: the database does not take the attempt', () => {
  it('row 13: a connect error keeps the op queued on the backoff; the hold then refuses at checkout, nothing sent', async () => {
    rig.connect.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
    const before = Date.now();
    const ticket = save('r13.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.state).toBe('queued');
    expect(ticket.op.triesFailed).toBeGreaterThanOrEqual(1);
    expect(ticket.op.retryAt).toBeGreaterThan(before);
    expect(ticket.op.retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(rowCommitOwed(ticket)).toBe(false);
    const sentBefore = rig.sent.length;
    await dm.flushAll();
    expect(rig.sent.length).toBe(sentBefore);
    expect(rowTicketState(ticket)).toBe('open');
    endHold();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.docs.get(keyOf('r13.json'))!.body.toString('utf8')).toBe(text({ v: 1 }));
  });

  it('row 14: 28000 keeps the op queued', async () => {
    rows.fault = sql => (/^BEGIN/.test(sql) ? Object.assign(new Error('role is not permitted to log in'), { code: '28000', severity: 'FATAL' }) : undefined);
    const ticket = save('r14.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.state).toBe('queued');
    expect(rows.docs.size).toBe(0);
  });
});

describe('rows 15 to 17: a COMMIT whose answer was lost, and the landing check (decisions 24 and 52, D6)', () => {
  it('row 15: the next attempt finds its id under the lock: ROLLBACK, the ticket lands, nothing written twice', async () => {
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = save('r15.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.unknown).toHaveLength(1);
    const id = ticket.op.unknown[0].id;
    expect(ticket.op.unknown[0].at).toEqual(rows.clock.now);
    expect(rowCommitOwed(ticket)).toBe(true);
    expect(fs.existsSync(file('r15.json'))).toBe(false);
    endHold();
    rig.sent.length = 0;
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements()).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', statements()[1], OPS_READ, DOC, 'ROLLBACK']);
    expect(statements()[1]).toMatch(LOCK);
    expect(valuesOf(rig.sent.find(s => s.sql === OPS_READ)!)).toEqual([[id]]);
    expect([...rows.ops.keys()]).toEqual([id]);
    expect(fs.readFileSync(file('r15.json'), 'utf8')).toBe(text({ v: 1 }));
  });

  it('row 16: no id found: the attempt goes on and writes', async () => {
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? lost() : undefined);
    const ticket = save('r16.json', { v: 1 });
    await dm.flushAll();
    const firstId = ticket.op.unknown[0].id;
    endHold();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.ops.has(firstId)).toBe(false);
    expect(rows.ops.size).toBe(1);
    expect(rows.docs.get(keyOf('r16.json'))!.body.toString('utf8')).toBe(text({ v: 1 }));
  });

  it('row 17 and cell 455: the check gets no answer: the op stays open with its ids on the backoff, then lands', async () => {
    let commits = 0;
    let checks = 0;
    rows.fault = sql => {
      if (sql === 'COMMIT' && ++commits === 1) return 'lose';
      if (sql === OPS_READ && ++checks === 1) return lost();
      return undefined;
    };
    const ticket = save('r17.json', { v: 1 });
    await dm.flushAll();
    endHold();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.state).toBe('queued');
    expect(ticket.op.unknown).toHaveLength(1);
    expect(rowCommitOwed(ticket)).toBe(true);
    expect(ticket.op.triesFailed).toBe(2);
    endHold();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(rows.ops.size).toBe(1);
  });
});

describe('row 18: the next attempt runs on the database written now', () => {
  function twoDatabases() {
    const second = sharedRows();
    let current = rows;
    const backend = scriptedBackend((sql, params, call, client) => current.answer(sql, params, call, client));
    dm.setGuildDataBackend(backend.backend);
    return { backend, second, move: () => { current = second; } };
  }

  it('an id lost on the old main and absent on the new one: the op checks its base there and lands', async () => {
    const two = twoDatabases();
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = save('r18.json', { v: 1 });
    await dm.flushAll();
    two.move();
    two.backend.backend.confirmHold((two.backend.backend as unknown as { epoch: number }).epoch);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(two.second.docs.get(keyOf('r18.json'))!.body.toString('utf8')).toBe(text({ v: 1 }));
    await two.backend.backend.stop();
  });

  it('a new main that lacks the base: the plain op is refused changed-elsewhere', async () => {
    const two = twoDatabases();
    const first = save('r18b.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(first)).toBe('landed');
    two.second.put(keyOf('r18b.json'), text({ v: 0 }));
    two.move();
    const ticket = save('r18b.json', { v: 2 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    await two.backend.backend.stop();
  });
});

describe('row 80: the COMMIT answer arrives after NB5\'s latch rose', () => {
  it('counts as lost: the op keeps the attempt\'s id and no attempt is sent while latched', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    rows.fault = sql => (sql === 'COMMIT' ? held : undefined);
    const ticket = save('r80.json', { v: 1 });
    const flushing = dm.flushAll();
    while (!rig.sent.some(s => s.sql === 'COMMIT')) await new Promise(resolve => { setTimeout(resolve, 1); });
    expect(rowCommitOwed(ticket)).toBe(true);
    rig.backend.latch({ kind: 'tie', generation: 2 });
    release();
    await flushing;
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.unknown).toHaveLength(1);
    expect(rowCommitOwed(ticket)).toBe(true);
    const sentBefore = rig.sent.length;
    await dm.flushAll();
    expect(rig.sent.length).toBe(sentBefore);
    expect(rowTicketState(ticket)).toBe('open');
  });
});

describe('row 81: COMMIT answered, the mirror write fails', () => {
  it('the ticket lands; the entry answers reads; the record is unchanged; 25\'s log once; the write is retried', async () => {
    const ticket = save('r81.json', { v: 1 });
    // The flush's mirror step meets the failing write of the mirror's temp file.
    const real = fs.promises.open.bind(fs.promises);
    const failing = vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(`${file('r81.json')}.`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(ticket.op.state).toBe('mirror');
    expect(rowQueue.entryOf(keyOf('r81.json'))).toBe(ticket.op);
    expect(dm.loadData('r81.json', opts, null)).toEqual({ v: 1 });
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('r81.json')]).toBeUndefined();
    const logged = errors.filter(line => line.startsWith(`[Shared] Saved ${keyOf('r81.json')} in the database, but could not write ${file('r81.json')} (`));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/\(EACCES\); this machine keeps using the saved version and tries again$/);
    failing.mockRestore();
    const until = Date.now() + 5000;
    while (ticket.op.state === 'mirror' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 50); });
    expect(ticket.op.state).toBe('landed');
    expect(fs.readFileSync(file('r81.json'), 'utf8')).toBe(text({ v: 1 }));
    expect(rowQueue.ops(keyOf('r81.json'))).toEqual([]);
  });
});

describe('rows 84 and 165: the check finds the op after other writes (decision 52)', () => {
  async function lostThenWritten(name: string, other: string): Promise<RowTicket> {
    await landed(name, { v: 'base' });
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = save(name, { v: 'mine' });
    await dm.flushAll();
    expect(rowCommitOwed(ticket)).toBe(true);
    rows.put(keyOf(name), other);
    endHold();
    rig.sent.length = 0;
    await dm.flushAll();
    return ticket;
  }

  it('row 84: another machine wrote the base\'s body again: the check finds the id; landed, nothing written', async () => {
    const ticket = await lostThenWritten('r84.json', text({ v: 'base' }));
    expect(rowTicketState(ticket)).toBe('landed');
    expect(statements().some(sql => UPSERT.test(sql))).toBe(false);
    expect(rows.docs.get(keyOf('r84.json'))!.body.toString('utf8')).toBe(text({ v: 'base' }));
    expect(fs.readFileSync(file('r84.json'), 'utf8')).toBe(text({ v: 'base' }));
  });

  it('row 165: another machine wrote after it: the entry, the mirror and the record take the stored body', async () => {
    const ticket = await lostThenWritten('r165.json', text({ v: 'bravo' }));
    expect(rowTicketState(ticket)).toBe('landed');
    expect(ticket.op.body?.toString('utf8')).toBe(text({ v: 'bravo' }));
    expect(fs.readFileSync(file('r165.json'), 'utf8')).toBe(text({ v: 'bravo' }));
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('r165.json')]?.sha).toBe(sha(text({ v: 'bravo' })));
  });
});

describe('row 169: the op ahead is refused for another cause', () => {
  it('the plain op behind, built on its body, is refused with that cause and never sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rows.fault = sql => (UPSERT.test(sql) ? gate.then(() => pgError('22021')) : undefined);
    const ahead = save('r169.json', { v: 1 });
    while (!rig.sent.some(s => UPSERT.test(s.sql))) await new Promise(resolve => { setTimeout(resolve, 1); });
    const behind = save('r169.json', { v: 2 });
    expect(behind.op).not.toBe(ahead.op);
    expect(behind.op.base).toBe(sha(text({ v: 1 })));
    release();
    await dm.flushAll();
    expect(rowTicketState(ahead)).toBe('refused');
    expect(rowTicketState(behind)).toBe('refused');
    expect(behind.op.refusal).toEqual(ahead.op.refusal);
    expect(behind.op.attempts).toBe(0);
  });
});

describe('rows 379 and 380: an op that checks another key (decisions 102 and 109)', () => {
  const PREMIUM = 'global/premium-tiers.json';

  function checked(name: string, check: Record<string, string | null>, value: unknown): RowTicket {
    const body = Buffer.from(text(value), 'utf8');
    return rowQueue.accept(keyOf(name), file(name), { body }, { sha: 'absent', caller: true, check });
  }

  it('row 379: the checked key holds the sha: both keys are locked in sorted order and the op lands', async () => {
    rows.put(PREMIUM, '{"tiers":1}');
    const ticket = checked('a379.json', { [PREMIUM]: sha('{"tiers":1}') }, { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    const locks = rig.sent.filter(s => LOCK.test(s.sql)).map(s => valuesOf(s)?.[0]);
    expect(locks).toEqual([keyOf('a379.json'), PREMIUM].sort());
    expect(rig.sent.some(s => s.sql === 'SELECT sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1' && valuesOf(s)?.[0] === PREMIUM)).toBe(true);
  });

  it('row 380: a check of null with no row lands', async () => {
    const ticket = checked('a380.json', { [PREMIUM]: null }, { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  });

  it('row 380: a check with a sha while the row is absent is refused with T32\'s absent-row form', async () => {
    const ticket = checked('b380.json', { [PREMIUM]: sha('{"tiers":1}') }, { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    expect(warns).toContain(`[Shared] Not saved: ${keyOf('b380.json')}: it was built on ${PREMIUM}, which is no longer in the database`);
    expect(rows.docs.has(keyOf('b380.json'))).toBe(false);
  });

  it('a check that differs from the stored row is refused with T32\'s first form', async () => {
    rows.clock.now = new Date('2026-11-07T12:00:00.000Z');
    rows.put(PREMIUM, '{"tiers":2}');
    const ticket = checked('c380.json', { [PREMIUM]: sha('{"tiers":1}') }, { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(warns).toContain(`[Shared] Not saved: ${keyOf('c380.json')}: it was built on ${PREMIUM}, which BRAVO changed at 2026-11-07T12:00:00.000Z after this machine read it; this machine now holds that version`);
  });

  it('T32 says this machine now holds that version: the applier writes the checked key\'s stored version into its mirror (part 8)', async () => {
    const mirror = await import('../../src/bot/internalSetup/utils/sharedMirror');
    const { _setListenClientFactory } = await import('../../src/bot/internalSetup/utils/sharedListener');
    const { listenRig } = await import('../helpers/nb6Listen');
    _setListenClientFactory(listenRig().factory as never);
    try {
      mirror.startSharedPass();
      rows.put(PREMIUM, '{"tiers":"bravo"}');
      const ticket = checked('d380.json', { [PREMIUM]: sha('{"tiers":1}') }, { v: 1 });
      await dm.flushAll();
      expect(rowTicketState(ticket)).toBe('refused');
      expect(warns.some(l => l.startsWith(`[Shared] Not saved: ${keyOf('d380.json')}: it was built on ${PREMIUM}, which BRAVO changed`) && l.endsWith('this machine now holds that version'))).toBe(true);
      await vi.waitFor(() => expect(fs.readFileSync(dataPath('global', 'premium-tiers.json'), 'utf8')).toBe('{"tiers":"bravo"}'));
    } finally {
      mirror._resetSharedMirror();
      _setListenClientFactory(null);
      fs.rmSync(dataPath('global', 'premium-tiers.json'), { force: true });
    }
  });
});

describe('decision 6 says this machine now holds that version (part 8)', () => {
  it('a plain op refused over another machine\'s change: the applier then writes that version into the mirror', async () => {
    const mirror = await import('../../src/bot/internalSetup/utils/sharedMirror');
    const { _setListenClientFactory } = await import('../../src/bot/internalSetup/utils/sharedListener');
    const { listenRig } = await import('../helpers/nb6Listen');
    _setListenClientFactory(listenRig().factory as never);
    try {
      mirror.startSharedPass();
      await landed('d6.json', { v: 1 });
      rows.put(keyOf('d6.json'), text({ v: 'bravo' }));
      const ticket = save('d6.json', { v: 'mine' });
      await dm.flushAll();
      expect(rowTicketState(ticket)).toBe('refused');
      expect(warns.some(l => l.startsWith(`[Shared] Not saved: ${keyOf('d6.json')}: BRAVO changed it at`) && l.endsWith('this machine now holds that version'))).toBe(true);
      await vi.waitFor(() => expect(fs.readFileSync(file('d6.json'), 'utf8')).toBe(text({ v: 'bravo' })));
      expect(readDocRecord().ok && (readDocRecord() as any).record.docs[keyOf('d6.json')].sha).toBe(sha(text({ v: 'bravo' })));
    } finally {
      mirror._resetSharedMirror();
      _setListenClientFactory(null);
    }
  });
});

describe('cells 421, 422 and 424: the ticket halves', () => {
  it('cell 421: a doc of 4 MiB lands; its upsert and its piece together hold the body', async () => {
    const exact = 'a'.repeat(4 * 1024 * 1024 - 2);
    const ticket = save('c421.json', exact);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    const stored = rows.docs.get(keyOf('c421.json'))!;
    expect(stored.body.length).toBe(4 * 1024 * 1024);
    expect(stored.sha).toBe(sha(JSON.stringify(exact, null, 2)));
    expect(rig.sent.filter(s => /^UPDATE smdb_data\.shared_docs SET body = body \|\| \$2 WHERE key = \$1$/.test(s.sql))).toHaveLength(1);
    expect(fs.statSync(file('c421.json')).size).toBe(4 * 1024 * 1024);
  });

  it('cell 422: a 57014 rolls back; the op stays queued and T35 is logged', async () => {
    let first = true;
    rows.fault = sql => {
      if (!UPSERT.test(sql) || !first) return undefined;
      first = false;
      return pgError('57014', 'canceling statement due to statement timeout');
    };
    const ticket = save('c422.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('open');
    expect(ticket.op.state).toBe('queued');
    expect(warns.some(line => line.startsWith(`[Shared] Saving ${keyOf('c422.json')}: a statement of `) && line.includes('(SQLSTATE 57014)') && line.endsWith('(this machine tries again)'))).toBe(true);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  });

  it('cell 424: an op due while every shared place is taken stays open, holding no client, then lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rows.fault = (sql, params) => (LOCK.test(sql) && String(params?.[0]).includes('/hold-') ? gate : undefined);
    const holders = [0, 1, 2, 3].map(i => save(`hold-${i}.json`, { i }));
    while (rig.sent.filter(s => LOCK.test(s.sql)).length < 4) await new Promise(resolve => { setTimeout(resolve, 1); });
    const ticket = save('c424.json', { v: 1 });
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(rowTicketState(ticket)).toBe('open');
    expect(rig.out()).toBe(4);
    expect(rig.sent.some(s => valuesOf(s)?.[0] === keyOf('c424.json'))).toBe(false);
    release();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    for (const holder of holders) expect(rowTicketState(holder)).toBe('landed');
  });
});

describe('cell 248: a changed-elsewhere refusal carries the stored row\'s writer machine and time (T22, part 6)', () => {
  it('another process of this machine stored it: by is this machine\'s name', async () => {
    await landed('c248.json', { v: 1 });
    rows.clock.now = new Date('2026-11-07T11:40:00.000Z');
    rows.put(keyOf('c248.json'), text({ v: 'other process' }), `${getNodeName()}/p-other`);
    const ticket = save('c248.json', { v: 2 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal).toEqual({ cause: 'changed-elsewhere', by: getNodeName(), at: new Date('2026-11-07T11:40:00.000Z') });
  });

  it('the stored row is gone: the refusal carries neither', async () => {
    await landed('c248b.json', { v: 1 });
    rows.docs.delete(keyOf('c248b.json'));
    const ticket = save('c248b.json', { v: 2 });
    await dm.flushAll();
    expect(ticket.op.refusal).toEqual({ cause: 'changed-elsewhere' });
  });

  it('an update whose re-run fails on another machine\'s version carries that version\'s writer and time', async () => {
    await landed('c248c.json', { n: 1 });
    rows.clock.now = new Date('2026-11-07T11:50:00.000Z');
    rows.put(keyOf('c248c.json'), text({ n: 'not a number' }));
    const res = dm.updateData('c248c.json', opts, { n: 0 }, (current: { n: number }) => {
      if (typeof current.n !== 'number') throw new Error('n is no number');
      return { n: current.n + 1 };
    });
    const ticket = ticketOf(res);
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal).toMatchObject({ cause: 'changed-elsewhere', by: 'BRAVO', at: new Date('2026-11-07T11:50:00.000Z') });
  });
});

describe('cell 426: NB5\'s hold refuses the attempt at checkout', () => {
  it('the op stays queued with nothing sent; confirmWrite answers held', async () => {
    rig.connect.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
    const ticket = save('c426.json', { v: 1 });
    await dm.flushAll();
    const sentBefore = rig.sent.length;
    await dm.flushAll();
    expect(rig.sent.length).toBe(sentBefore);
    expect(ticket.op.state).toBe('queued');
    expect(rowCommitOwed(ticket)).toBe(false);
    expect(await dm.confirmWrite(ticket, 50)).toBe('held');
  });
});

describe('cell 430: a deposition with row ops queued and one on the wire (NB10 decision 20, C9)', () => {
  const OTHER = 6565;
  const WORDS = `a bot process, pid ${OTHER}`;

  afterEach(() => {
    freshWriterLock('webui');
    takeWriterLock();
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
  });

  it.each(['answered', 'lost'] as const)('the queued ops are refused writer-lost; the op on the wire ends (its COMMIT %s) and no mirror is written', async how => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const clients = new Map<number, string>();
    rows.fault = (sql, params, client) => {
      if (LOCK.test(sql)) clients.set(client, String(params?.[0]));
      const key = clients.get(client);
      if (key === keyOf('w430.json') && sql === 'COMMIT') return held.then(() => (how === 'lost' ? 'lose' as const : undefined));
      if (key === keyOf('q430.json') && UPSERT.test(sql)) return pgError('57014', 'canceling statement due to statement timeout');
      return undefined;
    };
    const wire = save('w430.json', { v: 1 });
    const queued = save('q430.json', { v: 1 });
    while (!wire.op.commitOnWire || queued.op.triesFailed === 0) await new Promise(resolve => { setTimeout(resolve, 1); });
    const behind = save('w430.json', { v: 2 });
    expect(behind.op).not.toBe(wire.op);
    freshWriterLock('bot', new Set([process.pid, OTHER]));
    expect(takeWriterLock().kind).toBe('taken');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    for (const ticket of [behind, queued]) {
      expect(rowTicketState(ticket)).toBe('refused');
      expect(ticket.op.refusal).toEqual({ cause: 'writer-lost' });
      expect(await dm.confirmWrite(ticket, 50)).toBe('refused');
    }
    expect(errors).toContain(`[Data] Not saved: ${file('w430.json')}; another process (${WORDS}) took the data files' lock`);
    expect(errors).toContain(`[Data] Not saved: ${file('q430.json')}; another process (${WORDS}) took the data files' lock`);
    expect(rowTicketState(wire)).toBe('open');
    release();
    await dm.flushAll();
    if (how === 'answered') {
      expect(rowTicketState(wire)).toBe('landed');
      expect(rows.docs.get(keyOf('w430.json'))!.body.toString('utf8')).toBe(text({ v: 1 }));
    } else {
      expect(rowTicketState(wire)).toBe('unconfirmed');
      expect(await dm.confirmWrite(wire, 50)).toBe('unavailable');
      expect(errors).toContain(`[Shared] Can't confirm whether ${keyOf('w430.json')} was saved: the database's answer to the save was lost and could not be checked (another process took the data files' lock)`);
    }
    const sentAfter = rig.sent.length;
    await new Promise(resolve => { setTimeout(resolve, 50); });
    await dm.flushAll();
    expect(rig.sent.length).toBe(sentAfter);
    expect(fs.existsSync(file('w430.json'))).toBe(false);
    expect(fs.existsSync(file('q430.json'))).toBe(false);
  });
});

describe('rows 163 and 164: the flush\'s mirror step (decisions 49 and 53; part 8)', () => {
  it('row 163: the main tag changes after the transaction began: the entry keeps the transaction\'s tag, and the next pass decides', async () => {
    const { setView } = await import('../helpers/nb6Mirror');
    const mirror = await import('../../src/bot/internalSetup/utils/sharedMirror');
    try {
      setView(1, 'ALPHA');
      rows.fault = sql => {
        if (sql === 'COMMIT') setView(2, 'BRAVO');
        return undefined;
      };
      const ticket = save('r163.json', { v: 1 });
      await dm.flushAll();
      expect(rowTicketState(ticket)).toBe('landed');
      const record = readDocRecord();
      expect(record.ok && record.record.docs[keyOf('r163.json')]).toMatchObject({ sha: sha(text({ v: 1 })), main: '1:ALPHA' });
      rows.fault = undefined;
      const ino = fs.statSync(file('r163.json')).ino;
      await mirror.runSharedPass();
      const after = readDocRecord();
      expect(after.ok && after.record.docs[keyOf('r163.json')]).toMatchObject({ sha: sha(text({ v: 1 })), main: '2:BRAVO' });
      expect(fs.statSync(file('r163.json')).ino).toBe(ino);
    } finally {
      mirror._resetSharedMirror();
      const { setMainChooser } = await import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase');
      setMainChooser(null);
    }
  });

  it('row 164: a hand edit while the op waits is moved aside before the stored body is written, with T11 (a)', async () => {
    await landed('r164.json', { v: 1 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    rows.fault = sql => (/^BEGIN/.test(sql) ? held.then(() => undefined) : undefined);
    const ticket = save('r164.json', { v: 2 });
    await new Promise(resolve => { setTimeout(resolve, 10); });
    fs.writeFileSync(file('r164.json'), 'hand edit');
    release();
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect(fs.readFileSync(file('r164.json'), 'utf8')).toBe(text({ v: 2 }));
    const root = dataPath('_superseded');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(abs);
        else if (entry.name === 'r164.json') found.push(abs);
      }
    };
    walk(root);
    expect(found).toHaveLength(1);
    expect(fs.readFileSync(found[0], 'utf8')).toBe('hand edit');
    const dest = dataPath('_superseded', ...found[0].slice(root.length + 1).split('/'));
    expect(warns).toContain(`[Shared] Moved ${file('r164.json')} to ${dest}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database's version is back in its place`);
  });
});

describe('rows 74 and 83: the exit drain and the row ops (C6, decision 24; part 7)', () => {
  let listeners: Array<(...args: any[]) => void>;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(() => {
    listeners = process.listeners('uncaughtException');
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const l of process.listeners('uncaughtException')) if (!listeners.includes(l)) process.off('uncaughtException', l);
  });

  /** The exit drain runs once a process and closes the facade: a fresh data layer of its own. */
  async function freshLayer() {
    vi.resetModules();
    (await import('../helpers/backendKind')).setBackendKind('postgres');
    const fresh = await import('../../src/bot/internalSetup/utils/dataManager');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    const scripted = await import('../helpers/scriptedPg');
    const freshRows = sharedRows();
    const freshRig = scripted.scriptedBackend(freshRows.answer);
    fresh.setGuildDataBackend(freshRig.backend);
    cleanups.push(async () => {
      fresh.setGuildDataBackend(null);
      store._resetRowQueue();
      await freshRig.backend.stop();
    });
    const saveFresh = (name: string, value: unknown) => ticketOf(fresh.saveDataTracked(name, opts, value) as dm.SaveTracked);
    return { fresh, freshRows, freshRig, saveFresh };
  }

  it('row 74: the drain stores an op waiting on its backoff within the bound', async () => {
    const { fresh, freshRows, saveFresh } = await freshLayer();
    let upserts = 0;
    freshRows.fault = sql => (UPSERT.test(sql) && ++upserts === 1 ? pgError('40001') : undefined);
    const ticket = saveFresh('r74.json', { v: 1 });
    await fresh.flushAll();
    expect(ticket.op.retryAt).toBeGreaterThan(Date.now());
    await fresh.drainForExit(5000);
    expect(rowTicketState(ticket)).toBe('landed');
    expect(fs.readFileSync(file('r74.json'), 'utf8')).toBe(text({ v: 1 }));
    expect(warns.filter(line => line.startsWith('[Data] Shutdown drain left'))).toEqual([]);
  });

  it('row 74: an op the database does not take is counted in the drain\'s log', async () => {
    const { fresh, freshRows, saveFresh } = await freshLayer();
    freshRows.fault = sql => (UPSERT.test(sql) ? pgError('40001') : undefined);
    const ticket = saveFresh('r74b.json', { v: 1 });
    await fresh.drainForExit(1500);
    expect(rowTicketState(ticket)).toBe('open');
    expect(warns).toContain('[Data] Shutdown drain left 1 file(s) with queued writes');
  }, 10_000);

  it('row 83: an op holding an unknown id that no check could reach before the bound ends unconfirmed', async () => {
    const { fresh, freshRows, freshRig, saveFresh } = await freshLayer();
    const { installHoldingChooser } = await import('../helpers/nb6Hold');
    const hold = installHoldingChooser(freshRig.backend);
    let commits = 0;
    freshRows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? 'lose' : undefined);
    const ticket = saveFresh('r83.json', { v: 1 });
    await fresh.flushAll();
    expect(ticket.op.unknown).toHaveLength(1);
    expect(freshRig.backend.holdWords()).not.toBeNull();
    const sentBefore = freshRig.sent.length;
    await fresh.drainForExit(1000);
    expect(hold.confirms).toBeGreaterThan(0);
    expect(freshRig.sent.length).toBe(sentBefore);
    expect(rowTicketState(ticket)).toBe('unconfirmed');
    expect(await fresh.confirmWrite(ticket, 50)).toBe('unavailable');
    expect(errors).toContain(`[Shared] Can't confirm whether ${keyOf('r83.json')} was saved: the database's answer to the save was lost and could not be checked (the bot process stopped before the database answered a check)`);
    expect(warns.filter(line => line.startsWith('[Data] Shutdown drain left'))).toEqual([]);
  });
});
