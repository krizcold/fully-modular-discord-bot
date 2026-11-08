import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetRowQueue, reopenRows } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, setSharedModulePassStep } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { publishModule, unpublishModule } from '../../src/bot/internalSetup/utils/sharedModules';
import {
  _resetModuleApply, _setModuleDirs, applyModuleChange, modulePassStep, setModuleApplyClient, type ApplyResult, type ModuleChange,
} from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { setBackendKind } from './backendKind';
import { setView } from './nb6Mirror';
import { scriptedBackend } from './scriptedPg';
import { sharedRows } from './sharedRows';
import { fakeLoader } from './nb6FakeLoader';

export { fakeLoader, moduleShaOfFiles, noFile, otherError, ownError, reloaderFakes } from './nb6FakeLoader';

// The module apply's rig (NB6 part 16): a Postgres bot whose data pool is the real PostgresBackend over scripted
// clients answering as the shared tables do (sharedRows.ts), a temp /data, NB5's chooser view for the main tag, and
// production's three module trees (source, build, dist) as temp folders. Module rows are written by the real
// publishModule and unpublishModule; folders and entries by the real apply. The loader and the compile are the fake
// of `fakeLoader` below, which a test file installs with vi.mock over moduleReloader.ts.

export interface ApplyRig {
  rows: ReturnType<typeof sharedRows>;
  pg: ReturnType<typeof scriptedBackend>;
  lines: string[];
  root: string;
  source: string;
  build: string;
  dist: string;
  backups: string;
}

const INSTALLED = 'global/appstore/installed.json';

export function applyRig() {
  const state = {} as ApplyRig;
  let staged = 0;

  const readTree = (dir: string): Record<string, string> | null => {
    if (!fs.existsSync(dir)) return null;
    const out: Record<string, string> = {};
    const walk = (at: string, rel: string) => {
      for (const e of fs.readdirSync(at, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(at, e.name), r);
        else out[r] = fs.readFileSync(path.join(at, e.name), 'utf8');
      }
    };
    walk(dir, '');
    return out;
  };

  const writeTree = (dir: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return dir;
  };

  const installedBody = (): { body: Record<string, unknown>; base: string } => {
    const row = state.rows.docs.get(INSTALLED);
    return { body: row ? JSON.parse(row.body.toString('utf8')) : { modules: {} }, base: row?.sha ?? 'absent' };
  };

  const rig = {
    state,
    readTree,
    writeTree,
    async setup(): Promise<void> {
      state.lines = [];
      for (const level of ['log', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { state.lines.push(args.map(String).join(' ')); });
      }
      _resetRowQueue();
      _resetSharedMirror();
      setSharedModulePassStep(modulePassStep);
      _resetModuleApply();
      _resetModuleCrashes();
      fs.rmSync(dataPath('global'), { recursive: true, force: true });
      fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
      setBackendKind('postgres');
      setView(1, 'ALPHA');
      state.rows = sharedRows();
      state.pg = scriptedBackend(state.rows.answer);
      dm.setGuildDataBackend(state.pg.backend);
      state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6apply-'));
      state.source = path.join(state.root, 'appstore-modules');
      state.build = path.join(state.root, 'build', 'bot', 'modules');
      state.dist = path.join(state.root, 'dist', 'bot', 'modules');
      state.backups = dataPath('global', 'appstore', 'cache', 'backups');
      for (const dir of [state.source, state.build, state.dist]) fs.mkdirSync(dir, { recursive: true });
      _setModuleDirs({ source: state.source, build: state.build, dist: state.dist, backups: state.backups, buildFile: path.join(state.root, 'dist', '.build-complete') });
      fakeLoader.reset(state.source);
      setModuleApplyClient({} as Client);
    },
    async teardown(): Promise<void> {
      _setModuleDirs(null);
      _resetModuleApply();
      _resetModuleCrashes();
      _resetSharedMirror();
      dm.setGuildDataBackend(null);
      reopenRows();
      _resetRowQueue();
      setMainChooser(null);
      setBackendKind(null);
      await state.pg.backend.stop();
      fs.rmSync(state.root, { recursive: true, force: true });
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
    /** A version published by another machine (BRAVO's install of the same rows, written by the real publish). */
    async publish(module: string, files: Record<string, string>, version = '1.0.0'): Promise<string> {
      staged += 1;
      const dir = writeTree(path.join(state.root, `stage-${staged}`, module), files);
      const { body, base } = installedBody();
      (body.modules as Record<string, unknown>)[module] = { version };
      const answer = await publishModule(module, dir, JSON.stringify(body), base, { operation: base === 'absent' ? 'install' : 'update', version });
      if (answer.kind !== 'committed') throw new Error(`publish ${module}: ${JSON.stringify(answer)}`);
      return answer.sha;
    },
    async unpublish(module: string): Promise<void> {
      const { body, base } = installedBody();
      delete (body.modules as Record<string, unknown>)[module];
      const answer = await unpublishModule(module, JSON.stringify(body), base);
      if (answer.kind !== 'committed') throw new Error(`unpublish ${module}: ${JSON.stringify(answer)}`);
    },
    /** The apply of the row a publish stored, as the pass sends it. */
    apply(module: string, to: string, extra: Partial<ModuleChange> = {}): Promise<ApplyResult> {
      return applyModuleChange({ module, to, source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA', version: state.rows.modules.get(module)?.version ?? null, updatedBy: 'BRAVO/p-bravo', ...extra });
    },
    /** A version in place on this machine: published, then applied by the real apply. */
    async inPlace(module: string, files: Record<string, string>, version = '1.0.0'): Promise<string> {
      const sha = await rig.publish(module, files, version);
      const result = await rig.apply(module, sha);
      if (result.outcome !== 'applied') throw new Error(`apply ${module}: ${JSON.stringify(result)}`);
      return sha;
    },
    entry(module: string): ModuleEntry | undefined {
      const read = readStoreRecord();
      if (!read.ok) throw new Error(read.reason);
      return read.record.modules[module];
    },
    live: (module: string) => readTree(path.join(state.source, module)),
    built: (module: string) => readTree(path.join(state.build, module)),
    dist: (module: string) => readTree(path.join(state.dist, module)),
    /** The backups folder's names for the module. */
    backupsOf(module: string): string[] {
      if (!fs.existsSync(state.backups)) return [];
      return fs.readdirSync(state.backups).filter(n => n.startsWith(`${module}-`)).sort();
    },
    status(module: string) {
      return [...(state.rows.moduleStatus.get(module)?.values() ?? [])];
    },
    pass: () => modulePassStep({ tag0: '1:ALPHA' }),
  };
  return rig;
}
