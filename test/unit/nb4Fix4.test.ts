import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, FlushOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { drainForExit } from '../../src/bot/internalSetup/utils/dataManager';
import { runStopSteps } from '../../src/bot/internalSetup/utils/stopSteps';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// Round 4: commitUnanswered as NB13 decision 3 defines it, and the drop lines printed on every exit.

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const batch = { upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }], deletes: [], appends: [] };
const stamped = (sql: string) => /INSERT INTO smdb_data\.guild_ownership AS o/.test(sql) ? { rows: [], rowCount: 1 } : undefined;

function scripted(answer: (sql: string) => unknown) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const client = {
    query: async (sql: string) => {
      const res = answer(sql.trim());
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return backend;
}

const failAt = (when: RegExp, error: Error) => (sql: string) => when.test(sql) ? error : stamped(sql);
const answered = (code: string, severity: string) =>
  Object.assign(new Error('terminating connection due to administrator command'), { code, severity });

async function flushWith(when: RegExp, error: Error): Promise<FlushOutcome> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return scripted(failAt(when, error)).flushGuild('g1', batch, token);
}

const dropLine = (g: string) =>
  `[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: ${g}; guild(s) ${g} had a save whose answer never came, so some of these changes may have landed`;

describe('NB4-R3-DL-1: a COMMIT ended by FATAL or PANIC may have landed', () => {
  it.each(['FATAL', 'PANIC'])('a COMMIT answered with severity %s carries commitUnanswered and its code', async severity => {
    expect(await flushWith(/^COMMIT$/, answered('57P01', severity))).toMatchObject({ ok: false, reason: 'unavailable', code: '57P01', commitUnanswered: true });
  });

  it('a COMMIT answered with severity ERROR does not', async () => {
    const outcome = await flushWith(/^COMMIT$/, answered('40001', 'ERROR'));
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '40001' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
  });

  it('a FATAL on a statement before COMMIT does not', async () => {
    const outcome = await flushWith(/INSERT INTO smdb_data\.guild_data /, answered('57P01', 'FATAL'));
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '57P01' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
  });

  it("the FATAL outcome, then 'deposed', gives the drop line its may-have-landed clause", async () => {
    const fatal = await flushWith(/^COMMIT$/, answered('57P01', 'FATAL'));
    const store = new FakeStore();
    const ws = new WorkingSetManager(store);
    const g = '999';
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    ws.save(g, 'm', 'a.json', '1');
    const real = store.flushGuild.bind(store);
    let answer: FlushOutcome = fatal;
    store.flushGuild = (async (...args: Parameters<typeof real>) => { await real(...args); return answer; }) as typeof store.flushGuild;
    await ws.flushGuildNow(g, 50);
    answer = { ok: false, reason: 'deposed' };
    await ws.flushGuildNow(g, 50);
    expect(ws.takeDropLines()).toEqual([dropLine(g)]);
    ws.evict(g);
  });
});

describe('NB4-R4-DL-1: a stop before the leave ends still logs the drop lines', () => {
  it('the exit drain prints them once, before the exit', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    const g = '888';
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    ws.save(g, 'm', 'a.json', '1');
    const real = store.flushGuild.bind(store);
    let answer: FlushOutcome = { ok: false, reason: 'unavailable', commitUnanswered: true };
    store.flushGuild = (async (...args: Parameters<typeof real>) => { await real(...args); return answer; }) as typeof store.flushGuild;
    await ws.flushGuildNow(g, 50);
    answer = { ok: false, reason: 'deposed' };

    const order: string[] = [];
    error.mockImplementation((line: unknown) => { if (String(line).startsWith('[Shards]')) order.push(String(line)); });
    await runStopSteps({
      beginStop: () => {},
      stopSamplers: () => {},
      closeGateway: async () => {},
      flushTotals: () => {},
      drain: () => drainForExit(2000),
      finishStop: async () => { order.push('finishStop'); },
      exit: code => { order.push(`exit ${code}`); },
    });
    expect(order).toEqual([dropLine(g), 'finishStop', 'exit 0']);
    expect(ws.takeDropLines()).toEqual([]);
  });
});
