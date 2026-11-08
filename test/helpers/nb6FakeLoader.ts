import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { CompileResult, ReloadResult, UnmarkedLoad } from '../../src/bot/internalSetup/utils/moduleReloader';
import { STOPPED_SERVING_TEXT, stoppedServing } from '../../src/bot/internalSetup/utils/servingGate';

// The fake moduleReloader of NB6 part 16's apply rows. A test file installs it with
// vi.mock('../../src/bot/internalSetup/utils/moduleReloader', ...) whose factory imports this file: it imports nothing
// that loads moduleReloader.ts, so the factory never waits on itself.

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function moduleShaOfFiles(files: Record<string, string | Buffer>): string {
  return sha256(Object.keys(files).sort().map(rel => `${rel}\0${sha256(files[rel])}\n`).join(''));
}

/**
 * The fake moduleReloader: a load fails when the module's source folder holds fail.txt (its text is the error), and
 * each compile answers the next scripted result (a clean compile when none is left).
 */
export const fakeLoader = {
  source: '',
  loads: [] as Array<{ module: string; sha: string | null }>,
  unloads: [] as string[],
  compiles: [] as CompileResult[],
  compileCalls: 0,
  unloadFails: null as string | null,
  /** Runs inside a load before it answers: a test's probe of the state an apply holds then. */
  duringLoad: null as null | ((module: string) => void | Promise<void>),
  reset(source: string) {
    this.source = source;
    this.loads = [];
    this.unloads = [];
    this.compiles = [];
    this.compileCalls = 0;
    this.unloadFails = null;
    this.duringLoad = null;
  },
};

export const reloaderFakes: {
  recompileTypeScript: (opts?: { timeoutMs?: number }) => Promise<CompileResult>;
  loadModuleUnmarked: (client: unknown, module: string) => Promise<UnmarkedLoad>;
  unloadModuleUnmarked: (client: unknown, module: string) => Promise<ReloadResult>;
} = {
  recompileTypeScript: async (): Promise<CompileResult> => {
    fakeLoader.compileCalls += 1;
    return fakeLoader.compiles.shift() ?? { success: true, duration: 0, diagnostics: [] };
  },
  loadModuleUnmarked: async (_client: unknown, module: string) => {
    const dir = path.join(fakeLoader.source, module);
    const files: Record<string, Buffer> = {};
    const walk = (at: string, rel: string) => {
      for (const e of fs.readdirSync(at, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(at, e.name), r);
        else files[r] = fs.readFileSync(path.join(at, e.name));
      }
    };
    const present = fs.existsSync(dir);
    if (present) walk(dir, '');
    fakeLoader.loads.push({ module, sha: present ? moduleShaOfFiles(files) : null });
    await fakeLoader.duringLoad?.(module);
    if (stoppedServing()) return { success: false, moduleName: module, error: STOPPED_SERVING_TEXT };
    if (!present) return { success: false, moduleName: module, error: 'Module manifest not found' };
    if (files['fail.txt'] !== undefined) return { success: false, moduleName: module, error: files['fail.txt'].toString('utf8') };
    return { success: true, moduleName: module, late: false };
  },
  unloadModuleUnmarked: async (_client: unknown, module: string) => {
    fakeLoader.unloads.push(module);
    if (fakeLoader.unloadFails) return { success: false, moduleName: module, error: fakeLoader.unloadFails };
    return { success: true, moduleName: module };
  },
};

export const ownError = (module: string, text = "Type 'string' is not assignable to type 'number'."): CompileResult => ({
  success: false,
  error: `build/bot/modules/${module}/index.ts(3,7): error TS2322: ${text}`,
  duration: 0,
  diagnostics: [{ file: `build/bot/modules/${module}/index.ts`, line: 3, code: 2322, text }],
});

export const otherError = (): CompileResult => ({
  success: false,
  error: "build/bot/modules/other/index.ts(1,1): error TS2304: Cannot find name 'x'.",
  duration: 0,
  diagnostics: [{ file: 'build/bot/modules/other/index.ts', line: 1, code: 2304, text: "Cannot find name 'x'." }],
});

export const noFile = (): CompileResult => ({ success: false, error: 'Command failed: tsc (killed)', duration: 0, diagnostics: [] });

/** What the vi.mock factory spreads: each call goes to `reloaderFakes` as it is then, so a row may swap one fake. */
export const reloaderMock = {
  recompileTypeScript: (opts?: { timeoutMs?: number }) => reloaderFakes.recompileTypeScript(opts),
  loadModuleUnmarked: (client: unknown, module: string) => reloaderFakes.loadModuleUnmarked(client, module),
  unloadModuleUnmarked: (client: unknown, module: string) => reloaderFakes.unloadModuleUnmarked(client, module),
};
