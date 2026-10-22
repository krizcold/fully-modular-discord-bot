import fs from 'fs';
import http from 'http';
import { syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import { vi } from 'vitest';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataRead, applyOperatorGlobalRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import type { BotManager } from '../../src/webui/botManager';

// C01's rig: the web UI's config routes in front of a scripted bot child. By default the child answers through the
// real read handlers over this process's own queue and disk, as a child on the same node would; a test scripts it to
// hold a newer body (its own queued write), to refuse, to answer late, or to be down.

export type Reply = Record<string, unknown>;
type Scripted = object | Promise<object> | undefined;
export interface GuildRead { guildId: string; module: string; filename?: string; scope?: 'all' }
export interface GlobalRead { root?: 'config'; rel?: string }

export class FakeChild {
  running = true;
  guild: ((req: GuildRead) => Scripted) | null = null;
  global: ((req: GlobalRead) => Scripted) | null = null;
  write: ((req: any) => Reply | undefined) | null = null;
  readonly guildReads: GuildRead[] = [];
  readonly globalReads: GlobalRead[] = [];
  readonly writes: any[] = [];

  reset(): void {
    this.running = true;
    this.guild = null;
    this.global = null;
    this.write = null;
    this.guildReads.length = 0;
    this.globalReads.length = 0;
    this.writes.length = 0;
  }
}

export const globalPathOf = (req: GlobalRead) => (req.root === 'config' ? ROOT_CONFIG_PATH : dataPath('global', ...String(req.rel).split('/')));

// The in-process child shares this process's queue; the bot child of a real node holds none of the web UI's writes.
const ownNothing = (reply: any) => (reply?.ok ? { ...reply, pending: false, failing: false } : reply);

export function botFor(child: FakeChild): BotManager {
  const down = { ok: false, code: 'bot-down', error: 'bot process is not running' };
  return {
    isRunning: () => child.running,
    listLoadedModules: async () => null,
    notifySyncMutation: () => undefined,
    readGuildData: async (req: GuildRead) => {
      child.guildReads.push(req);
      if (!child.running) return down;
      const scripted = child.guild?.(req);
      if (scripted) return scripted;
      if (req.filename === undefined) return { ok: true, files: [] };
      return ownNothing(await applyOperatorDataRead({ guildId: req.guildId, module: req.module, filename: req.filename }));
    },
    readGlobalData: async (req: GlobalRead) => {
      child.globalReads.push(req);
      if (!child.running) return down;
      const scripted = child.global?.(req);
      if (scripted) return scripted;
      return ownNothing(applyOperatorGlobalRead(req));
    },
    writeGuildData: async (req: any) => {
      child.writes.push(req);
      if (!child.running) return down;
      return child.write?.(req) ?? { ok: true };
    },
  } as unknown as BotManager;
}

export async function startApp(mount: (app: express.Express) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

export function startConfigApp(child: FakeChild) {
  return startApp(app => app.use('/api/config', createConfigRoutes(botFor(child))));
}

export async function call(base: string, method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}

export const BACKUPS = () => dataPath('configBackups');

/** Every queued write landed, then the data root emptied but for an empty backup dir. */
export async function resetData(): Promise<void> {
  await flushAll();
  const root = dataPath();
  for (const entry of fs.readdirSync(root)) fs.rmSync(dataPath(entry), { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(BACKUPS(), { recursive: true });
}

export function put(absPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function readJson(absPath: string): any {
  return JSON.parse(fs.readFileSync(absPath, 'utf-8'));
}

export const backupNames = () => fs.readdirSync(BACKUPS()).filter(name => !name.startsWith('.')).sort();

export const later = <T>(ms: number, value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), ms));

/** The path exists but cannot be read (EACCES), in this process and in the in-process child; returns the undo. */
export function unreadable(absPath: string): () => void {
  const real = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(absPath)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
    }
    return (real as any)(p, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  return () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
}

/** Every flush of the path fails (ENOSPC), so its queued write stays queued; returns the undo. */
export function failFlushes(absPath: string): () => void {
  const real = fs.promises.open;
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p).startsWith(`${absPath}.`) && String(p).endsWith('.tmp')) {
      return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    }
    return (real as any)(p, ...rest);
  }) as typeof fs.promises.open);
  return () => spy.mockRestore();
}
