import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import path from 'path';
import { promisify } from 'util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  const exec = (command: string, ...rest: unknown[]) => {
    shell.commands.push(command);
    const callback = rest.find(arg => typeof arg === 'function') as ((e: null, out: string, err: string) => void) | undefined;
    callback?.(null, '0\n', '');
  };
  (exec as unknown as Record<symbol, unknown>)[promisify.custom] = async (command: string) => {
    shell.commands.push(command);
    return { stdout: '0\n', stderr: '' };
  };
  return { ...actual, exec, default: { ...actual, exec } };
});

vi.mock('@/updater', () => ({
  checkForUpdates: async () => ({}),
  triggerUpdate: async () => ({ success: false }),
  getUpdateStatus: () => ({}),
  getUpdaterType: () => 'none',
  checkForAllUpdates: async () => ({}),
  triggerModuleUpdate: async () => ({}),
  triggerAllModuleUpdates: async () => ({}),
}));

import { createUpdateRouter } from '@webui/routes/update';

const dataDir = () => process.env.DATA_DIR!;
const backupsDir = () => path.join(dataDir(), 'backups');

function makeBackup(name: string, opts: { metadata?: boolean; custom?: boolean } = {}): string {
  const dir = path.join(backupsDir(), name);
  fs.mkdirSync(path.join(dir, opts.custom === false ? 'appstore-modules' : 'custom'), { recursive: true });
  if (opts.metadata !== false) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ timestamp: Number(name.replace('backup-', '')) || 0 }));
  return dir;
}

describe('update routes: backup ids', () => {
  let server: http.Server;
  let base: string;
  const bot = { shutdowns: 0, isRunning: () => false, shutdown: async () => { bot.shutdowns++; }, getStatus: () => ({}) };

  beforeEach(async () => {
    shell.commands.length = 0;
    bot.shutdowns = 0;
    fs.rmSync(backupsDir(), { recursive: true, force: true });
    fs.mkdirSync(backupsDir(), { recursive: true });
    const app = express();
    app.use(express.json());
    app.use('/api/update', createUpdateRouter(bot as never));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/update`;
  });

  afterEach(() => { server.close(); });

  const victim = () => {
    const dir = path.join(dataDir(), 'victim');
    fs.mkdirSync(path.join(dir, 'custom'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'custom', 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{}');
    return dir;
  };

  const crafted = ['1%2F..%2F..%2Fvictim', '..%2F..%2Fvictim', '1%20x', 'abc', '-1', '1.5'];

  it('DELETE refuses every id that is not a whole number, and changes nothing', async () => {
    const dir = victim();
    makeBackup('backup-1');
    for (const id of crafted) {
      const response = await fetch(`${base}/backup/${id}`, { method: 'DELETE' });
      expect(response.status, id).toBe(400);
      expect((await response.json()).success, id).toBe(false);
    }
    expect(fs.existsSync(path.join(dir, 'custom', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir(), 'backup-1'))).toBe(true);
    expect(shell.commands).toEqual([]);
  });

  it('POST /rollback refuses every crafted id before stopping the bot, and changes nothing', async () => {
    const dir = victim();
    for (const id of crafted) {
      const response = await fetch(`${base}/rollback/${id}`, { method: 'POST' });
      expect(response.status, id).toBe(400);
    }
    expect(bot.shutdowns).toBe(0);
    expect(shell.commands).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'custom', 'keep.txt'))).toBe(true);
  });

  it('a backup folder without metadata.json is not listed, so DELETE and rollback answer 404 and leave it', async () => {
    const dir = makeBackup('backup-7', { metadata: false });
    expect((await fetch(`${base}/backup/7`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/rollback/7`, { method: 'POST' })).status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'custom'))).toBe(true);
    expect(bot.shutdowns).toBe(0);
    expect(shell.commands).toEqual([]);
  });

  it('POST /rollback refuses a backup whose subfolder is a link, before stopping the bot, and changes nothing', async () => {
    const outside: string[] = [];
    const inData = (p: unknown) => path.resolve(String(p)).startsWith(path.resolve(dataDir()));
    for (const name of ['rm', 'cp', 'mkdir', 'readdir'] as const) {
      const original = fs.promises[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fs.promises, name).mockImplementation(((...a: unknown[]) => {
        if (!inData(a[0]) || (name === 'cp' && !inData(a[1]))) { outside.push(`${name} ${String(a[0])}`); throw new Error('outside the test data root'); }
        return original.apply(fs.promises, a);
      }) as never);
    }
    try {
      const target = path.join(dataDir(), 'link-target');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'a.txt'), 'a');
      const dir = path.join(backupsDir(), 'backup-8');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'metadata.json'), '{"timestamp":8}');
      fs.symlinkSync(target, path.join(dir, 'appstore-modules'), 'junction');
      const live = path.join(dataDir(), 'appstore-modules');
      fs.mkdirSync(live, { recursive: true });
      fs.writeFileSync(path.join(live, 'keep.txt'), 'keep');
      const response = await fetch(`${base}/rollback/8`, { method: 'POST' });
      expect(response.status).toBe(400);
      expect(bot.shutdowns).toBe(0);
      expect(outside).toEqual([]);
      expect(fs.readFileSync(path.join(live, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('DELETE of a listed backup removes only that folder, without a shell', async () => {
    const gone = makeBackup('backup-5');
    const kept = makeBackup('backup-6');
    const response = await fetch(`${base}/backup/5`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(shell.commands).toEqual([]);
  });

  it('POST /backup writes the snapshot and its size without a shell', async () => {
    const response = await fetch(`${base}/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'x' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(typeof body.backup.size).toBe('number');
    expect(fs.existsSync(path.join(backupsDir(), `backup-${body.backup.timestamp}`, 'metadata.json'))).toBe(true);
    expect(shell.commands).toEqual([]);
  });
});

describe('rollback.js CLI', () => {
  const rollback = createRequire(__filename)(path.resolve(__dirname, '..', '..', 'rollback.js')) as {
    main: (args: string[]) => number;
  };
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    fs.rmSync(backupsDir(), { recursive: true, force: true });
    for (let i = 1; i <= 4; i++) makeBackup(`backup-${i}`);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const remaining = () => fs.readdirSync(backupsDir()).sort();
  const all = ['backup-1', 'backup-2', 'backup-3', 'backup-4'];

  it.each([['0'], ['abc'], ['-1'], ['1.5'], ['2x'], ['']])("cleanup '%s' is refused with exit 2, names the typed text and removes nothing", keep => {
    expect(rollback.main(['cleanup', keep])).toBe(2);
    expect(out.join('\n')).toContain(`'${keep}'`);
    expect(remaining()).toEqual(all);
  });

  it('cleanup without --yes lists what it would remove and removes nothing', () => {
    expect(rollback.main(['cleanup', '2'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('backup-1');
    expect(text).toContain('backup-2');
    expect(text).not.toContain('backup-4');
    expect(remaining()).toEqual(all);
  });

  it('cleanup 2 --yes lists and removes the two oldest only', () => {
    expect(rollback.main(['cleanup', '2', '--yes'])).toBe(0);
    expect(out.join('\n')).toContain('backup-1');
    expect(remaining()).toEqual(['backup-3', 'backup-4']);
  });

  it('a metadata.json cannot name another path or name: cleanup --yes removes the backup folder itself', () => {
    const victim = path.join(dataDir(), 'victim-meta');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(backupsDir(), 'backup-1', 'metadata.json'), JSON.stringify({ timestamp: 1, name: 'x', path: victim }));
    expect(rollback.main(['cleanup', '3', '--yes'])).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
    expect(remaining()).toEqual(['backup-2', 'backup-3', 'backup-4']);
  });

  it('rollback of a listed backup whose subfolder is a link is refused with exit 1 and changes nothing', () => {
    const outside: string[] = [];
    const inData = (p: unknown) => path.resolve(String(p)).startsWith(path.resolve(dataDir()));
    for (const name of ['rmSync', 'mkdirSync', 'copyFileSync', 'unlinkSync', 'writeFileSync'] as const) {
      const original = fs[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
        if (!inData(a[0]) || (name === 'copyFileSync' && !inData(a[1]))) { outside.push(`${name} ${String(a[0])}`); throw new Error('outside the test data root'); }
        return original.apply(fs, a);
      }) as never);
    }
    const target = path.join(dataDir(), 'cli-link-target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.txt'), 'a');
    const dir = path.join(backupsDir(), 'backup-9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{"timestamp":9}');
    fs.symlinkSync(target, path.join(dir, 'appstore-modules'), 'junction');
    const live = path.join(dataDir(), 'appstore-modules');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'keep.txt'), 'keep');
    let code: unknown;
    try { code = rollback.main(['rollback', 'backup-9']); } catch (error) { code = error; }
    expect(code).toBe(1);
    expect(outside).toEqual([]);
    expect(fs.readFileSync(path.join(live, 'keep.txt'), 'utf8')).toBe('keep');
    expect(out.join('\n')).toContain('not a plain folder');
  });

  it.each([[''], ['   ']])("rollback with an empty name '%s' is refused with exit 2 and restores nothing", name => {
    expect(rollback.main(['rollback', name])).toBe(2);
    expect(out.join('\n')).not.toContain('Starting rollback');
  });

  it('rollback of a name that is not a listed backup is refused and restores nothing', () => {
    fs.mkdirSync(path.join(dataDir(), 'victim', 'custom'), { recursive: true });
    for (const name of ['../victim', 'backup-9', 'backup-1/../../victim']) {
      expect(rollback.main(['rollback', name]), name).toBe(1);
    }
    expect(out.join('\n')).not.toContain('Starting rollback');
  });
});
