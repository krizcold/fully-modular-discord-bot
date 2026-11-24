import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB45 (found live by NX3 on 2026-11-24): an App Store module uninstalled and installed again in a running bot loads
// whole. The apply rig of NB6 part 16 with production's three module trees, and the compile is the project's own tsc
// run over them with tsconfigprod.json's incremental record (./dist/.tsbuildinfo).

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { spawnSync } from 'child_process';
import { applyRig, fakeLoader, reloaderFakes } from '../helpers/nb6ApplyRig';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';

const rig = applyRig();
const fakes = { ...reloaderFakes };
const FILES = {
  'module.json': '{"name":"m","version":"1.0.0"}',
  'commands/ping.ts': 'const command = { name: "ping", description: "Replies pong" };\nexport = command;\n',
  'panels/main.ts': 'const panel = { id: "m_main", name: "Main" };\nexport = panel;\n',
};
const PROD_TSCONFIG = {
  compilerOptions: {
    target: 'ES2020', module: 'CommonJS', rootDir: './build', outDir: 'dist', strict: true, skipLibCheck: true,
    incremental: true, tsBuildInfoFile: './dist/.tsbuildinfo', types: [],
  },
  include: ['./build/**/*.ts'],
};

beforeEach(async () => {
  await rig.setup();
  fs.writeFileSync(path.join(rig.state.root, 'tsconfig.json'), JSON.stringify(PROD_TSCONFIG));
  const tsc = createRequire(__filename).resolve('typescript/bin/tsc');
  reloaderFakes.recompileTypeScript = async () => {
    fakeLoader.compileCalls += 1;
    const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: rig.state.root, encoding: 'utf8' });
    return run.status === 0
      ? { success: true, duration: 0, diagnostics: [] }
      : { success: false, error: `${run.stdout}${run.stderr}`, duration: 0, diagnostics: [] };
  };
});
afterEach(async () => {
  Object.assign(reloaderFakes, fakes);
  vi.unstubAllEnvs();
  await rig.teardown();
});

describe('a module uninstalled, then installed again with the same files', () => {
  it("nb45 reinstall: the compile writes its .js files again and the loader finds its command and its panel", async () => {
    const first = await rig.inPlace('m', FILES);
    expect(Object.keys(rig.dist('m') ?? {}).sort()).toEqual(['commands/ping.js', 'panels/main.js']);

    await rig.unpublish('m');
    await rig.pass();
    expect(rig.live('m')).toBeNull();
    expect(rig.dist('m')).toBeNull();

    const again = await rig.publish('m', FILES);
    expect(again).toBe(first);
    expect(await rig.apply('m', again)).toMatchObject({ outcome: 'applied', loaded: true });
    expect(Object.keys(rig.dist('m') ?? {}).sort()).toEqual(['commands/ping.js', 'panels/main.js']);

    vi.stubEnv('NODE_ENV', 'production');
    const loaded = await new ModuleLoader({} as never).loadModule(JSON.parse(FILES['module.json']), path.join(rig.state.dist, 'm'));
    expect(loaded.commands.map(c => c.name)).toEqual(['ping']);
    expect(loaded.panels.map(p => p.id)).toEqual(['m_main']);
  });
});

describe("what tsc's ** include compiles in a module folder", () => {
  it('nb45 tsc skips: no .js for a .ts under node_modules or a dot-named entry', async () => {
    rig.writeTree(path.join(rig.state.build, 'm'), {
      'commands/ping.ts': FILES['commands/ping.ts'], 'node_modules/dep/index.ts': 'export {};\n', '.hidden.ts': 'export {};\n', '.cache/x.ts': 'export {};\n',
    });
    expect(await reloaderFakes.recompileTypeScript()).toMatchObject({ success: true });
    expect(Object.keys(rig.dist('m') ?? {}).sort()).toEqual(['commands/ping.js']);
  });
});
