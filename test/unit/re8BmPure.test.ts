import fs from 'fs';
import { AsyncResource } from 'async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { childHeldOf, dropStagedFolder, inLocalOp, inStoreWrite, notAppliedText, unansweredApplyText } from '../../src/webui/botManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the held counts a maintenance:mode report keeps', () => {
  it('keeps nothing unless the mode is held', () => {
    expect(childHeldOf('saved', { unsavedGuilds: 2, unsavedFiles: 3 })).toBeNull();
    expect(childHeldOf('held', { unsavedGuilds: 2, unsavedFiles: 3 })).toStrictEqual({ unsavedGuilds: 2, unsavedFiles: 3, unansweredGuilds: 0 });
  });

  it('keeps nothing when either unsaved count is not a number', () => {
    expect(childHeldOf('held', { unsavedFiles: 3 })).toBeNull();
    expect(childHeldOf('held', { unsavedGuilds: '2', unsavedFiles: 3 })).toBeNull();
    expect(childHeldOf('held', { unsavedGuilds: 2 })).toBeNull();
    expect(childHeldOf('held', { unsavedGuilds: 2, unsavedFiles: '3' })).toBeNull();
  });

  it('keeps resaveGuilds only as a number above 0', () => {
    const base = { unsavedGuilds: 1, unsavedFiles: 1 };
    const plain = { unsavedGuilds: 1, unsavedFiles: 1, unansweredGuilds: 0 };
    expect(childHeldOf('held', base)).toStrictEqual(plain);
    expect(childHeldOf('held', { ...base, resaveGuilds: 0 })).toStrictEqual(plain);
    expect(childHeldOf('held', { ...base, resaveGuilds: -1 })).toStrictEqual(plain);
    expect(childHeldOf('held', { ...base, resaveGuilds: '4' })).toStrictEqual(plain);
    expect(childHeldOf('held', { ...base, resaveGuilds: 4 })).toStrictEqual({ ...plain, resaveGuilds: 4 });
  });

  it('keeps unansweredFiles only as a number above 0', () => {
    const base = { unsavedGuilds: 1, unsavedFiles: 1 };
    const plain = { unsavedGuilds: 1, unsavedFiles: 1, unansweredGuilds: 0 };
    expect(childHeldOf('held', { ...base, unansweredFiles: '3' })).toStrictEqual(plain);
    expect(childHeldOf('held', { ...base, unansweredFiles: 3 })).toStrictEqual({ ...plain, unansweredFiles: 3 });
  });
});

describe('the texts of a module change the bot has not applied', () => {
  it('an uninstall while the bot is in maintenance says the files go when maintenance ends', () => {
    expect(notAppliedText('uninstall', 'polls', '1.0.0', 'maintenance'))
      .toBe("polls was uninstalled. This machine's bot is in maintenance, so it removes the module's files when maintenance ends.");
    expect(notAppliedText('uninstall', 'polls', '1.0.0', 'not-running'))
      .toBe("polls was uninstalled. This machine's bot is not running, so it removes the module's files when it next starts normally.");
  });

  it('an unanswered update says the module was updated', () => {
    expect(unansweredApplyText('update', 'polls', '2.0.0', 'no-answer'))
      .toBe("polls 2.0.0 was updated, but can't confirm whether it loaded on this machine: the bot did not answer within 10 minutes. The App Store tab lists this machine if the module fails to load here.");
    expect(unansweredApplyText('update', 'polls', '2.0.0', 'stopped'))
      .toBe("polls 2.0.0 was updated, but can't confirm whether this machine applied it: the bot stopped before it answered. If it did not, it tries the version again when it next starts normally.");
  });
});

describe('dropping a staged module folder', () => {
  it('deletes the folder, and logs no error when the folder is already gone', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const staged = dataPath('re8staged', 'polls');
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(`${staged}/index.js`, 'x');
    dropStagedFolder(staged);
    expect(fs.existsSync(staged)).toBe(false);
    dropStagedFolder(staged);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('the App Store doc write frame', () => {
  it('admits an App Store doc write only while the write runs', async () => {
    setBackendKind('postgres');
    const doc = dataPath('global', 'appstore', 're8.json');
    let inside: boolean | null = null;
    let later: (() => boolean) | null = null;
    await inStoreWrite(async () => {
      inside = inLocalOp(doc);
      later = AsyncResource.bind(() => inLocalOp(doc));
    });
    expect(inside).toBe(true);
    expect(later!()).toBe(false);
  });
});
