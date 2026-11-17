import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstallQueue } from '../../src/webui/utils/installQueue';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('rt11 an uninstall whose module has no component toggles', () => {
  it("rt11 leaves the operator's component-config.json bytes as they were", async () => {
    setBackendKind('file');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const name = 'rt11-no-toggles';
    const dir = dataPath('global', 'appstore');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/installed.json`, JSON.stringify({ modules: { [name]: { name, version: '1.0.0', repoId: 'r1' } } }));
    const bytes = JSON.stringify({ 'other:command:b': false, [`${name}x:command:a`]: true });
    fs.writeFileSync(`${dir}/component-config.json`, bytes);
    const queue = new InstallQueue();
    const done = new Promise<any>(resolve => { queue.on('completed', resolve); queue.on('failed', resolve); });
    queue.enqueueUninstall(name);
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.skipped).toBeUndefined();
    expect(fs.readFileSync(`${dir}/component-config.json`, 'utf-8')).toBe(bytes);
  });
});
