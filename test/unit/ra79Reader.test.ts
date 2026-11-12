import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebuiDataReader, isDataBackendUnreachable, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { HOLDER_CHECK_SQL, HOLDER_MAP_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[]; query_timeout?: number }>,
  releases: [] as unknown[][],
  answer: null as null | ((config: any) => Promise<{ rows: any[] }>),
  poolQuery: null as null | ((text: string, params: unknown[]) => Promise<{ rows: any[] }>),
}));

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    constructor(_config: any) {}
    on() { return this; }
    async connect() {
      return {
        query: (config: any) => {
          fake.queries.push({ text: config.text, values: config.values, query_timeout: config.query_timeout });
          return fake.answer ? fake.answer(config) : Promise.resolve({ rows: [] });
        },
        release: (...args: unknown[]) => { fake.releases.push(args); },
      };
    }
    async query(text: string, params: unknown[]) {
      return fake.poolQuery ? fake.poolQuery(text, params) : { rows: [] };
    }
    async end() {}
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

const URL = 'postgres://reader:pw@db.example:5432/smdb';

function coded(code: string): Error {
  return Object.assign(new Error(`failed ${code}`), { code });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the call resolved');
}

beforeEach(() => {
  fake.queries = [];
  fake.releases = [];
  fake.answer = null;
  fake.poolQuery = null;
  setWebuiDataStoreUrl({ url: URL });
});

afterEach(() => {
  setWebuiDataStoreUrl(null);
});

describe('sharedSelect', () => {
  it('gives the query the time left of its bound', async () => {
    fake.answer = async () => ({ rows: [{ a: 1 }] });
    expect(await new WebuiDataReader().sharedSelect('SELECT 1', [7], 8000)).toEqual({ rows: [{ a: 1 }] });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].values).toEqual([7]);
    expect(fake.queries[0].query_timeout).toBeGreaterThan(7000);
    expect(fake.queries[0].query_timeout).toBeLessThanOrEqual(8000);
  });

  it('gives a client back to the pool after an answer', async () => {
    await new WebuiDataReader().sharedSelect('SELECT 1', [], 5000);
    expect(fake.releases).toEqual([[undefined]]);
  });

  it('keeps a client whose query failed with a SQLSTATE', async () => {
    const failure = coded('42P01');
    fake.answer = async () => { throw failure; };
    expect(await rejection(new WebuiDataReader().sharedSelect('SELECT 1', [], 5000))).toBe(failure);
    expect(fake.releases).toEqual([[undefined]]);
  });

  it('destroys a client whose query got no answer', async () => {
    const failure = new Error('Query read timeout');
    fake.answer = async () => { throw failure; };
    expect(await rejection(new WebuiDataReader().sharedSelect('SELECT 1', [], 5000))).toBe(failure);
    expect(fake.releases).toEqual([[true]]);
  });

  it('destroys a client and passes on a failure that is no object', async () => {
    fake.answer = () => Promise.reject(undefined);
    expect(await rejection(new WebuiDataReader().sharedSelect('SELECT 1', [], 5000))).toBeUndefined();
    expect(fake.releases).toEqual([[true]]);
  });
});

describe('holder reads', () => {
  it('holderOf asks for the one guild', async () => {
    fake.answer = async () => ({ rows: [{ shard: 2 }] });
    expect(await new WebuiDataReader().holderOf('900000000000000001')).toEqual({ rows: [{ shard: 2 }], url: URL });
    expect(fake.queries).toEqual([expect.objectContaining({ text: HOLDER_CHECK_SQL, values: ['900000000000000001'] })]);
  });

  it('holderMap sends no parameters', async () => {
    await new WebuiDataReader().holderMap();
    expect(fake.queries).toEqual([expect.objectContaining({ text: HOLDER_MAP_SQL, values: [] })]);
  });
});

describe('ownerChannelRow', () => {
  it('reads the owner_channel row value', async () => {
    fake.answer = async () => ({ rows: [{ value: { channelId: '1' } }] });
    expect(await new WebuiDataReader().ownerChannelRow()).toEqual({ channelId: '1' });
    expect(fake.queries).toEqual([
      expect.objectContaining({ text: `SELECT value FROM smdb_data.meta WHERE key = 'owner_channel'`, values: [] }),
    ]);
  });

  it('answers null for no row', async () => {
    fake.answer = async () => ({ rows: [] });
    expect(await new WebuiDataReader().ownerChannelRow()).toBeNull();
  });

  it('answers null when the meta table does not exist', async () => {
    fake.answer = async () => { throw coded('42P01'); };
    expect(await new WebuiDataReader().ownerChannelRow()).toBeNull();
  });

  it('answers null when the schema does not exist', async () => {
    fake.answer = async () => { throw coded('3F000'); };
    expect(await new WebuiDataReader().ownerChannelRow()).toBeNull();
  });

  it('passes on any other error', async () => {
    const failure = coded('57014');
    fake.answer = async () => { throw failure; };
    expect(await rejection(new WebuiDataReader().ownerChannelRow())).toBe(failure);
  });

  it('passes on an error with an empty code', async () => {
    const failure = coded('');
    fake.answer = async () => { throw failure; };
    expect(await rejection(new WebuiDataReader().ownerChannelRow())).toBe(failure);
  });

  it('passes on a failure that is no object', async () => {
    fake.answer = () => Promise.reject(null);
    expect(await rejection(new WebuiDataReader().ownerChannelRow())).toBeNull();
  });
});

describe('plain reads', () => {
  it('turns a query failure into the unreachable error', async () => {
    fake.poolQuery = async () => { throw coded('XX000'); };
    const error = await rejection(new WebuiDataReader().listGuilds());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('data backend unreachable');
  });

  it('readDoc gives the stored document', async () => {
    fake.answer = async () => ({ rows: [{ doc: '{"a":1}' }] });
    expect(await new WebuiDataReader().readDoc('900000000000000001', '', 'config.json')).toBe('{"a":1}');
  });

  it('readDoc answers null for no row', async () => {
    expect(await new WebuiDataReader().readDoc('900000000000000001', '', 'config.json')).toBeNull();
  });

  it('isDataBackendUnreachable knows the bare reader error', () => {
    expect(isDataBackendUnreachable(new Error('data backend unreachable'))).toBe(true);
    expect(isDataBackendUnreachable(new Error('data backend unreachable (x)'))).toBe(true);
    expect(isDataBackendUnreachable(new Error('other'))).toBe(false);
  });
});
