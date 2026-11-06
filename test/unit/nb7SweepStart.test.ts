import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startGuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setBackendKind } from '../helpers/backendKind';

// NB7 decisions 7 and 16: the sweep the bot starts applies each claimed row through answerGuildWrite, so a closed
// maintenance gate is answered with the maintenance refusal before the executor reads anything.

const db = vi.hoisted(() => ({
  configs: [] as any[],
  sent: [] as Array<{ text: string; values: unknown[] }>,
  answer: (_text: string, _values: unknown[]): any => ({ rows: [], rowCount: 0 }),
}));

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    constructor(config: any) { db.configs.push(config); }
    on() { return this; }
    async connect() {
      return {
        query: async (config: any) => {
          db.sent.push({ text: config.text, values: config.values });
          return db.answer(config.text, config.values);
        },
        release: () => undefined,
        on: () => undefined,
      };
    }
    async query() { return { rows: [] }; }
    async end() {}
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

const GUILD = String(1n << 22n);
const lease = () => ({ processId: 'p-b', shardCount: 2, leases: [{ leaseId: 'l1', shardId: 1, claim: 9 }] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.stubEnv('DATA_BACKEND_URL', 'postgres://sweep:pw@db.example:5432/smdb');
  setBackendKind('postgres');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  setMaintenanceGate(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the sweep the bot starts', () => {
  it('opens its own pool, claims with the lease\'s pair, and answers the maintenance refusal without the executor', async () => {
    let claimed = false;
    db.answer = (text, values) => {
      if (text === REQUEST_CLAIM_SQL && !claimed) {
        claimed = true;
        // An invalid file name: the executor would refuse it as invalid before anything else.
        return { rows: [{ id: 'r1', guild_id: GUILD, op: 'write', requested_by: 'ALPHA', left_ms: '20000', body: JSON.stringify({ module: 'm', filename: '../x.json', contentJson: '{}' }) }], rowCount: 1 };
      }
      if (text === ANSWER_SQL) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0, values };
    };
    setMaintenanceGate({ cause: 'hook', message: 'Back soon' });
    startGuildRequestSweep(lease);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(db.configs).toHaveLength(1);
    expect(db.configs[0]).toMatchObject({ connectionString: 'postgres://sweep:pw@db.example:5432/smdb', application_name: 'smdb-guild-requests', max: 2, statement_timeout: 5000 });
    const claim = db.sent.find(s => s.text === REQUEST_CLAIM_SQL)!;
    expect(claim.values[0]).toBe('p-b');
    expect(claim.values.slice(2, 5)).toEqual([[2], [1], [9]]);
    const answer = db.sent.find(s => s.text === ANSWER_SQL)!;
    expect(answer).toBeDefined();
    expect(JSON.parse(String(answer.values[2]))).toEqual({ ok: false, code: 'maintenance', error: 'Back soon' });
  });
});
