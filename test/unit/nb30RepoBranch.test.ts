import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');

beforeEach(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the branch of an added repository', () => {
  it('a URL naming /tree/dev with no branch given stores dev through both methods', async () => {
    const m = new AppStoreManager();
    expect(m.addRepository('A', 'https://github.com/example/a/tree/dev').branch).toBe('dev');
    expect((await m.addRepositoryAwaited('B', 'https://github.com/example/b/tree/dev')).branch).toBe('dev');
  });

  it('a URL with no /tree part and no branch stores main', async () => {
    const m = new AppStoreManager();
    expect(m.addRepository('A', 'https://github.com/example/a').branch).toBe('main');
    expect((await m.addRepositoryAwaited('B', 'https://github.com/example/b')).branch).toBe('main');
  });

  it('an explicit branch wins over the URL', async () => {
    const m = new AppStoreManager();
    expect(m.addRepository('A', 'https://github.com/example/a/tree/dev', 'release').branch).toBe('release');
    expect((await m.addRepositoryAwaited('B', 'https://github.com/example/b/tree/dev', 'release')).branch).toBe('release');
  });
});
