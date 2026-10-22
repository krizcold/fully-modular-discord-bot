import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@webui/auth/guildPermissionRefresher', () => ({
  refreshUserGuilds: async (user: any) => ({ ...user, guilds: [{ id: '123456789012345678', permissions: '8', owner: false }] }),
  clearUserCache: () => {},
}));

import { FileSessionStore } from '@webui/auth/fileSessionStore';
import { requireOAuth } from '@webui/auth/oauthMiddleware';
import { createGuildPanelRoutes } from '@webui/routes/guildPanels';

afterEach(() => {
  vi.restoreAllMocks();
});

function newDir(name: string): string {
  const dir = path.join(process.env.DATA_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(n => n.endsWith('.json'));
}

async function serve(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function appWith(dir: string, mount: (app: express.Express) => void): express.Express {
  const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000 });
  store.stop();
  const pp = new passport.Passport();
  pp.serializeUser((user: any, done) => done(null, user));
  pp.deserializeUser((user: any, done) => done(null, user));
  const app = express();
  app.use(express.json());
  app.use(session({ store, secret: 'test-only-secret', resave: false, saveUninitialized: false, name: 'smdb.sid' }));
  app.use(pp.initialize());
  app.use(pp.session());
  app.get('/login', (req, res, next) => req.login({ id: 'u1', accessToken: 't', guilds: [] } as any, e => (e ? next(e) : res.json({ ok: true }))));
  mount(app);
  return app;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 100));

describe('an anonymous Guild Web-UI request never mints a session file', () => {
  it('a 401 from /guild/api writes no session and sets no cookie', async () => {
    const dir = newDir('_b021_anon');
    const app = appWith(dir, a => a.get('/guild/api/thing', requireOAuth, (_req, res) => res.json({ ok: true })));
    await serve(app, async base => {
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${base}/guild/api/thing`);
        expect(response.status).toBe(401);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
      await settle();
      expect(sessionFiles(dir)).toEqual([]);
    });
  });
});

describe('a guild refresh updates the session in place', () => {
  it('the refreshed user lands in the same session: same cookie, one file', async () => {
    const dir = newDir('_b021_refresh');
    const botManager = { isRunning: () => false } as any;
    const app = appWith(dir, a => a.use('/guild/api/panels', createGuildPanelRoutes(botManager)));
    await serve(app, async base => {
      const login = await fetch(`${base}/login`);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      await settle();
      const before = sessionFiles(dir);
      expect(before.length).toBe(1);
      const response = await fetch(`${base}/guild/api/panels/execute`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ panelId: 'p1', guildId: '123456789012345678' }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      await settle();
      expect(sessionFiles(dir)).toEqual(before);
      expect(fs.readFileSync(path.join(dir, before[0]), 'utf8')).toContain('123456789012345678');
    });
  });
});

function put(store: FileSessionStore, sid: string, user?: string): Promise<unknown> {
  const data: any = { cookie: { maxAge: 60_000 } };
  if (user) data.passport = { user: { id: user } };
  return new Promise(resolve => store.set(sid, data, resolve));
}

const pause = () => new Promise(resolve => setTimeout(resolve, 5));

describe('the session store caps its files', () => {
  it('a user past the per-user cap loses only their own oldest session', async () => {
    const dir = newDir('_b021_peruser');
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, maxPerUser: 2 } as any);
    store.stop();
    await put(store, 'other1', 'u2');
    for (const sid of ['a1', 'a2', 'a3']) {
      expect(await put(store, sid, 'u1')).toBeUndefined();
      await pause();
    }
    await settle();
    expect(sessionFiles(dir).sort()).toEqual(['a2.json', 'a3.json', 'other1.json']);
  });

  it('anonymous sessions past their cap evict the oldest anonymous one, never a signed-in one', async () => {
    const dir = newDir('_b021_anoncap');
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, maxAnonymous: 2 } as any);
    store.stop();
    await put(store, 'signed', 'u1');
    for (const sid of ['n1', 'n2', 'n3', 'n4']) {
      await put(store, sid);
      await pause();
    }
    await settle();
    expect(sessionFiles(dir).sort()).toEqual(['n3.json', 'n4.json', 'signed.json']);
  });

  it('a full store refuses a new signed-in session and keeps every existing one', async () => {
    const dir = newDir('_b021_full');
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, maxSessions: 2 } as any);
    store.stop();
    await put(store, 's1', 'u1');
    await put(store, 's2', 'u2');
    const error = await put(store, 's3', 'u3');
    expect(error).toBeInstanceOf(Error);
    expect(await put(store, 's1', 'u1')).toBeUndefined();
    await settle();
    expect(sessionFiles(dir).sort()).toEqual(['s1.json', 's2.json']);
  });
});

describe('the public-path limiter', () => {
  async function limiter(opts: Record<string, unknown>): Promise<any> {
    const mod = await import('@webui/middleware/tokenLimiter');
    return mod.createTokenLimiter({ label: 'public', capacity: 3, refillMs: 60_000, ...opts });
  }

  it('a flood from one client is refused and logged once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = express();
    app.use(['/guild', '/auth'], await limiter({}));
    app.get('/guild/x', (_req, res) => res.send('ok'));
    await serve(app, async base => {
      const statuses: number[] = [];
      for (let i = 0; i < 20; i++) statuses.push((await fetch(`${base}/guild/x`)).status);
      expect(statuses.filter(s => s === 200).length).toBe(3);
      expect(statuses.filter(s => s === 429).length).toBe(17);
    });
    expect(log.mock.calls.filter(c => String(c[0]).includes('[RateLimit]')).length).toBe(1);
  });

  it('the key map stays bounded', async () => {
    const handler = await limiter({ maxKeys: 5 });
    for (let i = 0; i < 50; i++) {
      const res: any = { setHeader() {}, status() { return res; }, json() {} };
      handler({ ip: `10.0.0.${i}`, socket: {} } as any, res, () => {});
    }
    expect(handler.size()).toBeLessThanOrEqual(5);
  });
});

describe('the server mounts its rate limits', () => {
  it('a flood of /guild and /api is refused, with one log line per limiter', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { mountRateLimits } = await import('@webui/middleware/tokenLimiter');
    const app = express();
    mountRateLimits(app);
    app.get(['/guild/x', '/api/x', '/assets/a.js', '/auth/me'], (_req, res) => res.send('ok'));
    await serve(app, async base => {
      const flood = async (p: string, n: number) => {
        const statuses: number[] = [];
        for (let i = 0; i < n; i++) statuses.push((await fetch(`${base}${p}`)).status);
        return statuses.filter(s => s === 429).length;
      };
      expect(await flood('/guild/x', 70)).toBeGreaterThanOrEqual(5);
      expect(await flood('/assets/a.js', 3)).toBe(3);
      expect(await flood('/api/x', 20)).toBeGreaterThanOrEqual(5);
    });
    const lines = log.mock.calls.filter(c => String(c[0]).includes('[RateLimit]'));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('createServer mounts them', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/webui/server.ts'), 'utf8');
    expect(src).toMatch(/^\s*mountRateLimits\(app\);/m);
  });
});

describe('a touch counts as use for eviction', () => {
  it('the per-user cap evicts the least recently used session, not the least recently set', async () => {
    const dir = newDir('_b021_touch');
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, maxPerUser: 2, touchWriteThresholdMs: 0 } as any);
    store.stop();
    await put(store, 'a1', 'u1');
    await pause();
    await put(store, 'a2', 'u1');
    await pause();
    await new Promise(resolve => store.touch('a1', { cookie: { maxAge: 120_000, originalMaxAge: 120_000, expires: new Date(Date.now() + 120_000) } } as any, resolve));
    await pause();
    await put(store, 'a3', 'u1');
    await settle();
    expect(sessionFiles(dir).sort()).toEqual(['a1.json', 'a3.json']);
  });
});

describe('each client behind the proxies has its own bucket', () => {
  it('the key is the first public address, past every private hop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { mountRateLimits, TRUST_PROXY } = await import('@webui/middleware/tokenLimiter');
    const app = express();
    app.set('trust proxy', TRUST_PROXY);
    mountRateLimits(app);
    app.get('/guild/x', (req, res) => res.send(req.ip));
    await serve(app, async base => {
      const get = (xff: string) => fetch(`${base}/guild/x`, { headers: { 'X-Forwarded-For': xff } });
      const statuses: number[] = [];
      for (let i = 0; i < 70; i++) statuses.push((await get('203.0.113.5, 172.18.0.3')).status);
      expect(statuses).toContain(429);
      const other = await get('198.51.100.7, 172.18.0.3');
      expect(other.status).toBe(200);
      expect(await other.text()).toBe('198.51.100.7');
      expect((await get('10.0.0.9, 203.0.113.5, 172.18.0.3')).status).toBe(429);
    });
  });

  it('createServer trusts only the private hops', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/webui/server.ts'), 'utf8');
    expect(src).toMatch(/app\.set\('trust proxy', TRUST_PROXY\)/);
  });
});
