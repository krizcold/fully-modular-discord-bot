import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import type { Client } from 'discord.js';
import { applyRig, fakeLoader } from './nb6ApplyRig';
import { reloaderFakes } from './nb6FakeLoader';
import type { CompileResult } from '../../src/bot/internalSetup/utils/moduleReloader';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry, resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { _resetModuleApply, _setModuleDirs, beginBootApplies, bootCompileModules, recoverModuleApplies, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { _resetSharedMirror, bootShared, setSharedModulePassStep } from '../../src/bot/internalSetup/utils/sharedMirror';
import { modulePassStep } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetBootModules, loadModules, registerModuleComponents, runInitializers } from '../../src/bot/internalSetup/clientInitializer';
import { dataPath } from '../../src/utils/dataRoot';

// NB6 part 18's boot rig: the apply rig (a Postgres bot over scripted shared tables, production's three module trees as
// temp folders) plus the boot of clientInitializer.ts in runBot's order: the recovery, bootShared with its module step,
// the boot compile, loadModules with the real ModuleLoader and its load check, the components and the initializer
// turns. A test file mocks pathHelpers' findModuleManifests with `manifests()` and moduleReloader with nb6FakeLoader's
// fakes; the fake modules' code comes from `code`, keyed by "<name>@<version>".

export interface FakeCode {
  /** One command per entry: what its initialize returns or throws. */
  initialize?: Array<() => unknown>;
  loadThrows?: Error;
  onLoad?: () => unknown;
  onReady?: () => unknown;
}

export const manifestOf = (name: string, version: string) =>
  JSON.stringify({ name, version, displayName: name, description: 'a test module', author: 'a', category: 'misc' });
export const moduleFiles = (name: string, version: string): Record<string, string> => ({ 'module.json': manifestOf(name, version), 'index.js': `exports.v = '${version}';\n` });

export function bootRig() {
  const apply = applyRig();
  const code = new Map<string, FakeCode>();
  const client = { options: { intents: 0 }, on: () => undefined } as unknown as Client;

  /** The manifests of every module folder in the dist tree, as the loader reads it in production. */
  const manifests = (): string[] => {
    const root = apply.state.dist;
    if (!root || !fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => path.join(root, e.name, 'module.json'))
      .filter(p => fs.existsSync(p))
      .sort();
  };

  const installLoader = () => {
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (manifest: any, modulePath: string) => {
      const c = code.get(`${manifest.name}@${manifest.version}`) ?? {};
      if (c.loadThrows) throw c.loadThrows;
      const hooks: Record<string, () => unknown> = {};
      if (c.onLoad) hooks.onLoad = c.onLoad;
      if (c.onReady) hooks.onReady = c.onReady;
      return {
        manifest, path: modulePath, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
        commands: (c.initialize ?? []).map((initialize, i) => ({ name: `${manifest.name}-cmd${i}`, initialize })),
        hooks: Object.keys(hooks).length ? hooks : undefined,
      } as any;
    });
  };

  const realCompile = reloaderFakes.recompileTypeScript;
  /** Each compile's `timeoutMs`; the scripted results (a clean compile when none is left); a compile's delay in ms. */
  const compiles = { calls: [] as Array<number | undefined>, results: [] as CompileResult[], delayMs: 0, never: false };

  /** What tsc does here: every module of the build tree emitted into the dist tree (errors emit too), then the answer. */
  const emit = () => {
    const { build, dist } = apply.state;
    if (!fs.existsSync(build)) return;
    for (const e of fs.readdirSync(build, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      fs.rmSync(path.join(dist, e.name), { recursive: true, force: true });
      fs.cpSync(path.join(build, e.name), path.join(dist, e.name), { recursive: true });
    }
  };

  const rig = {
    apply,
    code,
    client,
    manifests,
    compiles,
    emit,
    async setup(): Promise<void> {
      await apply.setup();
      code.clear();
      compiles.calls = [];
      compiles.results = [];
      compiles.delayMs = 0;
      compiles.never = false;
      reloaderFakes.recompileTypeScript = async (opts?: { timeoutMs?: number }) => {
        compiles.calls.push(opts?.timeoutMs);
        if (compiles.never) return new Promise<CompileResult>(() => undefined);
        if (compiles.delayMs > 0) await new Promise(resolve => setTimeout(resolve, compiles.delayMs));
        const result = compiles.results.shift() ?? { success: true, duration: 0, diagnostics: [] };
        if (result.success || result.diagnostics.length > 0) emit();
        return result;
      };
      resetModuleRegistry();
      _resetBootModules();
      installLoader();
    },
    async teardown(): Promise<void> {
      reloaderFakes.recompileTypeScript = realCompile;
      for (const name of getModuleRegistry().getAllModules().map(m => m.manifest.name)) await getModuleRegistry().unloadModule(name);
      _resetBootModules();
      await apply.teardown();
    },
    /** A new process: the memory of the one before is gone; files, rows and the crash file stay. */
    newProcess(): void {
      _resetModuleCrashes();
      _resetModuleApply();
      _resetSharedMirror();
      setSharedModulePassStep(modulePassStep);
      _setModuleDirs({ source: apply.state.source, build: apply.state.build, dist: apply.state.dist, backups: apply.state.backups, buildFile: path.join(apply.state.root, 'dist', '.build-complete') });
      resetModuleRegistry();
      _resetBootModules();
    },
    /** runBot's boot from the recovery through the components, on a Postgres bot. */
    async boot(): Promise<void> {
      rig.newProcess();
      compiles.calls = [];
      recoverModuleApplies();
      beginBootApplies();
      const shared = await bootShared();
      if (shared !== 'done') throw new Error(`bootShared answered ${shared}`);
      await bootCompileModules();
      await loadModules(client);
      registerModuleComponents(client);
      setModuleApplyClient(client);
    },
    /** The clientReady handler's turns. */
    turns: () => runInitializers(client),
    loaded: () => getModuleRegistry().getAllModules().map(m => `${m.manifest.name}@${m.manifest.version}`).sort(),
    /** A version in place on this machine, published and applied live by the real apply (the fake live load). */
    async inPlace(name: string, version: string): Promise<string> {
      const sha = await apply.publish(name, moduleFiles(name, version), version);
      const result = await apply.apply(name, sha, { version });
      if (result.outcome !== 'applied') throw new Error(JSON.stringify(result));
      return sha;
    },
    /** A row published on another machine while this one's bot was down. */
    publish: (name: string, version: string, files?: Record<string, string>) => apply.publish(name, files ?? moduleFiles(name, version), version),
    crashLines(): Record<string, { sha: string; n: number }> {
      const file = dataPath('global', 'appstore', 'cache', 'module-crashes.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    },
    fakeLoader,
  };
  return rig;
}
