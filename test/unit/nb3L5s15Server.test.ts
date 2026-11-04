import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/webui/server';
import { MigrationService } from '../../src/bot/internalSetup/utils/dataMigration';
import { freshJsonBot } from '../helpers/migrationRig';

// NB3: createServer mounts the setup routes at /api/setup and the panel's migration route at /api/data/migrate, so
// the panel and smdb reach them there.

const lock = { running: null as null | { jobId: string; to: string } };
const manager = {
  migrationRunning: () => lock.running,
  postAccessLog: () => undefined,
  getStatus: () => ({ running: false }),
} as any;

let server: http.Server;
let base = '';

beforeAll(async () => {
  freshJsonBot();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const app = await createServer(manager);
  server = http.createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

describe('createServer', () => {
  it('POST /api/setup/credentials reaches the setup routes, which refuse during a job', async () => {
    lock.running = { jobId: 'job-s15-v001', to: 'postgres' };
    try {
      const res = await fetch(`${base}/api/setup/credentials`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ MAIN_GUILD_ID: '1' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: 'A data migration is running (migration job-s15-v001); nothing was saved' });
    } finally {
      lock.running = null;
    }
  });

  it('GET /api/data/migrate answers the migration status', async () => {
    const expected = new MigrationService(manager).status();
    const res = await fetch(`${base}/api/data/migrate`);
    expect(res.status).toBe(expected.status);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(expected.body)));
  });
});
