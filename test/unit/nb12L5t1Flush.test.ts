import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_BOUND_BYTES_PER_S, flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { type Sent, bytesOf, scriptedBackend } from '../helpers/scriptedPg';

// NB12 item 9 (wip-redesign/sheets/NB12.md, decision 6): the flush's server bound counts the bytes a statement sends,
// and a null or undefined value sends none.

const backends: PostgresBackend[] = [];
const empty: GuildFlushBatch = { upserts: [], deletes: [], appends: [] };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

async function flush(token: FenceToken): Promise<Sent[]> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { backend, sent } = scriptedBackend();
  backends.push(backend);
  expect(await backend.flushGuild('1', empty, token)).toEqual({ ok: true });
  return sent;
}

const fenceOf = (sent: Sent[]) => sent.find(s => /INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s.sql))!;
const beginOf = (sent: Sent[]) => sent.find(s => s.sql.startsWith('BEGIN'))!.sql;

// A token whose fenced claim statement carries exactly FLUSH_BOUND_BYTES_PER_S bytes, the largest one bound to 1 s more.
async function onTheEdge(shape: Omit<FenceToken, 'nodeId'>): Promise<Sent[]> {
  const probe = fenceOf(await flush({ ...shape, nodeId: 'n' }));
  const nodeId = 'n'.repeat(1 + FLUSH_BOUND_BYTES_PER_S - bytesOf(probe));
  const sent = await flush({ ...shape, nodeId });
  expect(bytesOf(fenceOf(sent))).toBe(FLUSH_BOUND_BYTES_PER_S);
  return sent;
}

describe('the bound of a flush whose largest statement is its fenced claim', () => {
  it('counts no bytes for a null value', async () => {
    const sent = await onTheEdge({ claim: 3, processId: 'process-a', shardId: null as unknown as number, shardCount: 1 });
    expect(beginOf(sent)).toBe(`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(FLUSH_BOUND_BYTES_PER_S)}`);
  });

  it('counts no bytes for an undefined value', async () => {
    const sent = await onTheEdge({ claim: 3, processId: 'process-a', shardId: 0, shardCount: undefined as unknown as number });
    expect(beginOf(sent)).toBe(`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(FLUSH_BOUND_BYTES_PER_S)}`);
  });

  it('counts the bytes of every other value, a statement one byte over the edge taking the next second', async () => {
    const probe = fenceOf(await flush({ nodeId: 'n', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 }));
    const nodeId = 'n'.repeat(2 + FLUSH_BOUND_BYTES_PER_S - bytesOf(probe));
    const sent = await flush({ nodeId, claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 });
    expect(beginOf(sent)).toBe(`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(FLUSH_BOUND_BYTES_PER_S + 1)}`);
    expect(flushBoundMs(FLUSH_BOUND_BYTES_PER_S + 1)).toBeGreaterThan(flushBoundMs(FLUSH_BOUND_BYTES_PER_S));
  });
});
