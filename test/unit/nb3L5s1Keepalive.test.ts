import { describe, expect, it, vi } from 'vitest';

// NB3: a job session asks the server for TCP keepalives in its startup packet, beside its timeouts.

const seen = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));

vi.mock('../../src/bot/internalSetup/utils/pgClient', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shortLivedClient: (config: Record<string, unknown>) => {
    seen.configs.push(config);
    return { connect: async () => undefined, end: async () => undefined, on: () => undefined };
  },
}));

import { openJobSession } from '../../src/bot/internalSetup/utils/dataMigration';

describe('a job session', () => {
  it('sends the server keepalive settings for a job and a probe', async () => {
    await openJobSession('postgres://bot:pw@db.example:5432/smdb', 'smdb-migrate:job-l5s1-ka-01', 'job');
    await openJobSession('postgres://bot:pw@db.example:5432/smdb', 'smdb-migrate:job-l5s1-ka-01', 'probe');
    expect(seen.configs).toHaveLength(2);
    for (const config of seen.configs) {
      const options = String(config.options);
      expect(options).toContain('-c tcp_keepalives_idle=30');
      expect(options).toContain('-c tcp_keepalives_interval=10');
      expect(options).toContain('-c tcp_keepalives_count=3');
    }
  });
});
