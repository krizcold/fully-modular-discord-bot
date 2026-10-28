import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ clients: 0 }));

vi.mock('../../src/bot/internalSetup/utils/pgClient', async importOriginal => ({
  ...(await importOriginal<object>()),
  shortLivedClient: () => {
    h.clients++;
    return { connect: async () => {}, end: async () => {}, query: async () => ({ rows: [], rowCount: 1 }) };
  },
}));

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { closeGuildWrites, noteGuildDataServing, setGuildDataBackend, sweepGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// guild_ownership rows are the claim fence, so the TTL sweep never deletes them, and the sweep runs only on the
// database the data boot verified, through that backend's own pool. The cells run in order: serving and refusing stay
// set in this process.

const URL_BEFORE = process.env.DATA_BACKEND_URL;

beforeEach(() => {
  h.clients = 0;
  process.env.DATA_BACKEND_URL = 'postgres://nobody@127.0.0.1:9/none';
  setBackendKind('postgres');
});

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
  if (URL_BEFORE === undefined) delete process.env.DATA_BACKEND_URL;
  else process.env.DATA_BACKEND_URL = URL_BEFORE;
  vi.restoreAllMocks();
});

const backendServing = (serves: boolean) => {
  const sweeps: number[] = [];
  const backend = { servesData: () => serves, sweepGraveyard: async (cutoffMs: number) => { sweeps.push(cutoffMs); return 1; } };
  return { backend: backend as never, sweeps };
};

describe('the graveyard sweep', () => {
  it('deletes graveyard rows past the cutoff on its own pool and never a guild_ownership row', async () => {
    const sent: string[] = [];
    const fake = { pool: { query: async (sql: string) => { sent.push(sql); return { rows: [], rowCount: 3 }; } } };
    const swept = await (PostgresBackend.prototype.sweepGraveyard as (this: unknown, cutoffMs: number) => Promise<number>).call(fake, Date.now());
    expect(swept).toBe(3);
    expect(sent.some(sql => sql.includes('guild_data_graveyard'))).toBe(true);
    expect(sent.filter(sql => sql.includes('guild_ownership'))).toEqual([]);
    expect(h.clients).toBe(0);
  });

  it('does not touch the database before the data boot serves it', async () => {
    const { backend, sweeps } = backendServing(true);
    setGuildDataBackend(backend);
    await sweepGraveyard();
    expect(sweeps).toEqual([]);
    expect(h.clients).toBe(0);
  });

  it('does not touch a database whose schema check has not passed', async () => {
    noteGuildDataServing();
    const { backend, sweeps } = backendServing(false);
    setGuildDataBackend(backend);
    await sweepGraveyard();
    expect(sweeps).toEqual([]);
    expect(h.clients).toBe(0);
  });

  it('sweeps the database the data boot serves', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend, sweeps } = backendServing(true);
    setGuildDataBackend(backend);
    await sweepGraveyard();
    expect(sweeps).toHaveLength(1);
    expect(h.clients).toBe(0);
  });

  it('sweeps only the served backend after the env names another database', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend, sweeps } = backendServing(true);
    setGuildDataBackend(backend);
    process.env.DATA_BACKEND_URL = 'postgres://other@127.0.0.1:9/elsewhere';
    await sweepGraveyard();
    expect(sweeps).toHaveLength(1);
    expect(h.clients).toBe(0);
  });

  it('does not touch the database once the data layer refused', async () => {
    closeGuildWrites();
    const { backend, sweeps } = backendServing(true);
    setGuildDataBackend(backend);
    await sweepGraveyard();
    expect(sweeps).toEqual([]);
    expect(h.clients).toBe(0);
  });
});
