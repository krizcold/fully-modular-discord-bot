import { describe, expect, it } from 'vitest';
import {
  decideMain, replacedText, type AnsweredProbe, type NoticeRead, type Probe,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// NB5 section 8 test 3: the table over decideMain (decision 6) with decision 9's texts.

const STORE = 'store-a';
const DATE = '2026-11-01T10:00:00.000Z';

function db(address: string, over: Partial<AnsweredProbe> = {}): AnsweredProbe {
  return {
    kind: 'answered', address, entry: `postgresql://bot:pw@${address}`, inRecovery: false, readOnly: false,
    generation: 1, machine: 'node-a', since: DATE, sysid: `sys-${address}`, started: `start-${address}`, storeId: STORE,
    ...over,
  };
}
const copy = (address: string, over: Partial<AnsweredProbe> = {}) => db(address, { inRecovery: true, ...over });
const failed = (address: string, cause: string): Probe => ({ kind: 'failed', address, entry: address, cause });
const refused = (address: string): Probe => ({ kind: 'refused', address, entry: address });
const opts = { markerStoreId: STORE, noticeCheckOff: false };
const notice = (generation: number, machine: string): NoticeRead => ({ kind: 'notice', generation, machine, date: DATE });

describe('decideMain', () => {
  it('chooses a writable database at generation 0 without asking for a notice', () => {
    const d = decideMain([db('a:5432/bot', { generation: 0, machine: null })], undefined, opts);
    expect(d).toMatchObject({ outcome: 'chosen', generation: 0 });
  });

  it('asks for the notice at generation 1, then chooses with none', () => {
    const probes = [db('a:5432/bot')];
    expect(decideMain(probes, undefined, opts).outcome).toBe('needs-notice');
    const d = decideMain(probes, { kind: 'none' }, opts);
    expect(d.outcome).toBe('chosen');
    if (d.outcome === 'chosen') expect(d.chosen.address).toBe('a:5432/bot');
  });

  it('waits behind a notice at 2 naming another machine, naming both machines and the date', () => {
    const d = decideMain([db('a:5432/bot')], notice(2, 'node-b'), opts);
    expect(d.outcome).toBe('behind-notice');
    if (d.outcome !== 'chosen' && d.outcome !== 'needs-notice') {
      expect(d.reason).toBe(`can't confirm that a:5432/bot is the main: it holds generation 1 (node-a), but generation 2 was announced for node-b on ${DATE}, and no database in DATA_BACKEND_URL holds it. The bot stays stopped. If node-b holds the main now and a:5432/bot is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code or add its address to DATA_BACKEND_URL. If a restore lowered this database's generation, the Bot Manager must raise it to 2 or above`);
    }
  });

  it("waits behind a notice at 3 naming its own machine (F9's text)", () => {
    const d = decideMain([db('a:5432/bot', { generation: 2 })], notice(3, 'node-a'), opts);
    expect(d).toMatchObject({
      outcome: 'behind-notice',
      reason: `can't confirm that a:5432/bot is the main: it holds generation 2, but generation 3 was announced for this machine (node-a) on ${DATE}; a restore may have lowered it. The bot stays stopped until the Bot Manager raises this database's generation to 3 or above`,
    });
  });

  it('never says replaced by M for a restored dump of M taken as N', () => {
    const d = decideMain([db('a:5432/bot', { generation: 2, machine: 'node-n' })], notice(3, 'node-m'), opts);
    expect(d.outcome).toBe('behind-notice');
    expect(JSON.stringify(d)).not.toContain('replaced by');
  });

  it('answers replaced, worded from the copy row, for a writable 1 and a copy at 2', () => {
    const d = decideMain([db('a:5432/bot'), copy('b:5432/bot', { generation: 2, machine: 'node-b' })], undefined, opts);
    expect(d).toMatchObject({
      outcome: 'replaced',
      reason: `The database at a:5432/bot (generation 1, node-a) was replaced by node-b on ${DATE} (generation 2); the bot stays stopped. If that database is on this machine, rejoin it as a live copy in the Bot Manager; otherwise join the new main's code, or add its address to DATA_BACKEND_URL`,
    });
  });

  it('chooses the writable at 2 and logs the writable at 1 as a replaced main', () => {
    const d = decideMain([db('a:5432/bot', { generation: 2, machine: 'node-a' }), db('b:5432/bot', { generation: 1, machine: 'node-b' })], { kind: 'none' }, opts);
    expect(d.outcome).toBe('chosen');
    if (d.outcome === 'chosen') expect(d.chosen.address).toBe('a:5432/bot');
    expect(d.logs).toContain('[Database] Ignoring b:5432/bot: it accepts writes at generation 1, below generation 2 of node-a, so it is a replaced main');
  });

  it('takes two addresses with one started and sysid as one database', () => {
    const d = decideMain([db('a:5432/bot', { sysid: 's', started: 't' }), db('10.0.0.5:5432/bot', { sysid: 's', started: 't' })], { kind: 'none' }, opts);
    expect(d.outcome).toBe('chosen');
  });

  it('takes one started with a null sysid on one side as one database', () => {
    const d = decideMain([db('a:5432/bot', { sysid: null, started: 't' }), db('10.0.0.5:5432/bot', { sysid: 's', started: 't' })], { kind: 'none' }, opts);
    expect(d.outcome).toBe('chosen');
  });

  it('answers tie for two writable servers with one generation row and different start times', () => {
    const d = decideMain([db('a:5432/bot', { sysid: 's', started: 't1' }), db('b:5432/bot', { sysid: 's', started: 't2' })], { kind: 'none' }, opts);
    expect(d).toMatchObject({
      outcome: 'tie',
      reason: "Two databases accept writes at main generation 1: a:5432/bot (node-a) and b:5432/bot (node-a); can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager",
    });
  });

  it('answers tie for a notice at the chosen generation naming another machine', () => {
    expect(decideMain([db('a:5432/bot', { generation: 2 })], notice(2, 'node-b'), opts).outcome).toBe('tie');
  });

  it('answers no-main for only copies, worded as copies', () => {
    const d = decideMain([copy('a:5432/bot', { generation: 2, machine: 'node-b' })], undefined, opts);
    expect(d).toMatchObject({
      outcome: 'no-main',
      reason: 'No address in DATA_BACKEND_URL reaches a database that accepts writes at main generation 2 (node-b): a:5432/bot is a live copy; the bot waits until the main answers or the owner switches in the Bot Manager',
    });
  });

  it('answers no-main for a read-only main, worded as read-only', () => {
    const d = decideMain([db('a:5432/bot', { readOnly: true })], undefined, opts);
    expect(d.outcome).toBe('no-main');
    expect(JSON.stringify(d)).toContain('a:5432/bot is read-only');
  });

  it('answers login-refused when every address refuses, and when one refuses and one fails', () => {
    expect(decideMain([refused('a'), refused('b')], undefined, opts).outcome).toBe('login-refused');
    expect(decideMain([refused('a'), failed('b', 'timeout')], undefined, opts).outcome).toBe('login-refused');
  });

  it('R4-B1: M logs in then times out, B refused: unreachable naming both causes', () => {
    const m = { kind: 'failed', address: 'm:5432/bot', entry: 'm:5432/bot', cause: 'a statement timeout', loggedIn: true } as Probe;
    expect(decideMain([m, refused('b:5432/bot')], undefined, opts)).toMatchObject({
      outcome: 'unreachable',
      reason: 'No database in DATA_BACKEND_URL can be used (b:5432/bot: refused the login (SQLSTATE 28000), m:5432/bot: a statement timeout)',
    });
  });

  it("R4-B1: X holds another bot's store, B refused: unreachable naming both causes", () => {
    const x = db('x:5432/bot', { storeId: 'store-z' });
    expect(decideMain([x, refused('b:5432/bot')], undefined, opts)).toMatchObject({
      outcome: 'unreachable',
      reason: "No database in DATA_BACKEND_URL can be used (b:5432/bot: refused the login (SQLSTATE 28000), x:5432/bot: another bot's store (store-z))",
    });
  });

  it('answers unreachable when none answered', () => {
    expect(decideMain([failed('a:5432/bot', 'timeout'), failed('b:5432/bot', 'unreachable')], undefined, opts)).toMatchObject({
      outcome: 'unreachable',
      reason: 'No database in DATA_BACKEND_URL answers (a:5432/bot: timeout, b:5432/bot: unreachable)',
    });
  });

  it.each([
    ['a timeout', { kind: 'failed', cause: 'timeout' }, false],
    ['a 5xx', { kind: 'failed', cause: 'HTTP 502 Bad Gateway', status: 502 }, false],
    ['a 429', { kind: 'failed', cause: 'HTTP 429 You are being rate limited', status: 429 }, false],
    ['a 403', { kind: 'failed', cause: 'HTTP 403 50007 Cannot send messages to this user', status: 403 }, true],
    ['a 404', { kind: 'failed', cause: 'HTTP 404 10003 Unknown Channel', status: 404 }, true],
  ] as Array<[string, NoticeRead & { kind: 'failed' }, boolean]>)('answers cant-check for %s, with one and with every address answering', (_n, read, override) => {
    for (const probes of [[db('a:5432/bot')], [db('a:5432/bot'), copy('b:5432/bot')]]) {
      const d = decideMain(probes, read, opts);
      expect(d.outcome).toBe('cant-check');
      const reason = (d as { reason: string }).reason;
      expect(reason.startsWith(`can't confirm that a:5432/bot (generation 1) is still the main: the switch notices could not be read (${read.cause})`)).toBe(true);
      expect(reason.includes('DATA_NOTICE_CHECK=off')).toBe(override);
      const off = decideMain(probes, read, { ...opts, noticeCheckOff: true });
      expect(off.outcome).toBe('chosen');
      expect(off.logs).toContain(`[Database] The switch notices could not be read (${read.cause}); DATA_NOTICE_CHECK is off, so the choice rests on the databases alone`);
    }
  });

  it.each([
    ['generation', 'an unreadable generation (permission denied for table generation)'],
    ['store id', 'an unreadable store id (permission denied for table meta)'],
  ])('an unreadable %s at M is never read as 0: the replaced main at 1 is not chosen (no-main, M named with its cause)', (_what, cause) => {
    const probes = [failed('m:5432/bot', cause), db('a:5432/bot')];
    for (const [read, off] of [[undefined, false], [{ kind: 'none' } as NoticeRead, false], [{ kind: 'failed', cause: 'timeout' } as NoticeRead, true]] as const) {
      const d = decideMain(probes, read, { ...opts, noticeCheckOff: off });
      expect(d).toMatchObject({
        outcome: 'no-main',
        reason: `can't confirm which database is the main: m:5432/bot: ${cause}; the bot waits until those rows can be read or the owner switches in the Bot Manager`,
      });
    }
  });

  it('with M unreadable and a copy at 2, A at 1 is a replaced main, worded from the copy row', () => {
    const d = decideMain([failed('m:5432/bot', 'an unreadable generation (more than one row)'), copy('c:5432/bot', { generation: 2, machine: 'node-m' }), db('a:5432/bot')], undefined, opts);
    expect(d).toMatchObject({ outcome: 'replaced', reason: replacedText('a:5432/bot', 1, 'node-a', 'node-m', DATE, 2) });
  });

  it('with M unreadable alone, the answer names M as unreadable, never "No database ... answers" (no-main)', () => {
    const cause = 'an unreadable generation (SQLSTATE 42501)';
    expect(decideMain([failed('m:5432/bot', cause)], undefined, opts)).toMatchObject({
      outcome: 'no-main',
      reason: `can't confirm which database is the main: m:5432/bot: ${cause}; the bot waits until those rows can be read or the owner switches in the Bot Manager`,
    });
  });

  it('with M unreadable beside a refused login at B, the answer names M as unreadable, never login-refused (no-main)', () => {
    const cause = 'an unreadable generation (SQLSTATE 42501)';
    expect(decideMain([failed('m:5432/bot', cause), refused('b:5432/bot')], undefined, opts)).toMatchObject({
      outcome: 'no-main',
      reason: `can't confirm which database is the main: m:5432/bot: ${cause}; the bot waits until those rows can be read or the owner switches in the Bot Manager`,
    });
  });

  it('with M unreadable beside a copy at the top generation,the answer names M as unreadable, not the copies-only text', () => {
    const cause = 'an unreadable store id (SQLSTATE 42501)';
    expect(decideMain([failed('m:5432/bot', cause), copy('c:5432/bot', { generation: 2, machine: 'node-m' })], undefined, opts)).toMatchObject({
      outcome: 'no-main',
      reason: `can't confirm which database is the main: m:5432/bot: ${cause}; the bot waits until those rows can be read or the owner switches in the Bot Manager`,
    });
  });

  it("fails another store's address at 3 and chooses this store's main at 1", () => {
    const d = decideMain([db('x:5432/bot', { generation: 3, storeId: 'other' }), db('a:5432/bot')], { kind: 'none' }, opts);
    expect(d.outcome).toBe('chosen');
    if (d.outcome === 'chosen') expect(d.chosen.address).toBe('a:5432/bot');
    expect(d.logs).toContain("[Database] Ignoring x:5432/bot: it holds another bot's store (other), not this machine's (store-a)");
  });

  it('answers mixed-stores with no marker store id and two store ids', () => {
    const d = decideMain([db('a:5432/bot', { storeId: 's1' }), db('b:5432/bot', { storeId: 's2', generation: 0 })], undefined, { markerStoreId: null, noticeCheckOff: false });
    expect(d).toMatchObject({
      outcome: 'mixed-stores',
      reason: 'DATA_BACKEND_URL reaches databases of different bots (store s1 at a:5432/bot, store s2 at b:5432/bot) and this machine records no store id yet; remove the wrong address',
    });
  });

  it('chooses with no marker store id and one store id', () => {
    expect(decideMain([db('a:5432/bot', { storeId: 's1' })], { kind: 'none' }, { markerStoreId: null, noticeCheckOff: false }).outcome).toBe('chosen');
  });
});
