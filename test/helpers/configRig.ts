import fs from 'fs';
import http from 'http';
import { syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import { vi } from 'vitest';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataRead, applyOperatorDataWrite, applyOperatorGlobalRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { readRawStrict } from '../../src/bot/internalSetup/utils/dataManager';
import { resolveDataBackend } from '../../src/utils/envLoader';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import type { BotManager } from '../../src/webui/botManager';

// C01's rig: the web UI's config routes in front of a scripted bot child. By default the child answers through the
// real read handlers over this process's own queue and disk, as a child on the same node would; a test scripts it to
// hold a newer body (its own queued write), to refuse, to answer late, or to be down.

export type Reply = Record<string, unknown>;
type Scripted = object | Promise<object> | undefined;
export interface GuildRead { guildId: string; module: string; filename?: string }
export interface GlobalRead { root?: 'config'; rel?: string }

export class FakeChild {
  running = true;
  guild: ((req: GuildRead) => Scripted) | null = null;
  global: ((req: GlobalRead) => Scripted) | null = null;
  write: ((req: any) => Reply | undefined) | null = null;
  shared: ((req: { op: string; args: any }) => Reply | undefined) | null = null;
  readonly sharedOps: Array<{ op: string; args: any }> = [];
  readonly guildReads: GuildRead[] = [];
  readonly globalReads: GlobalRead[] = [];
  readonly writes: any[] = [];

  reset(): void {
    this.running = true;
    this.guild = null;
    this.global = null;
    this.write = null;
    this.shared = null;
    this.sharedOps.length = 0;
    this.guildReads.length = 0;
    this.globalReads.length = 0;
    this.writes.length = 0;
  }
}

export const globalPathOf = (req: GlobalRead) => (req.root === 'config' ? ROOT_CONFIG_PATH : dataPath('global', ...String(req.rel).split('/')));

// The in-process child shares this process's queue; the bot child of a real node holds none of the web UI's writes.
const ownNothing = (reply: any) => (reply?.ok ? { ...reply, pending: false, failing: false } : reply);

/** The body a scripted child read answers (null for absent); undefined when the read is not scripted or not a body. */
function heldBody(scripted: Scripted): string | null | undefined {
  if (!scripted) return undefined;
  const reply = scripted as any;
  if (reply.ok !== true) return undefined;
  return typeof reply.contentJson === 'string' ? reply.contentJson : null;
}

/** Puts the body a scripted child holds where the in-process executor reads it (its store), unless this process queued one. */
function hold(absPath: string, body: string | null | undefined): void {
  if (body === undefined || readRawStrictOrNull(absPath) === body) return;
  if (body === null) fs.rmSync(absPath, { force: true });
  else put(absPath, body);
}

function readRawStrictOrNull(absPath: string): string | null {
  try {
    return readRawStrict(absPath);
  } catch {
    return null;
  }
}

const guildPathOf = (req: { guildId: string; module: string; filename?: string }) => (req.module ? dataPath(req.guildId, req.module, String(req.filename)) : dataPath(req.guildId, String(req.filename)));

export function botFor(child: FakeChild): BotManager {
  // What the scripted child answered for each file at its last read: the body a write it applies is built over.
  const lastRead = new Map<string, Scripted>();
  const down = { ok: false, code: 'bot-down', error: 'bot process is not running' };
  return {
    isRunning: () => child.running,
    listLoadedModules: async () => null,
    readGuildData: async (req: GuildRead) => {
      child.guildReads.push(req);
      if (!child.running) return down;
      const scripted = await child.guild?.(req);
      if (req.filename !== undefined) lastRead.set(guildPathOf(req), scripted);
      if (scripted) return scripted;
      if (req.filename === undefined) return { ok: true, files: [] };
      return ownNothing(await applyOperatorDataRead({ guildId: req.guildId, module: req.module, filename: req.filename }));
    },
    readGlobalData: async (req: GlobalRead) => {
      child.globalReads.push(req);
      if (!child.running) return down;
      const scripted = await child.global?.(req);
      lastRead.set(globalPathOf(req), scripted);
      if (scripted) return scripted;
      return ownNothing(applyOperatorGlobalRead(req));
    },
    // NB10: every guild write reaches the bot process, which applies it in this process's queue here; with no child a
    // JSON bot's write runs in the web UI's local chain, applied the same way. A Postgres write answers as scripted.
    writeGuildData: async (req: any) => {
      child.writes.push(req);
      const postgres = resolveDataBackend() === 'postgres';
      if (!child.running && (postgres || req.op === 'delete' || req.op === 'delete-namespace' || req.op === 'restore-graveyard')) return down;
      const scripted = child.write?.(req);
      if (scripted) return scripted;
      if (postgres) return { ok: true };
      if (req.op !== 'write' || !child.running) return applyOperatorDataWrite(req);
      // A child scripted to hold its own body applies the write over that body: it is put where the executor reads.
      hold(guildPathOf(req), heldBody(lastRead.get(guildPathOf(req))));
      if (req.twin) hold(globalPathOf(req.twin), heldBody(lastRead.get(globalPathOf(req.twin))));
      return applyOperatorDataWrite(req);
    },
    writeRefusal: () => null,
    // NB10's route as NB7's plan reads it: the child while it runs; with none, bot-down for a Postgres guild.
    writerRoute: (_kind: string, opts: { postgresGuild?: boolean } = {}) => (child.running
      ? { route: 'child' }
      : opts.postgresGuild ? { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' } : { route: 'local' }),
    runSharedOp: async (op: string, args: any) => {
      child.sharedOps.push({ op, args });
      const scripted = child.shared?.({ op, args });
      if (scripted) return scripted;
      const target = op === 'global.write' ? { root: args?.root, rel: args?.rel } : op === 'premium.setGlobalModuleConfig' ? { rel: args?.rel } : null;
      if (target && child.running) hold(globalPathOf(target), heldBody(lastRead.get(globalPathOf(target))));
      return applySharedOp({ op, args });
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
  // The data editor sends the sha of the body it loaded (NB10 decision 18): a save without one first loads, as the editor does.
  if (route === '/api/config/data/update' && body && typeof body === 'object' && !('loadedSha' in body)) {
    const b = body as { file?: string; guildId?: string };
    const loaded = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent(String(b.file))}${b.guildId ? `&guildId=${b.guildId}` : ''}`);
    body = { ...b, loadedSha: typeof loaded.body?.sha === 'string' ? loaded.body.sha : 'absent' };
  }
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

/** Every flush of the path fails (ENOSPC unless another errno is given), so its queued write stays queued; returns the undo. */
export function failFlushes(absPath: string, code = 'ENOSPC'): () => void {
  const real = fs.promises.open;
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p).startsWith(`${absPath}.`) && String(p).endsWith('.tmp')) {
      return Promise.reject(Object.assign(new Error(`${code}: injected flush failure`), { code }));
    }
    return (real as any)(p, ...rest);
  }) as typeof fs.promises.open);
  return () => spy.mockRestore();
}
