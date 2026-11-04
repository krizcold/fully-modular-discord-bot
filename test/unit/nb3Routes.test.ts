import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { createMigrateRoutes } from '../../src/webui/routes/migrate';
import { runMigrate } from '../../src/cli/commands';
import type { BotManager } from '../../src/webui/botManager';
import { startApp } from '../helpers/configRig';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, serviceFor, useDatabaseUrl, wipeRoot, freshJsonBot } from '../helpers/migrationRig';

// NB3 decision 1: the two entry points and the CLI verb.

const TOKEN = 'nb3-routes-token';
const host = new FakeHost();
const db = new FakeDb();
const service = serviceFor(db, host);
let app: { url: string; close: () => Promise<void> };
const manager = host as unknown as BotManager;

beforeAll(async () => {
  app = await startApp(a => {
    a.use('/api/managed', createManagedRoutes(manager, service));
    a.use('/api/data/migrate', createMigrateRoutes(manager, service));
  });
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  freshJsonBot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const json = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.url}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('the entry points', () => {
  it('the hook needs the token', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    expect((await json('POST', '/api/managed/migrate', { jobId: 'job-route-0001', to: 'postgres' })).status).toBe(403);
    expect((await json('POST', '/api/managed/migrate', { jobId: 'job-route-0001', to: 'postgres' }, { 'x-bot-token': 'wrong' })).status).toBe(403);
    expect((await json('GET', '/api/managed/migrate')).status).toBe(403);
  });

  it('the panel route refuses on a managed bot', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    const res = await json('POST', '/api/data/migrate', { to: 'postgres' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This bot is managed; use the manager's Migrate control");
    expect(db.log).toHaveLength(0);
  });

  it('the panel route mints a jobId of the contract\'s form and every POST answer carries the to', async () => {
    const res = await json('POST', '/api/data/migrate', { to: 'postgres' });
    const body = await res.json();
    expect(body).toMatchObject({ success: true, to: 'postgres', state: 'started' });
    expect(body.jobId).toMatch(/^[A-Za-z0-9-]{8,40}$/);
    await service.idle();
    const again = await (await json('POST', '/api/data/migrate', { to: 'file' })).json();
    expect(again.to).toBe('file');
    await service.idle();
  });

  it('a hook jobId outside 8 to 40 letters, digits and "-" answers 400', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    for (const jobId of ['short', 'x'.repeat(41), 'has space 123', 'semi;colon1']) {
      expect((await json('POST', '/api/managed/migrate', { jobId, to: 'postgres' }, { 'x-bot-token': TOKEN })).status).toBe(400);
    }
    expect((await json('POST', '/api/managed/migrate', { jobId: 'job-route-0002', to: 'disk' }, { 'x-bot-token': TOKEN })).status).toBe(400);
  });
});

/** A panel stand-in for the CLI: scripted POST answer and GET answers in turn. */
function panel(post: object, gets: object[]) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  let i = 0;
  return {
    sent,
    client: {
      request: async (method: string, p: string, opts: { body?: unknown } = {}) => {
        sent.push({ method, path: p, body: opts.body });
        if (method === 'POST') return { status: 200, ok: true, body: post };
        const body = gets[Math.min(i++, gets.length - 1)];
        return { status: 200, ok: true, body };
      },
    } as any,
  };
}
const job = (state: string, extra: object = {}) => ({ success: true, job: { jobId: 'job-cli-00001', to: 'postgres', stage: 'switching', state, ...extra } });

describe('the CLI verb', () => {
  it('sends no URL and exits zero on done', async () => {
    const p = panel({ success: true, jobId: 'job-cli-00001', to: 'postgres', state: 'started' }, [job('running'), job('done')]);
    const result = await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(p.sent[0]).toEqual({ method: 'POST', path: '/api/data/migrate', body: { to: 'postgres' } });
  });

  it('exits non-zero on started then failed, interrupted at retire-source, switching and env, and a refusal', async () => {
    for (const end of [job('failed'), job('interrupted', { stage: 'retire-source' }), job('interrupted', { stage: 'switching' }), job('interrupted', { stage: 'env' })]) {
      const p = panel({ success: true, jobId: 'job-cli-00001', to: 'postgres', state: 'started' }, [end]);
      expect((await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 })).code).not.toBe(0);
    }
    const refused = panel({ success: false, error: 'Stop the bot first' }, []);
    const r = await runMigrate(refused.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('Stop the bot first');
  });

  it('follows the jobId an answer names when its to is the CLI\'s', async () => {
    const p = panel({ success: true, jobId: 'job-earlier-01', to: 'postgres', state: 'running' },
      [{ success: true, job: { jobId: 'job-earlier-01', to: 'postgres', stage: 'env', state: 'done' } }]);
    const result = await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(result.message).toContain('job-earlier-01');
  });

  it('never takes another job the GET shows for the one it follows', async () => {
    const p = panel({ success: true, jobId: 'job-earlier-01', to: 'postgres', state: 'running' }, [
      { success: true, job: { jobId: 'job-other-xxxx', to: 'postgres', stage: 'env', state: 'running' } },
      { success: true, job: { jobId: 'job-earlier-01', to: 'postgres', stage: 'copying', state: 'failed', error: 'the cause' } },
    ]);
    const result = await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(result.code).not.toBe(0);
    expect(result.message).toBe('migration job-earlier-01 failed at copying: the cause');
    expect(p.sent.filter(s => s.method === 'GET')).toHaveLength(2);
    const q = panel({ success: true, jobId: 'job-earlier-01', to: 'postgres', state: 'running' }, [
      { success: true, job: { jobId: 'job-other-xxxx', to: 'postgres', stage: 'env', state: 'done' } },
      { success: true, job: { jobId: 'job-earlier-01', to: 'postgres', stage: 'env', state: 'done' } },
    ]);
    const second = await runMigrate(q.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(second.code).not.toBe(0);
    expect(second.message).toMatch(/^can't confirm the outcome of migration job-earlier-01; the status names migration job-other-xxxx/);
  });

  it('refuses to follow a job of another to, naming it, and exits non-zero', async () => {
    const p = panel({ success: false, jobId: 'job-other-0001', to: 'file', error: 'Migration job-other-0001 (--to file) is running' }, []);
    const result = await runMigrate(p.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(result.code).not.toBe(0);
    expect(result.message).toContain('job-other-0001');
    const q = panel({ success: true, jobId: 'job-other-0002', to: 'file', state: 'running' }, []);
    const second = await runMigrate(q.client, 'postgres', { intervalMs: 1, timeoutMs: 5000 });
    expect(second.code).not.toBe(0);
    expect(second.message).toContain('job-other-0002');
    expect(q.sent.filter(s => s.method === 'GET')).toHaveLength(0);
  });
});
