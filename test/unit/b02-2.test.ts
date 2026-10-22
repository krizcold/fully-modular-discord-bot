import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainForExit } from '@internal/utils/dataManager';
import { FileSessionStore } from '@webui/auth/fileSessionStore';
import type {} from '@webui/auth/oauthMiddleware';
import oauthRoutes from '@webui/auth/oauthRoutes';

function newStore(name: string): { dir: string; store: FileSessionStore } {
  const dir = path.join(process.env.DATA_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000 });
  store.stop();
  return { dir, store };
}

const sessionData = { cookie: { maxAge: 60_000 } } as any;

describe('the web UI session store answers after the flush', () => {
  it('set calls back only once the session file is on disk', async () => {
    const { dir, store } = newStore('_b022_set');
    const onDisk = await new Promise<boolean>((resolve, reject) => {
      store.set('sidSet1', sessionData, error => (error ? reject(error) : resolve(fs.existsSync(path.join(dir, 'sidSet1.json')))));
    });
    expect(onDisk).toBe(true);
  });

  it('destroy calls back only once the session file is gone from disk', async () => {
    const { dir, store } = newStore('_b022_destroy');
    await new Promise<void>((resolve, reject) => store.set('sidDel1', sessionData, e => (e ? reject(e) : resolve())));
    await new Promise(resolve => setTimeout(resolve, 50));
    const file = path.join(dir, 'sidDel1.json');
    expect(fs.existsSync(file)).toBe(true);
    const stillThere = await new Promise<boolean>((resolve, reject) => {
      store.destroy('sidDel1', error => (error ? reject(error) : resolve(fs.existsSync(file))));
    });
    expect(stillThere).toBe(false);
  });

  it('clear calls back once every session file is gone', async () => {
    const { dir, store } = newStore('_b022_clear');
    for (const sid of ['c1', 'c2']) {
      await new Promise<void>((resolve, reject) => store.set(sid, sessionData, e => (e ? reject(e) : resolve())));
    }
    await new Promise<void>((resolve, reject) => store.clear(e => (e ? reject(e) : resolve())));
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Holds fs.promises[name] for paths under dir until the returned release runs.
function hold(name: 'rename' | 'unlink', dir: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = fs.promises[name].bind(fs.promises) as (...args: any[]) => Promise<void>;
  vi.spyOn(fs.promises, name).mockImplementation((async (...args: any[]) => {
    if (args.some(arg => String(arg).startsWith(dir))) await gate;
    return original(...args);
  }) as any);
  return release;
}

describe('set and destroy at the bound', () => {
  it('a save still queued at the bound is not an error', async () => {
    const dir = path.join(process.env.DATA_DIR!, '_b022_pending');
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, confirmMs: 100 });
    store.stop();
    const release = hold('rename', dir);
    const error = await new Promise(resolve => store.set('sidPend1', sessionData, resolve));
    release();
    expect(error).toBeUndefined();
  });
});

async function withApp(name: string, run: (base: string, dir: string, cookie: string) => Promise<void>): Promise<void> {
  const dir = path.join(process.env.DATA_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, confirmMs: 150 });
  store.stop();
  const pp = new passport.Passport();
  pp.serializeUser((user: any, done) => done(null, user));
  pp.deserializeUser((user: any, done) => done(null, user));
  const app = express();
  app.use(session({ store, secret: 'test-only-secret', resave: false, saveUninitialized: false, name: 'smdb.sid' }));
  app.use(pp.initialize());
  app.use(pp.session());
  app.get('/login', (req, res, next) => req.login({ id: 'u1' } as Express.User, error => (error ? next(error) : res.json({ ok: true }))));
  app.use('/auth', oauthRoutes);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/login`);
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/^smdb.sid=/);
    await run(base, dir, cookie);
  } finally {
    server.close();
  }
}

describe('GET /auth/logout through passport', () => {
  it('the user-less save landed and the old file delete is still pending: success, cookie cleared', async () => {
    await withApp('_b022_logout_ok', async (base, dir, cookie) => {
      const release = hold('unlink', dir);
      const response = await fetch(`${base}/auth/logout`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true });
      expect(response.headers.get('set-cookie') ?? '').toMatch(/^smdb.sid=;/);
      const files = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain('u1');
      release();
    });
  });

  it('the user-less save still pending at the bound: could not be confirmed, cookie kept', async () => {
    await withApp('_b022_logout_pending', async (base, dir, cookie) => {
      const release = hold('rename', dir);
      const response = await fetch(`${base}/auth/logout`, { headers: { cookie } });
      release();
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ success: false, error: 'Logout could not be confirmed' });
      expect(response.headers.get('set-cookie') ?? '').not.toMatch(/^smdb.sid=;/);
    });
  });

  it('the user-less save refused: Failed to logout', async () => {
    await withApp('_b022_logout_refused', async (base, _dir, cookie) => {
      await drainForExit(200);
      const response = await fetch(`${base}/auth/logout`, { headers: { cookie } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ success: false, error: 'Failed to logout' });
    });
  });
});
