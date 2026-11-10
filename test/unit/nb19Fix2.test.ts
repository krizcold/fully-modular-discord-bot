import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 2 fixes: an append re-reads the flag after its close (DL-1).

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import fs from 'fs';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import {
  confirmFile,
  enqueueAppend,
  fileTicket,
  fileTicketFailure,
  fileTicketState,
  flushAll,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flagAnswer, noteFolderSyncFailure, resetFolderSyncFailureForTests, syncWords } from '../../src/bot/internalSetup/utils/folderChain';

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
const X = path.join(ROOT, 'nb19-fix2-x');
let n = 0;
let errors: string[];
let closeHook: { file: string; run: () => void } | null = null;

const guild = () => `8${Date.now() % 1_000_000}${++n}`;

beforeEach(() => {
  closeHook = null;
  resetFolderSyncFailureForTests();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const fh = await realOpen(file, flags, mode);
    const hook = closeHook;
    if (flags !== 'a+' || !hook || path.resolve(String(file)) !== hook.file) return fh;
    return new Proxy(fh, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return async () => {
            if (closeHook === hook) { closeHook = null; hook.run(); }
            return target.close();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof fs.promises.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
  resetFolderSyncFailureForTests();
});

describe('DL-1: an append reads the flag again after its close', () => {
  it.skipIf(POSIX)('on Windows the flag answer is always clear', () => {
    noteFolderSyncFailure(X, 'EIO');
    expect(flagAnswer()).toEqual({ failed: false });
  });

  it.skipIf(!POSIX)('the flag answer is earlier once set, with the first error', () => {
    expect(flagAnswer()).toEqual({ failed: false });
    noteFolderSyncFailure(X, 'EIO');
    noteFolderSyncFailure(ROOT, 'ENOSPC');
    expect(flagAnswer()).toMatchObject({ failed: true, kind: 'earlier', dir: X, errno: 'EIO' });
  });

  for (const known of [false, true]) {
    it.skipIf(!POSIX)(`${known ? 'a known durable' : 'a new'} file: the flag set during the close leaves the append unconfirmed, kind earlier`, async () => {
      const p = dataPath(guild(), 'm', 'log.jsonl');
      if (known) {
        enqueueAppend(p, '{"a":0}\n');
        expect(await confirmFile(fileTicket(p), 3000)).toBe('ok');
      }
      closeHook = { file: path.resolve(p), run: () => noteFolderSyncFailure(X, 'EIO') };
      enqueueAppend(p, '{"a":1}\n');
      const t = fileTicket(p);
      expect(await confirmFile(t, 3000)).toBe('unavailable');
      expect(closeHook).toBeNull();
      expect(fileTicketState(t)).toBe('unconfirmed');
      expect(fileTicketFailure(t)).toMatchObject({ what: 'lines', kind: 'earlier', dir: X });
      expect(fs.readFileSync(p, 'utf8')).toBe(known ? '{"a":0}\n{"a":1}\n' : '{"a":1}\n');
      const { why, next } = syncWords('earlier', X, 'EIO');
      const line = `[Data] ${p}: 1 appended line(s) are in the file and synced, but ${why}; they are not written again; can't confirm they are stored. ${next}`;
      expect(errors.filter(e => e === line)).toHaveLength(1);
    });
  }

  it.skipIf(!POSIX)('an append whose close sets nothing lands', async () => {
    const p = dataPath(guild(), 'm', 'log.jsonl');
    closeHook = { file: path.resolve(p), run: () => undefined };
    enqueueAppend(p, '{"a":1}\n');
    const t = fileTicket(p);
    expect(await confirmFile(t, 3000)).toBe('ok');
    expect(fileTicketState(t)).toBe('landed');
  });
});
