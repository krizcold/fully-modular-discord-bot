import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as J from '../oracle/judge.mjs';
import { checks } from '../oracle/model';
import { canonical, classifyAnswer, hashOf, parseLog } from '../oracle/oracle.mjs';

// The checker against the model of a correct store (test/oracle/model.ts):
// silent on every history the model allows, and naming each injected fault.

describe('the checker', () => {
  for (const check of checks()) {
    it(check.name, () => check.run(J, 300));
  }
});

describe('answers, content and logs', () => {
  it('classifies the operator route answers', () => {
    expect(classifyAnswer(200, { success: true })).toEqual({ cls: 'ACKED', definite: true });
    expect(classifyAnswer(202, { success: true, pending: true })).toEqual({ cls: 'HELD', definite: true });
    expect(classifyAnswer(0, null)).toEqual({ cls: 'UNKNOWN', definite: false });
    expect(classifyAnswer(400, { success: false, error: 'Invalid guildId format' })).toEqual({ cls: 'REFUSED', definite: true });
    expect(classifyAnswer(503, { success: false, error: 'Guild data is frozen for a shard migration; retry after it completes' }).definite).toBe(true);
    expect(classifyAnswer(503, { success: false, error: 'the bot process is not running' }).definite).toBe(true);
    // The rate limiter answers before any route runs.
    expect(classifyAnswer(429, { error: 'Rate limit exceeded. Please wait a moment.' })).toEqual({ cls: 'REFUSED', definite: true });
    // Ownership moved or the database switched mid-write: it may have landed.
    expect(classifyAnswer(503, { success: false, error: 'guild temporarily unavailable' }).definite).toBe(false);
    expect(classifyAnswer(503, { success: false, error: 'this node switched databases while saving; whether the write was carried over is unknown, so reload the data to check' }).definite).toBe(false);
    expect(classifyAnswer(500, { success: false, error: 'IPC timeout' }).definite).toBe(false);
    // The app's error handler, oversize bodies included, is judged as possibly applied.
    expect(classifyAnswer(500, { error: 'An error occurred', message: 'request entity too large' }).definite).toBe(false);
    // A committed answer whose body was lost is not claimed as committed.
    expect(classifyAnswer(200, null)).toEqual({ cls: 'REFUSED', definite: false });
  });

  it('hashes content the same however it is indented or its keys ordered', () => {
    fc.assert(fc.property(fc.jsonValue(), value => {
      const stored = JSON.parse(JSON.stringify(value, null, 2));
      expect(hashOf(stored)).toBe(hashOf(value));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const reversed = Object.fromEntries(Object.entries(value).reverse());
        expect(canonical(reversed)).toBe(canonical(value));
      }
    }));
  });

  it('drops a bad last line and refuses a bad middle line', () => {
    const lines = ['{"t":"start","run":"r1","guild":"123456789012","lanes":[{"name":"l0"}]}', '{"t":"send","id":1'];
    expect(parseLog(lines.join('\n'))).toHaveLength(1);
    // A whole bad last line too, with only blank lines after it.
    expect(parseLog(`${lines[0]}\nnot json\n\n`)).toHaveLength(1);
    expect(() => parseLog([lines[1], lines[0]].join('\n'))).toThrow(/line 1/);
  });
});

// Code review round 1, lane C finding 4: after 'done', a stuck old process on count 4 whose rows expired still
// answers while machine B serves 8. The CONTROL rules are keyed by count; only a listing row's {from, to} allows a
// second count, and the open attempt comes from the listing only.
describe('two counts in one reading (NB9 C4)', () => {
  const G = String(5n << 22n);
  const node = (nodeId: string, processId: string, shardCount: number, leases: number[], guildMap: Record<string, number> = {}, reshard: { attempt: string; state: string; from: number; to: number } | null = null) => ({
    name: nodeId,
    state: {
      initialized: true, nodeId, processId, shardCount,
      leases: leases.map(shardId => ({ shardId, claim: null })),
      shardTable: leases.map(shardId => ({ shardId, nodeId, status: 'Ready' })),
      guildMap, reshard,
    },
  });
  const done = { attempt: 'a-1', state: 'done', from: 4, to: 8, fromRows: 0 };
  const flipped = { attempt: 'a-1', state: 'flipped', from: 4, to: 8 };
  // The old process maps G to shard 1 of 4 and leases 0 and 1; the new one maps G to shard 5 of 8 and leases 0 and 4.
  const fleet = () => [node('A', 'p1', 4, [0, 1], { [G]: 1 }, flipped), node('B', 'q1', 8, [0, 4], { [G]: 5 })];
  const history = J.buildHistory([[{ t: 'start', run: 'r1', guild: '123456789012', sink: 'file', lanes: [{ name: 'a' }] }, { t: 'end' }]]);
  const details = (withListing: boolean, set = fleet(), again?: typeof set): string[] => J.judge({
    history, copies: [], k: 0, fleet: set, ...(again ? { fleetAgain: again } : {}),
    ...(withListing ? { reshard: [JSON.stringify({ rows: [done], meta: 8 })] } : {}),
  }).verdicts.map(v => v.detail);

  it.each([true, false])("shard ids of two counts are not one shard leased twice (listing row %s)", withListing => {
    expect(details(withListing).filter(d => /leased to 2 processes/.test(d))).toEqual([]);
    expect(details(withListing, fleet(), fleet()).filter(d => /leased to 2 processes/.test(d))).toEqual([]);
  });

  it.each([true, false])("a lease of one count is not judged against a shard table of the other (listing row %s)", withListing => {
    expect(details(withListing).filter(d => /but it is in the shard table of/.test(d))).toEqual([]);
  });

  it.each([true, false])("a guild mapped under two counts is not split across nodes (listing row %s)", withListing => {
    expect(details(withListing).filter(d => /mapped to 2 shards across nodes/.test(d))).toEqual([]);
  });

  it.each([true, false])("a stale 'flipped' view of the old process opens no attempt (listing row %s)", withListing => {
    expect(details(withListing).filter(d => /holds a grant of the 8-shard set/.test(d))).toEqual([]);
  });

  it("the listing row's {from, to} allows the second count; with no listing the rule stays", () => {
    expect(details(true).filter(d => /disagree on the shard count/.test(d))).toEqual([]);
    expect(details(true, fleet(), fleet()).filter(d => /disagree on the shard count/.test(d))).toEqual([]);
    expect(details(false).filter(d => /disagree on the shard count/.test(d))).toEqual(['nodes disagree on the shard count: 4, 8']);
    const three = [...fleet(), node('C', 'r1', 6, [2])];
    expect(details(true, three).filter(d => /disagree on the shard count/.test(d))).toEqual(['nodes disagree on the shard count: 4, 6, 8']);
  });

  it('with no reshard listing, an open attempt in a live view leaves a note (code review 2, lane C finding 1)', () => {
    const NOTE = 'grants were not compared with the reshard attempt: no reshard listing was given (--reshard)';
    const notes = (set: ReturnType<typeof fleet>, withListing: boolean) => J.judge({
      history, copies: [], k: 0, fleet: set,
      ...(withListing ? { reshard: [JSON.stringify({ rows: [done], meta: 8 })] } : {}),
    }).notes;
    expect(notes(fleet(), false)).toContain(NOTE);
    expect(notes(fleet(), true)).not.toContain(NOTE);
    expect(notes([node('B', 'q1', 8, [0, 4], { [G]: 5 })], false)).not.toContain(NOTE);
  });

  it('within one count the rules still bite', () => {
    const twice = [node('A', 'p1', 8, [3], { [G]: 5 }), node('B', 'q1', 8, [3], { [G]: 4 })];
    const found = details(true, twice);
    expect(found).toContain('shard 3 is leased to 2 processes at once: A (process p1), B (process q1)');
    expect(found).toContain('guild ' + G + ' is mapped to 2 shards across nodes: 4, 5');
    const open = [node('B', 'q1', 8, [0])];
    const listing = { rows: [{ ...done, state: 'flipped' }], meta: 8 };
    expect(J.judge({ history, copies: [], k: 0, fleet: open, reshard: [JSON.stringify(listing)] }).verdicts.map(v => v.detail))
      .toContain('B (process q1) holds a grant of the 8-shard set while the reshard to 8 shards is flipped');
  });
});
