import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresControlStore } from '../../src/bot/internalSetup/fleet/postgresControlStore';
import { poolFor, startPostgres } from '../helpers/postgres';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await startPostgres();
  pool = poolFor(container);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('control store term row (compare-and-set against a real Postgres)', () => {
  it('mints distinct terms under concurrent acquires, and the row names the highest', async () => {
    const stores = Array.from({ length: 6 }, () => new PostgresControlStore(pool));
    const terms = await Promise.all(stores.map((store, i) => store.acquireTerm(`node-${i}`)));
    expect(new Set(terms).size).toBe(terms.length);
    const row = await stores[0].getTerm();
    expect(row?.term).toBe(Math.max(...terms));
    expect(row?.nodeId).toBe(`node-${terms.indexOf(Math.max(...terms))}`);
  });

  it('mints above a floor a boot was let past', async () => {
    const store = new PostgresControlStore(pool);
    const current = (await store.getTerm())?.term ?? 0;
    store.floorNextTerm(current + 50);
    expect(await store.acquireTerm('floored')).toBe(current + 51);
  });

  it("latches the fence on the deposed holder's next stamp and reports the term it saw", async () => {
    const deposed = new PostgresControlStore(pool);
    const successor = new PostgresControlStore(pool);
    const oldTerm = await deposed.acquireTerm('old-master');
    let observed: number | null = null;
    deposed.onFenced(term => { observed = term; });
    const newTerm = await successor.acquireTerm('new-master');
    expect(newTerm).toBeGreaterThan(oldTerm);
    await deposed.stampTerm();
    expect(deposed.isFenced()).toBe(true);
    expect(observed).toBe(newTerm);
    await successor.stampTerm();
    expect(successor.isFenced()).toBe(false);
  });
});
