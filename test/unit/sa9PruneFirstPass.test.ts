import { afterEach, describe, expect, it, vi } from 'vitest';

// The first module pass of a process prunes cache/backups: nothing has reset the module apply's state before it, as
// in a bot that just started.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _setModuleDirs, modulePassStep } from '../../src/bot/internalSetup/utils/moduleApply';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

const DAY = 86_400_000;
let pg: ReturnType<typeof scriptedBackend> | null = null;
let root = '';

afterEach(async () => {
  _setModuleDirs(null);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  setMainChooser(null);
  setBackendKind(null);
  await pg?.backend.stop();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a process's first module pass", () => {
  it('prunes a backup older than 30 days', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
    setBackendKind('postgres');
    setView(1, 'ALPHA');
    const rows = sharedRows();
    pg = scriptedBackend(rows.answer);
    dm.setGuildDataBackend(pg.backend);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa9prune-'));
    const backups = dataPath('global', 'appstore', 'cache', 'backups');
    const dist = path.join(root, 'dist', 'bot', 'modules');
    const dirs = { source: path.join(root, 'appstore-modules'), build: path.join(root, 'build', 'bot', 'modules'), dist };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    _setModuleDirs({ ...dirs, backups, buildFile: path.join(root, 'dist', '.build-complete') });
    const old = path.join(backups, `m-${Date.now() - 40 * DAY}-failed`);
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'module.json'), '{"name":"m"}');
    await modulePassStep({ tag0: '1:ALPHA' });
    expect(fs.existsSync(old)).toBe(false);
    expect(lines).toContain(`[Shared] Deleted the module backup ${old}: it was older than 30 days and not the newest backup of m`);
  });
});
