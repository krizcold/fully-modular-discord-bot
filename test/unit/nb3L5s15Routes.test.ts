import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrateRoutes } from '../../src/webui/routes/migrate';
import { createControlRoutes } from '../../src/webui/routes/control';
import { createSetupRoutes } from '../../src/webui/routes/setup';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { root, wipeRoot } from '../helpers/migrationRig';

// NB3 decision 1 and the writes a running job refuses: the answers the panel and the manager read from each route.

interface FakeRes {
  statusCode: number;
  bodies: unknown[];
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    bodies: [],
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.bodies.push(body); return this; },
  };
}

/** The first handler of the router's route for this method (and path, when given). */
function handler(router: any, method: string, routePath?: string): (req: any, res: any) => unknown {
  const layer = router.stack.find((l: any) => l.route && l.route.methods[method] && (routePath === undefined || l.route.path === routePath));
  if (!layer) throw new Error(`no ${method} route ${routePath ?? ''}`);
  return layer.route.stack[0].handle;
}

const running = (jobId: string) => ({ jobId, to: 'postgres' as const });

beforeEach(() => {
  wipeRoot();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the panel migrate route', () => {
  function service() {
    const posts: unknown[] = [];
    return {
      posts,
      svc: {
        post: async (req: any) => { posts.push(req); return { status: 202, body: { success: true, to: req.to ?? null } }; },
        status: () => ({ status: 200, body: { success: true, state: 'idle' } }),
      } as any,
    };
  }

  it('a token of only spaces is no manager: the job is asked', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = '   ';
    const { svc, posts } = service();
    const res = fakeRes();
    await handler(createMigrateRoutes({} as any, svc), 'post')({ body: { to: 'postgres' } }, res);
    expect(res.statusCode).toBe(202);
    expect(res.bodies).toEqual([{ success: true, to: 'postgres' }]);
    expect(posts).toHaveLength(1);
  });

  it('a managed bot gets success: false and the job is never asked', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'nb3-s15-token';
    const { svc, posts } = service();
    const res = fakeRes();
    await handler(createMigrateRoutes({} as any, svc), 'post')({ body: { to: 'postgres' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: "This bot is managed; use the manager's Migrate control" }]);
    expect(posts).toHaveLength(0);
  });

  it('a null body asks the job with no direction, which answers', async () => {
    const { svc, posts } = service();
    const res = fakeRes();
    await handler(createMigrateRoutes({} as any, svc), 'post')({ body: null }, res);
    expect(res.statusCode).toBe(202);
    expect(res.bodies).toEqual([{ success: true, to: null }]);
    expect((posts[0] as any).to).toBeUndefined();
    expect((posts[0] as any).jobId).toMatch(/^smdb-[0-9a-f]{16}$/);
  });
});

describe('restart and container restart while a job runs', () => {
  const manager = (jobId: string | null, withLock = true) => ({
    ...(withLock ? { migrationRunning: () => (jobId ? running(jobId) : null) } : {}),
    beginExit: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  });

  it('restart-server refuses with success: false naming the job, and schedules no exit', async () => {
    vi.useFakeTimers();
    const m = manager('job-s15-c001');
    const res = fakeRes();
    await handler(createControlRoutes(m as any), 'post', '/restart-server')({ body: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: 'A data migration is running (migration job-s15-c001); The server was not restarted' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restart-server with no job running answers that the restart began', async () => {
    vi.useFakeTimers();
    const res = fakeRes();
    await handler(createControlRoutes(manager(null) as any), 'post', '/restart-server')({ body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.bodies).toEqual([{ success: true, message: 'Server restart initiated' }]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('restart-server on a manager with no migration lock answers that the restart began', async () => {
    vi.useFakeTimers();
    const res = fakeRes();
    await handler(createControlRoutes(manager(null, false) as any), 'post', '/restart-server')({ body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.bodies).toEqual([{ success: true, message: 'Server restart initiated' }]);
  });

  it('an emergency shutdown refuses with success: false naming the job and the container', async () => {
    vi.useFakeTimers();
    const m = manager('job-s15-c002');
    const res = fakeRes();
    await handler(createControlRoutes(m as any), 'post', '/shutdown')({ body: { emergency: true } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: 'A data migration is running (migration job-s15-c002); The container was not restarted' }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(m.beginExit).not.toHaveBeenCalled();
  });
});

describe('credential saves while a job runs', () => {
  it('the setup credentials route answers 409 with success: false and saves nothing', async () => {
    const res = fakeRes();
    const router = createSetupRoutes({ migrationRunning: () => running('job-s15-s001') } as any);
    await handler(router, 'post', '/credentials')({ body: { MAIN_GUILD_ID: '123' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: 'A data migration is running (migration job-s15-s001); nothing was saved' }]);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('the provider credentials route answers 409 with success: false', async () => {
    const res = fakeRes();
    const router = createAppStoreRoutes({ migrationRunning: () => running('job-s15-a001') } as any);
    await handler(router, 'put', '/premium/providers/:providerId/credentials')({ params: { providerId: 'stripe' }, body: { values: { X: 'y' } } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: 'A data migration is running (migration job-s15-a001); nothing was saved' }]);
  });
});

describe('the manager maintenance hook while a job runs', () => {
  it('leaving maintenance is refused with success: false naming the job', async () => {
    const res = fakeRes();
    const m = { migrationRunning: () => running('job-s15-m001'), leaveMaintenance: vi.fn(), enterMaintenance: vi.fn() };
    await handler(createManagedRoutes(m as any, {} as any), 'post', '/maintenance')({ body: { state: 'running' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([{ success: false, error: 'A data migration is running (migration job-s15-m001); the bot stays in maintenance until it ends' }]);
    expect(m.leaveMaintenance).not.toHaveBeenCalled();
  });

  it('entering maintenance still passes', async () => {
    const res = fakeRes();
    const m = { migrationRunning: () => running('job-s15-m002'), enterMaintenance: vi.fn(async () => ({ saved: true })) };
    await handler(createManagedRoutes(m as any, {} as any), 'post', '/maintenance')({ body: { state: 'maintenance', message: 'moving data' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.bodies).toEqual([{ success: true, state: 'maintenance', saved: true }]);
    expect(m.enterMaintenance).toHaveBeenCalledWith('moving data');
  });
});
