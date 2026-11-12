import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../../src/utils/dataRoot';
import { queueStoreDoc, watchStoreDoc } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setBackendKind } from '../helpers/backendKind';

const STORE = dataPath('global', 'appstore');

beforeEach(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  setBackendKind('file');
});

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('rg12 a store doc delete refused without a cause on a file-backend bot', () => {
  it("rg12 the refusal names 'io', and the logged line names it too", () => {
    const file = path.join(STORE, 'credentials', 'none.json');
    const queued = queueStoreDoc(file, null, 'absent');
    expect(queued).toEqual({ file, refused: 'io' });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    watchStoreDoc(queued!);
    expect(errors).toEqual(['[AppStoreManager] credentials/none.json was not saved: io']);
  });
});
