import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeEnvDataBackend } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { createMigrateRoutes } from '../../src/webui/routes/migrate';

// NB3: the DATA_BACKEND rewrite keeps a lone line with no trailing newline, and the panel's migrate routes sit at '/'.

const ENV = dataPath('.env');

describe('writeEnvDataBackend on a one-line file with no newline', () => {
  beforeEach(() => fs.rmSync(ENV, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(ENV, { recursive: true, force: true }));

  it('keeps the line and appends DATA_BACKEND=postgres', () => {
    fs.writeFileSync(ENV, 'Stryker was here!');
    writeEnvDataBackend('postgres');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('Stryker was here!\nDATA_BACKEND=postgres\n');
  });

  it('keeps the line and appends DATA_BACKEND=file', () => {
    fs.writeFileSync(ENV, 'Stryker was here!');
    writeEnvDataBackend('file');
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('Stryker was here!\nDATA_BACKEND=file\n');
  });
});

describe('the panel migrate routes', () => {
  const saved = process.env.BOT_MANAGER_UPDATE_TOKEN;
  beforeEach(() => { delete process.env.BOT_MANAGER_UPDATE_TOKEN; });
  afterEach(() => {
    if (saved === undefined) delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    else process.env.BOT_MANAGER_UPDATE_TOKEN = saved;
    vi.restoreAllMocks();
  });

  function setup() {
    const posts: any[] = [];
    const svc: any = {
      post: async (req: any) => { posts.push(req); return { status: 202, body: { success: true, to: req.to } }; },
      status: () => ({ status: 200, body: { success: true, state: 'idle' } }),
    };
    const router: any = createMigrateRoutes({} as any, svc);
    const out = { status: 0, body: undefined as any };
    const res: any = {
      status(s: number) { out.status = s; return res; },
      json(b: any) { out.body = b; return res; },
    };
    const at = (method: string) => router.stack.find((l: any) => l.route?.path === '/' && l.route.methods[method]);
    return { posts, out, res, at };
  }

  it('POST / starts the migration with the requested destination', async () => {
    const { posts, out, res, at } = setup();
    const layer = at('post');
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle({ body: { to: 'postgres' } }, res);
    expect(out).toEqual({ status: 202, body: { success: true, to: 'postgres' } });
    expect(posts).toHaveLength(1);
    expect(posts[0].to).toBe('postgres');
    expect(posts[0].jobId).toMatch(/^smdb-[0-9a-f]{16}$/);
  });

  it('GET / answers the migration status', async () => {
    const { out, res, at } = setup();
    const layer = at('get');
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle({}, res);
    expect(out).toEqual({ status: 200, body: { success: true, state: 'idle' } });
  });
});
