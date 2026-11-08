import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import { REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { sendGuildChange } from '../../src/webui/utils/guildRequests';
import { fakeBot, fakeTime, isInsert, isPoll, isSettleInsert, nb7Rig, requestPlan, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

// NB6 decision 17 and C19: the request insert announces itself on 'smdb_guild_requests' with its for_process, and
// the holder sweep's requestPass() starts a pass now, or once more after the pass running (cell 441).

describe('the request insert (C19, D3)', () => {
  let rig: Rig;
  beforeEach(() => {
    fakeTime();
    rig = nb7Rig();
  });
  afterEach(() => {
    resetNb7();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the insert the sender sends notifies its for_process in the same statement, with the same values', async () => {
    rig.script['postgres://one'] = sql => (isInsert({ sql } as any) ? { rows: [{ pg_notify: '' }], rowCount: 1 } : isPoll({ sql } as any) ? { rows: [{ state: 'done', reply: '{"ok":true}', pickup_over: false, answer_over: false }] } : undefined);
    const plan = await requestPlan('write');
    let value: any;
    void sendGuildChange(fakeBot().bot, plan, { ...writeOf(), op: 'write' }).then(v => { value = v; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(value).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    const inserts = rig.statements.filter(isInsert);
    expect(inserts).toHaveLength(1);
    const { sql, values } = inserts[0];
    expect(sql.startsWith('\nWITH r AS (\nINSERT INTO smdb_data.guild_requests\n')).toBe(true);
    expect(sql).toMatch(/RETURNING for_process\)\s*SELECT pg_notify\('smdb_guild_requests', r\.for_process\) FROM r\s*$/);
    expect(values).toHaveLength(10);
    expect(values[4]).toBe('p-b');
    expect(values.slice(8)).toEqual([5, 20]);
  });

  it('the settle insert of an unanswered insert sends no notification (guard)', async () => {
    rig.script['postgres://one'] = sql => (isInsert({ sql } as any) ? Object.assign(new Error('terminating connection'), { code: '57P01' }) : isSettleInsert({ sql } as any) ? { rows: [{ state: 'expired' }] } : undefined);
    const plan = await requestPlan('write');
    void sendGuildChange(fakeBot().bot, plan, { ...writeOf(), op: 'write' });
    await vi.advanceTimersByTimeAsync(2000);
    const settles = rig.statements.filter(isSettleInsert);
    expect(settles).toHaveLength(1);
    expect(settles[0].sql).not.toMatch(/pg_notify/);
  });
});

describe('requestPass (C19, cell 441)', () => {
  function sweepRig() {
    const claims: Array<(v: { rows: unknown[] }) => void> = [];
    const sent: string[] = [];
    const sweep = new GuildRequestSweep({
      db: {
        query: text => {
          sent.push(text);
          if (text !== REQUEST_CLAIM_SQL) return Promise.resolve({ rows: [], rowCount: 0 });
          return new Promise(resolve => { claims.push(resolve as (v: { rows: unknown[] }) => void); }) as any;
        },
      },
      processId: () => 'p-a',
      pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
      stoppedServing: () => false,
      isStopping: () => false,
      apply: async () => ({ ok: true }),
      newId: () => 'b1',
    });
    const claimCount = () => sent.filter(t => t === REQUEST_CLAIM_SQL).length;
    const answerClaim = async () => {
      const resolve = claims.shift();
      resolve?.({ rows: [] });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { sweep, sent, claims, claimCount, answerClaim };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('with no pass running, it starts one at once', async () => {
    const r = sweepRig();
    r.sweep.requestPass();
    await Promise.resolve();
    expect(r.claimCount()).toBe(1);
    await r.answerClaim();
    expect(r.claimCount()).toBe(1);
  });

  it('a notify during a pass: one more pass after it, never two at once', async () => {
    const r = sweepRig();
    r.sweep.requestPass();
    await Promise.resolve();
    expect(r.claimCount()).toBe(1);
    r.sweep.requestPass();
    await Promise.resolve();
    expect(r.claimCount()).toBe(1);
    await r.answerClaim();
    expect(r.claimCount()).toBe(2);
    await r.answerClaim();
    expect(r.claimCount()).toBe(2);
  });

  it('several notifies during one pass start one more pass, and the flag is cleared at that start', async () => {
    const r = sweepRig();
    void r.sweep.pass();
    await Promise.resolve();
    r.sweep.requestPass();
    r.sweep.requestPass();
    r.sweep.requestPass();
    await r.answerClaim();
    expect(r.claimCount()).toBe(2);
    await r.answerClaim();
    expect(r.claimCount()).toBe(2);
    expect(r.claims).toHaveLength(0);
  });

  it('a notify during the pass that a notify started: one more after that one', async () => {
    const r = sweepRig();
    r.sweep.requestPass();
    await Promise.resolve();
    r.sweep.requestPass();
    await r.answerClaim();
    expect(r.claimCount()).toBe(2);
    r.sweep.requestPass();
    await r.answerClaim();
    expect(r.claimCount()).toBe(3);
    await r.answerClaim();
    expect(r.claimCount()).toBe(3);
  });

  it('the 1 s timer stays', async () => {
    const r = sweepRig();
    r.sweep.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(r.claimCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.claimCount()).toBe(1);
    await r.answerClaim();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.claimCount()).toBe(2);
    r.sweep.stop();
    await r.answerClaim();
  });
});
