import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  manager: {
    isModuleInstalled: (_name: string) => false,
    installModule: async (_name: string, _repo: string): Promise<unknown> => true,
  },
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => ({
  ...(await orig<any>()),
  getAppStoreManager: () => h.manager,
}));

import { InstallQueue } from '../../src/webui/utils/installQueue';
import { setBackendKind } from '../helpers/backendKind';

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('sa16 an install the App Store manager stores', () => {
  it('sa16 loads the module and ends completed with no error', async () => {
    setBackendKind('file');
    const loadModule = vi.fn(async () => ({ success: true }));
    const queue = new InstallQueue();
    queue.setBotManager({ loadModule } as any);
    const ended = new Promise<any>(resolve => {
      queue.on('completed', job => resolve(job));
      queue.on('failed', job => resolve(job));
    });
    queue.enqueueInstall('alpha', 'official-modules');
    const job = await ended;
    expect(loadModule).toHaveBeenCalledWith('alpha');
    expect(job).toMatchObject({ kind: 'install', moduleName: 'alpha', status: 'completed', loaded: true });
    expect(job.error).toBeUndefined();
  });
});
