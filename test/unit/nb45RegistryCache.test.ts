import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';

// NB45: ModuleRegistry.unloadModule clears Node's require cache for a module whose dist folder an uninstall already
// deleted, so a reinstall's import runs the new files and not the cached exports of the version before.

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb45-cache-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the require cache at an unload', () => {
  it('nb45 unload cache: no cache entry under the folder of a module whose files are already deleted survives its unload', async () => {
    const dir = path.join(root, 'm');
    const command = path.join(dir, 'commands', 'ping.js');
    const helper = path.join(dir, 'save.js');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(helper, 'module.exports = { saved: 1 };\n');
    fs.writeFileSync(command, 'require("../save.js");\nmodule.exports = { name: "ping" };\n');
    const req = createRequire(path.join(root, 'here.js'));
    expect(req(command)).toEqual({ name: 'ping' });
    const under = () => Object.keys(req.cache).filter(key => key.startsWith(dir + path.sep));
    expect(under().sort()).toEqual([command, helper].sort());
    fs.rmSync(dir, { recursive: true, force: true });

    const registry = new ModuleRegistry();
    registry.register({
      manifest: { name: 'm', version: '1.0.0' }, path: dir, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: true, importedFiles: [command],
    } as never);
    await expect(registry.unloadModule('m')).resolves.toBe(true);
    expect(under()).toEqual([]);
  });

  it("nb45 unload other: a cache entry outside the module's folder stays", async () => {
    const dir = path.join(root, 'm');
    const other = path.join(root, 'm-other', 'index.js');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'module.exports = 2;\n');
    const req = createRequire(path.join(root, 'here.js'));
    req(other);
    const registry = new ModuleRegistry();
    registry.register({
      manifest: { name: 'm', version: '1.0.0' }, path: dir, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: true, importedFiles: [],
    } as never);
    await registry.unloadModule('m');
    expect(Object.keys(req.cache)).toContain(other);
    delete req.cache[other];
  });
});
