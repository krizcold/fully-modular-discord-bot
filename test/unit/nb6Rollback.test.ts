import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendKind } from '../helpers/backendKind';

vi.mock('@/updater', () => ({
  checkForUpdates: async () => ({}),
  triggerUpdate: async () => ({ success: false }),
  getUpdateStatus: () => ({}),
  getUpdaterType: () => 'none',
  checkForAllUpdates: async () => ({}),
  triggerModuleUpdate: async () => ({}),
  triggerAllModuleUpdates: async () => ({}),
  describeBulkModuleUpdate: () => '',
}));

import { createUpdateRouter } from '@webui/routes/update';
import { resetDataBackendCache } from '../../src/utils/envLoader';

const appRootHelper = path.resolve(__dirname, '..', 'helpers', 'appRoot.cjs');
const { useAppRoot } = createRequire(__filename)(appRootHelper) as { useAppRoot: (root: string) => () => void };
const rollbackJs = path.resolve(__dirname, '..', '..', 'rollback.js');

const T12A = "This backup holds only App Store modules. This bot keeps its modules in its database, so nothing was restored; the App Store tab installs only the version each module's repository holds now.";
const T12B = "Rollback restored /app/custom. The App Store modules in this backup were not restored: this bot keeps its modules in its database, and the App Store tab installs only the version each module's repository holds now. Please restart the bot.";
const TODAY = 'Rollback successful. Please restart the bot.';
const T12C = "[Rollback] The App Store modules in this backup were not restored: this bot keeps its modules in its database, or its data backend could not be read. The App Store tab installs only the version each module's repository holds now.";
const NOTHING = '[Rollback] Nothing was restored: this backup holds only App Store modules, and this bot keeps its modules in its database, or its data backend could not be read.';

/** A data root and an /app root as a machine has them before the rollback: live custom, live modules, built code. */
function machine(root: string) {
  const app = path.join(root, 'app');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(app, 'custom', 'live.txt'), 'live custom');
  for (const built of ['build', 'dist']) {
    fs.mkdirSync(path.join(app, built), { recursive: true });
    fs.writeFileSync(path.join(app, built, 'index.js'), 'built');
  }
  fs.mkdirSync(path.join(root, 'appstore-modules', 'm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'appstore-modules', 'm', 'index.js'), 'live module');
  fs.writeFileSync(path.join(root, 'applied-version.json'), '{}');
  return {
    app,
    backup(ts: number, parts: { custom?: boolean; modules?: boolean }) {
      const dir = path.join(root, 'backups', `backup-${ts}`);
      fs.mkdirSync(dir, { recursive: true });
      if (parts.custom) {
        fs.mkdirSync(path.join(dir, 'custom'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'custom', 'old.txt'), 'old custom');
      }
      if (parts.modules) {
        fs.mkdirSync(path.join(dir, 'appstore-modules', 'm'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'appstore-modules', 'm', 'index.js'), 'old module');
      }
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ timestamp: ts, version: '1.0.0' }));
      return dir;
    },
    customFiles: () => fs.readdirSync(path.join(app, 'custom')).sort(),
    liveModule: () => fs.readFileSync(path.join(root, 'appstore-modules', 'm', 'index.js'), 'utf8'),
    built: () => ['build', 'dist'].filter(b => fs.existsSync(path.join(app, b))),
    marker: () => fs.existsSync(path.join(root, 'applied-version.json')),
  };
}

describe('test 36: the rollback route on a Postgres bot (decision 32, T12a, T12b)', () => {
  let server: http.Server;
  let base: string;
  let restoreFs: () => void;
  let m: ReturnType<typeof machine>;
  const bot = { shutdowns: 0, isRunning: () => false, shutdown: async () => { bot.shutdowns++; }, getStatus: () => ({}) };

  beforeEach(async () => {
    bot.shutdowns = 0;
    m = machine(process.env.DATA_DIR!);
    restoreFs = useAppRoot(m.app);
    const app = express();
    app.use(express.json());
    app.use('/api/update', createUpdateRouter(bot as never));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/update`;
  });

  afterEach(() => {
    server.close();
    restoreFs();
    delete process.env.DATA_BACKEND;
    resetDataBackendCache();
  });

  const rollback = async (ts: number) => {
    const response = await fetch(`${base}/rollback/${ts}`, { method: 'POST' });
    return { status: response.status, body: await response.json() };
  };

  it('108: a backup with custom/ and appstore-modules/ restores /app/custom alone and says the modules were not restored', async () => {
    setBackendKind('postgres');
    m.backup(1, { custom: true, modules: true });
    expect(await rollback(1)).toEqual({ status: 200, body: { success: true, message: T12B } });
    expect(bot.shutdowns).toBe(1);
    expect(m.customFiles()).toEqual(['old.txt']);
    expect(m.liveModule()).toBe('live module');
    expect(m.built()).toEqual([]);
    expect(m.marker()).toBe(false);
  });

  it('108: a backup with custom/ alone answers today\'s text', async () => {
    setBackendKind('postgres');
    m.backup(2, { custom: true });
    expect(await rollback(2)).toEqual({ status: 200, body: { success: true, message: TODAY } });
    expect(m.customFiles()).toEqual(['old.txt']);
    expect(m.liveModule()).toBe('live module');
  });

  it('109: a backup with only appstore-modules/ is refused 409 before the bot stops, and nothing is restored', async () => {
    setBackendKind('postgres');
    m.backup(3, { modules: true });
    expect(await rollback(3)).toEqual({ status: 409, body: { success: false, error: T12A } });
    expect(bot.shutdowns).toBe(0);
    expect(m.customFiles()).toEqual(['live.txt']);
    expect(m.liveModule()).toBe('live module');
    expect(m.built()).toEqual(['build', 'dist']);
    expect(m.marker()).toBe(true);
  });

  it('a data backend the web UI cannot read: refused before the bot stops, the modules untouched', async () => {
    process.env.DATA_BACKEND = 'mysql';
    resetDataBackendCache();
    m.backup(4, { custom: true, modules: true });
    const answer = await rollback(4);
    expect(answer.status).toBe(500);
    expect(answer.body.success).toBe(false);
    expect(bot.shutdowns).toBe(0);
    expect(m.customFiles()).toEqual(['live.txt']);
    expect(m.liveModule()).toBe('live module');
    expect(m.built()).toEqual(['build', 'dist']);
  });

  it('guard: a JSON bot restores both folders and answers today\'s text', async () => {
    setBackendKind('file');
    m.backup(5, { custom: true, modules: true });
    expect(await rollback(5)).toEqual({ status: 200, body: { success: true, message: TODAY } });
    expect(m.customFiles()).toEqual(['old.txt']);
    expect(m.liveModule()).toBe('old module');
    expect(m.built()).toEqual([]);
  });
});

describe('test 36: rollback.js rollback (decision 32, T12c, row 110)', () => {
  let root: string;
  let m: ReturnType<typeof machine>;

  beforeEach(() => {
    root = path.join(process.env.DATA_DIR!, 'cli');
    m = machine(root);
  });

  /** rollback.js run as a child: DATA_BACKEND as given (absent when undefined), a .env as given. */
  function run(backend: string | undefined, envFile?: string | 'folder') {
    if (envFile === 'folder') fs.mkdirSync(path.join(root, '.env'), { recursive: true });
    else if (envFile !== undefined) fs.writeFileSync(path.join(root, '.env'), envFile);
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: root, SMDB_TEST_APP_ROOT: m.app };
    delete env.DATA_BACKEND;
    if (backend !== undefined) env.DATA_BACKEND = backend;
    const child = spawnSync(process.execPath, ['-r', appRootHelper, rollbackJs, 'rollback', 'backup-1'], { env, encoding: 'utf8' });
    return { code: child.status, out: `${child.stdout}${child.stderr}` };
  }

  const usedForRollback = () => JSON.parse(fs.readFileSync(path.join(root, 'backups', 'backup-1', 'metadata.json'), 'utf8')).usedForRollback === true;

  it.each([
    ['DATA_BACKEND=postgres in its environment', 'postgres', undefined],
    ['DATA_BACKEND unset, /data/.env naming postgres', undefined, 'DATA_BACKEND=postgres\n'],
    ['DATA_BACKEND empty, /data/.env naming postgres', '', 'DATA_BACKEND=postgres\n'],
    ['DATA_BACKEND unset, an unreadable /data/.env', undefined, 'folder'],
    ['DATA_BACKEND unset, /data/.env naming a backend it does not know', undefined, 'DATA_BACKEND=mysql\n'],
  ] as const)('110, %s: custom/ restored, appstore-modules/ skipped with T12c', (_name, backend, envFile) => {
    m.backup(1, { custom: true, modules: true });
    const { code, out } = run(backend, envFile);
    expect(code, out).toBe(0);
    expect(out).toContain(T12C);
    expect(out).not.toContain('Restoring ' + path.join(root, 'appstore-modules'));
    expect(m.customFiles()).toEqual(['old.txt']);
    expect(m.liveModule()).toBe('live module');
    expect(m.built()).toEqual([]);
    expect(m.marker()).toBe(false);
    expect(usedForRollback()).toBe(true);
  });

  it.each([
    ['DATA_BACKEND=postgres', 'postgres', undefined],
    ['an unreadable /data/.env', undefined, 'folder'],
  ] as const)('110, %s, a backup of only appstore-modules/: exit 1, nothing restored or cleared', (_name, backend, envFile) => {
    m.backup(1, { modules: true });
    const { code, out } = run(backend, envFile);
    expect(code, out).toBe(1);
    expect(out).toContain(NOTHING);
    expect(out).not.toContain(T12C);
    expect(out).not.toContain('Rollback completed successfully');
    expect(m.customFiles()).toEqual(['live.txt']);
    expect(m.liveModule()).toBe('live module');
    expect(m.built()).toEqual(['build', 'dist']);
    expect(m.marker()).toBe(true);
    expect(usedForRollback()).toBe(false);
  });

  it('110: a Postgres bot with a backup holding no appstore-modules/ logs only today\'s line', () => {
    m.backup(1, { custom: true });
    const { code, out } = run('postgres');
    expect(code, out).toBe(0);
    expect(out).toContain('[Rollback] Backup has no appstore-modules/, skipping');
    expect(out).not.toContain(T12C);
    expect(m.customFiles()).toEqual(['old.txt']);
  });

  it.each([
    ['no DATA_BACKEND and no /data/.env', undefined, undefined],
    ['/data/.env naming file', undefined, 'DATA_BACKEND=file\n'],
    ['/data/.env with an empty DATA_BACKEND', undefined, 'DATA_BACKEND=\n'],
    ['DATA_BACKEND=file over a /data/.env naming postgres', 'file', 'DATA_BACKEND=postgres\n'],
  ] as const)('guard, a JSON bot (%s): both folders restored as today', (_name, backend, envFile) => {
    m.backup(1, { custom: true, modules: true });
    const { code, out } = run(backend, envFile);
    expect(code, out).toBe(0);
    expect(out).not.toContain(T12C);
    expect(m.customFiles()).toEqual(['old.txt']);
    expect(m.liveModule()).toBe('old module');
    expect(m.built()).toEqual([]);
  });
});
