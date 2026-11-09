import { describe, expect, it } from 'vitest';

// NB15 review finding NB15-ORACLE-ROWS: a holder's claim empties a request row's body (decision 16), so `sql requests`
// never casts an empty body and lists a taken row of the run's span with no key; the checker judges such rows by count.
import { buildHistory, judgeRequests, parseRequests } from '../oracle/judge.mjs';
import { requestsSql } from '../oracle/oracle.mjs';

const GUILD = '123456789012345678';
const RUN = 'rq1';
const SPAN = { from: '2026-11-09T10:00:00.000Z', to: '2026-11-09T10:05:00.000Z' };

const row = (over: Record<string, unknown>) => JSON.stringify({ id: 'r', op: 'write', state: 'done', k: null, c: null, taken: true, reply: '{"ok":true}', ...over });

/** One lane's log: a start line, each write's send and answer, and an end line. */
function log(writes: Array<{ key: string; c: number; status: number; cls: string; remote?: boolean; definite?: boolean; op?: 'write' | 'delete' }>) {
  const events: any[] = [{ t: 'start', run: RUN, guild: GUILD, lanes: [{ name: 'a' }], sink: 'file', startedAt: SPAN.from }];
  writes.forEach((w, i) => {
    events.push({ t: 'send', id: i + 1, lane: 'a', op: w.op ?? 'write', kind: 'u', key: w.key, c: w.c, h: w.op === 'delete' ? null : `h${i}`, at: i * 10 });
    events.push({ t: 'ans', id: i + 1, at: i * 10 + 5, status: w.status, cls: w.cls, definite: w.definite === true, ...(w.remote ? { remote: true } : {}) });
  });
  events.push({ t: 'end', at: 1000, endedAt: SPAN.to });
  return events;
}

/** The rows in snapshots at most 90 s apart, from 60 s after the span starts to 30 s after its end, so none can be missed. */
const whole = (lines: string[]) => ['10:01:00', '10:02:30', '10:04:00', '10:05:30']
  .flatMap(t => [...lines, JSON.stringify({ snapshot: `2026-11-09T${t}.000Z`, rows: lines.length })]).join('\n');

const verdictsOf = (writes: Parameters<typeof log>[0], lines: string[]) => {
  const judged = judgeRequests(buildHistory([log(writes)]), parseRequests('requests', whole(lines)));
  expect(judged.reasons).toEqual([]);
  return judged.verdicts.map(v => `${v.v} ${v.key}`);
};

describe('sql requests and a claimed row with an empty body', () => {
  it('the listing never casts an empty body and lists a taken row with no body inside the span, with no key', () => {
    const sql = requestsSql(GUILD, RUN, SPAN);
    expect(sql).not.toContain('body::jsonb');
    expect(sql).toContain("NULLIF(q.body, '')::jsonb AS b");
    expect(sql).toContain("(r.b IS NULL AND r.taken_at IS NOT NULL AND r.created_at >= '2026-11-09T10:00:00.000Z'::timestamptz - interval '30 seconds' AND r.created_at <= '2026-11-09T10:05:00.000Z'::timestamptz + interval '30 seconds')");
    expect(requestsSql(GUILD, RUN, { from: SPAN.from, to: null })).not.toContain('r.created_at <=');
    expect(() => requestsSql(GUILD, RUN, { from: "2026-11-09'; DROP TABLE x; --", to: null })).toThrow(/span/);
    expect(() => (requestsSql as any)(GUILD, RUN)).toThrow(/span/);
  });

  it('a row with no key parses with no hash; a key-less row with content is refused', () => {
    expect(parseRequests('requests', row({ id: 'r1' })).rows).toEqual([{ id: 'r1', op: 'write', state: 'done', key: null, h: null, taken: true, reply: '{"ok":true}' }]);
    expect(() => parseRequests('requests', row({ c: '{}' }))).toThrow(/needs/);
  });

  it('the writer logs remote for an answer with servedBy, and the history carries it', () => {
    const history = buildHistory([log([{ key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true }, { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED' }])]);
    expect(history.ops.map(op => op.remote)).toEqual([true, false]);
  });

  it('as many rows with no key answered ok as remote acknowledged writes pass; one more started row is TWICE', () => {
    const writes = [
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED', remote: true },
    ];
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2' })])).toEqual([]);
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'r3' })])).toEqual(['TWICE (write rows with no key)']);
  });

  it('a remote acknowledged write with no row answered ok is FALSE-ANSWER; a local one needs no row', () => {
    const writes = [
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-c', c: 1, status: 200, cls: 'ACKED' },
    ];
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2', reply: '{"ok":false,"code":"not-taken","unapplied":true}' })])).toEqual(['FALSE-ANSWER (write rows with no key)']);
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2' })])).toEqual([]);
  });

  it('a started row with no key beyond the sends not refused as never applied is FALSE-ANSWER', () => {
    const writes = [
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-b', c: 1, status: 503, cls: 'REFUSED', definite: true },
    ];
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2', state: 'applying', reply: null })])).toEqual(['FALSE-ANSWER (write rows with no key)']);
  });

  it('a keyed row still judges its own send as before when rows with no key are listed', () => {
    const deletes = [
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED' },
      { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED' },
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true, op: 'delete' as const },
      { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED', remote: true, op: 'delete' as const },
    ];
    const keyed = (id: string) => JSON.stringify({ id, op: 'delete', state: 'done', k: 'rq1-a', c: null, taken: true, reply: '{"ok":true}' });
    expect(verdictsOf(deletes, [keyed('k1'), keyed('k2'), row({ id: 'r1', op: 'delete' })])).toEqual(['TWICE rq1-a']);
  });

  it('snapshots that may have missed rows give INCONCLUSIVE and no count verdict; a TWICE the listed rows prove stands', () => {
    const writes = [
      { key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-b', c: 1, status: 200, cls: 'ACKED', remote: true },
      { key: 'rq1-c', c: 1, status: 200, cls: 'ACKED', remote: true },
    ];
    // Snapshots at 10:00:30 and 10:04:50, 260 s apart: the ok row of one write was answered and deleted between them.
    const gapped = (lines: string[]) => ['10:00:30', '10:04:50']
      .flatMap(t => [...lines, JSON.stringify({ snapshot: `2026-11-09T${t}.000Z`, rows: lines.length })]).join('\n');
    const judge = (lines: string[]) => judgeRequests(buildHistory([log(writes)]), parseRequests('requests', gapped(lines)));
    const missed = judge([row({ id: 'r1' }), row({ id: 'r2' })]);
    expect(missed.verdicts).toEqual([]);
    expect(missed.reasons.join('\n')).toMatch(/260 s between two snapshots, more than 110 s/);
    expect(missed.reasons.join('\n')).toMatch(/were not judged, because the snapshots may have missed rows/);
    expect(verdictsOf(writes, [row({ id: 'r1' }), row({ id: 'r2' })]), 'the same rows in whole snapshots').toEqual(['FALSE-ANSWER (write rows with no key)']);
    expect(judge([row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'r3' }), row({ id: 'r4' })]).verdicts, 'no count TWICE either').toEqual([]);
    const keyed = (id: string, state = 'done', reply: string | null = '{"ok":false,"code":"frozen"}') => JSON.stringify({ id, op: 'write', state, k: 'rq1-a', c: '{"run":"rq1","lane":"a","kind":"u","key":"rq1-a","c":1}', taken: true, reply });
    const hashed = parseRequests('requests', gapped([keyed('k1')])).rows[0].h;
    const twice = judgeRequests(buildHistory([log([{ ...writes[0] }])].map(l => l.map((e: any) => (e.t === 'send' ? { ...e, h: hashed } : e)))), parseRequests('requests', gapped([keyed('k1'), keyed('k2', 'applying', null)])));
    expect(twice.verdicts.map(v => `${v.v} ${v.key}`)).toEqual(['TWICE rq1-a']);
    expect(twice.reasons.length).toBeGreaterThan(0);
  });

  it('over snapshots that may have missed rows, a refusal given as never applied whose row a holder started is still FALSE-ANSWER', () => {
    const refused = [{ key: 'rq1-a', c: 1, status: 503, cls: 'REFUSED', definite: true }];
    const gapped = (lines: string[]) => ['10:00:30', '10:04:50']
      .flatMap(t => [...lines, JSON.stringify({ snapshot: `2026-11-09T${t}.000Z`, rows: lines.length })]).join('\n');
    const keyed = JSON.stringify({ id: 'k1', op: 'write', state: 'applying', k: 'rq1-a', c: '{"run":"rq1","lane":"a","kind":"u","key":"rq1-a","c":1}', taken: true, reply: null });
    const listing = parseRequests('requests', gapped([keyed]));
    const history = buildHistory([log(refused).map((e: any) => (e.t === 'send' ? { ...e, h: listing.rows[0].h } : e))]);
    const judged = judgeRequests(history, listing);
    expect(judged.reasons.join('\n')).toMatch(/260 s between two snapshots/);
    expect(judged.verdicts.map(v => `${v.v} ${v.key}`)).toEqual(['FALSE-ANSWER rq1-a']);
  });

  it('a listing whose last snapshot is less than 30 s after the last end line is INCONCLUSIVE, even by a few seconds', () => {
    const writes = [{ key: 'rq1-a', c: 1, status: 200, cls: 'ACKED', remote: true }];
    const early = ['10:01:00', '10:02:30', '10:04:00', '10:05:25']
      .flatMap(t => [row({ id: 'r1' }), JSON.stringify({ snapshot: `2026-11-09T${t}.000Z`, rows: 1 })]).join('\n');
    const judged = judgeRequests(buildHistory([log(writes)]), parseRequests('requests', early));
    expect(judged.verdicts).toEqual([]);
    expect(judged.reasons.join('\n')).toMatch(/last snapshot was not taken at least 30 s after the run's last end line/);
  });
});
