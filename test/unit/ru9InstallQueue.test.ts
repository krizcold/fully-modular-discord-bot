import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallQueue } from '../../src/webui/utils/installQueue';
import { getAppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setBackendKind } from '../helpers/backendKind';

const change = (module: string, version: string | null) => ({
  module, operation: 'install', version, to: 'sha', tag: null, updatedBy: 'ru9', staged: null,
});

async function install(module: string, version: string | null, answer?: Record<string, unknown>): Promise<any> {
  const manager = getAppStoreManager();
  vi.spyOn(manager, 'isModuleInstalled').mockReturnValue(false);
  vi.spyOn(manager, 'installModule').mockResolvedValue(change(module, version) as any);
  const queue = new InstallQueue();
  if (answer) queue.setBotManager({ applyModule: async () => answer } as any);
  const done = new Promise<any>(resolve => { queue.on('completed', resolve); queue.on('failed', resolve); });
  queue.enqueueInstall(module, 'repo-1');
  return done;
}

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('ru9 an install the bot child applies', () => {
  it('ru9 a change with no version and no bot names no version in its text', async () => {
    const job = await install('ru9-noversion', null);
    expect(job.status).toBe('completed');
    expect(job.loaded).toBe(false);
    expect(job.message).toBe("ru9-noversion  was installed. This machine's bot is not running, so it applies the module when it next starts normally.");
  });

  it("ru9 a 'loaded' answer reports the module loaded", async () => {
    const job = await install('ru9-loaded', '1.0.0', { outcome: 'loaded', loaded: true, error: null, text: null });
    expect(job.status).toBe('completed');
    expect(job.loaded).toBe(true);
    expect(job.loadError).toBeUndefined();
  });

  it("ru9 a 'failed' answer reports the module not loaded, with its error", async () => {
    const job = await install('ru9-failed', '1.0.0', { outcome: 'failed', loaded: true, error: 'boom', text: 'the apply failed' });
    expect(job.status).toBe('completed');
    expect(job.loaded).toBe(false);
    expect(job.loadError).toBe('boom');
    expect(job.message).toBe('the apply failed');
  });

  it("ru9 an 'applied' answer carries no load error", async () => {
    const job = await install('ru9-applied', '1.0.0', { outcome: 'applied', loaded: true, error: 'a note', text: null });
    expect(job.status).toBe('completed');
    expect(job.loaded).toBe(true);
    expect(job.loadError).toBeUndefined();
  });
});
