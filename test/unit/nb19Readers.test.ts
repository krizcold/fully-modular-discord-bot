import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => ({ holder: null as null | { pid: number; role: string; start: null; at: number } }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<any>();
  return { ...real, deposedHolder: () => lock.holder ?? real.deposedHolder() };
});

import { confirmFile, dropPendingForGuild, enqueueWrite, fileTicket, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { FileSessionStore, sessionSaveOutcome } from '../../src/webui/auth/fileSessionStore';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';
import type {} from '../../src/webui/auth/oauthMiddleware';
import oauthRoutes from '../../src/webui/auth/oauthRoutes';

// NB19 decision 9: a reader of a failed file ticket whose range carries a folder sync kind words it as can't confirm
// (the file holds the new bytes), never as not saved or not kept.

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let guilds = 850_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
let stub: AppendStub;

const T21 = (file: string, kind: 'sync' | 'open' | 'earlier', dir: string, errno: string) => {
  const { why, next } = syncWords(kind, dir, errno);
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};

async function setFlagAt(x: string): Promise<void> {
  stub.failDirSync(x, 'EIO');
  const p = path.join(x, 'f.json');
  enqueueWrite(p, '{}');
  expect(await confirmFile(fileTicket(p), 3000)).toBe('unavailable');
}

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
});
afterEach(async () => {
  lock.holder = null;
  stub.restore();
  await flushAll();
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe.skipIf(!POSIX)('row 70: the web panel\'s guild data write', () => {
  const write = (g: string) => applyOperatorDataWrite({ guildId: g, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"x":1}' } as never);
  const banned = /left this node|nothing was saved|unloaded|deleted|restored|took/;

  it('EIO on /data: T21 of kind sync naming /data and the restart', async () => {
    stub.failDirSync(ROOT, 'EIO');
    const g = freshGuild();
    const reply: any = await write(g);
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: T21('a.json', 'sync', ROOT, 'EIO') });
    expect(reply.error).not.toMatch(banned);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toContain('"x"');
  });

  it('under a flag set by /data/x: T21 of kind earlier quoting /data/x', async () => {
    const x = dataPath(`x${freshGuild()}`);
    await setFlagAt(x);
    const reply: any = await write(freshGuild());
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: T21('a.json', 'earlier', x, 'EIO') });
  });

  it('EMFILE on the open of /data/G: T21 of kind open with its advice', async () => {
    const g = freshGuild();
    stub.rejectDirOpen(dataPath(g), 'EMFILE', 1);
    const reply: any = await write(g);
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: T21('a.json', 'open', dataPath(g), 'EMFILE') });
    expect(reply.error).toContain('check the current state before you repeat the action');
  });

  it('EIO on /data while another process takes the lock before the answer: T21 of kind sync, not the deposed text', async () => {
    const g = freshGuild();
    const hold = stub.holdDirSync(ROOT, 'EIO');
    const pending = write(g);
    await hold.reached;
    lock.holder = { pid: 5353, role: 'bot', start: null, at: Date.now() };
    hold.release();
    const reply: any = await pending;
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: T21('a.json', 'sync', ROOT, 'EIO') });
    expect(reply.error).not.toMatch(banned);
    expect(reply.error).not.toContain('Another process took the data files');
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toContain('"x"');
  });
});

describe.skipIf(!POSIX)('row 77: the web sessions', () => {
  const session = () => ({ cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) } }) as any;
  const setOf = (store: FileSessionStore, sid: string, s: any) => new Promise<unknown>(resolve => store.set(sid, s, error => resolve(error)));

  it('under the flag, a session save answers with no error and notes pending', async () => {
    await setFlagAt(dataPath(`x${freshGuild()}`));
    const store = new FileSessionStore({ dir: dataPath('nb19sessions') });
    const s = session();
    expect(await setOf(store, 'sid-a1', s)).toBeUndefined();
    expect(sessionSaveOutcome(s)).toBe('pending');
    expect(fs.existsSync(path.join(dataPath('nb19sessions'), 'sid-a1.json'))).toBe(true);
  });

  it('EMFILE on the open of the sessions folder notes pending too', async () => {
    const dir = dataPath('nb19sessions2');
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir });
    stub.rejectDirOpen(dir, 'EMFILE', 1);
    const s = session();
    expect(await setOf(store, 'sid-b1', s)).toBeUndefined();
    expect(sessionSaveOutcome(s)).toBe('pending');
  });
});

describe.skipIf(!POSIX)('row 77: the dropped op and /auth/logout', () => {
  const newSession = () => ({ cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) } }) as any;

  it('a session op dropped with no kind keeps refused and calls back with an error', async () => {
    const g = freshGuild();
    const dir = dataPath(g, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000 });
    store.stop();
    const realRename = fs.promises.rename.bind(fs.promises);
    let renames = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(dir)) {
        renames += 1;
        throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      }
      return realRename(from, to);
    });
    const s = newSession();
    const answered = new Promise<unknown>(resolve => store.set('sid-c1', s, error => resolve(error)));
    await vi.waitFor(() => expect(renames).toBeGreaterThan(0), { timeout: 3000, interval: 2 });
    dropPendingForGuild(g);
    expect(await answered).toBeInstanceOf(Error);
    expect(sessionSaveOutcome(s)).toBe('refused');
    expect(fs.existsSync(path.join(dir, 'sid-c1.json'))).toBe(false);
  });

  async function withApp(dir: string, run: (base: string, cookie: string, store: FileSessionStore) => Promise<void>): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, confirmMs: 3000 });
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
      await run(base, cookie, store);
    } finally {
      server.close();
    }
  }
  const noUserLeft = (dir: string) => {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain('"u1"');
  };

  it('under the flag, a login goes on and a logout answers 202 "Logout could not be confirmed"', async () => {
    await setFlagAt(dataPath(`x${freshGuild()}`));
    const dir = dataPath(`nb19sessions-flag-${freshGuild()}`);
    await withApp(dir, async (base, cookie) => {
      const response = await fetch(`${base}/auth/logout`, { headers: { cookie } });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ success: false, error: 'Logout could not be confirmed' });
      noUserLeft(dir);
    });
  });

  it('a logout whose session op is dropped with no kind answers the 500 of today and the file keeps the user', async () => {
    const g = freshGuild();
    const dir = dataPath(g, 'sessions');
    await withApp(dir, async (base, cookie, store) => {
      const saved: any[] = [];
      const realSet = store.set.bind(store);
      vi.spyOn(store, 'set').mockImplementation((sid: string, s: any, cb?: (error?: unknown) => void) => {
        saved.push(s);
        return realSet(sid, s, cb);
      });
      const before = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
      expect(before).toHaveLength(1);
      const file = path.join(dir, before[0]);
      const bytes = fs.readFileSync(file, 'utf8');
      expect(bytes).toContain('"u1"');
      const realRename = fs.promises.rename.bind(fs.promises);
      let renames = 0;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to).startsWith(dir)) {
          renames += 1;
          throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
        }
        return realRename(from, to);
      });
      const answered = fetch(`${base}/auth/logout`, { headers: { cookie } });
      await vi.waitFor(() => expect(renames).toBeGreaterThan(0), { timeout: 3000, interval: 2 });
      dropPendingForGuild(g);
      const response = await answered;
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ success: false, error: 'Failed to logout' });
      expect(saved).toHaveLength(1);
      expect(sessionSaveOutcome(saved[0])).toBe('refused');
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    });
  });

  it('EMFILE on the open of the sessions folder at the logout: 202, not 500', async () => {
    const dir = dataPath(`nb19sessions-open-${freshGuild()}`);
    await withApp(dir, async (base, cookie) => {
      stub.rejectDirOpen(dir, 'EMFILE', 10);
      const response = await fetch(`${base}/auth/logout`, { headers: { cookie } });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ success: false, error: 'Logout could not be confirmed' });
      noUserLeft(dir);
    });
  });
});
