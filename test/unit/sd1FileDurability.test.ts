import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({ calls: [] as string[], syncs: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      chain.calls.push(dir);
      return real.syncFolderChain(dir);
    },
    syncFolderSync: (dir: string) => {
      chain.syncs.push(path.resolve(dir));
      return real.syncFolderSync(dir);
    },
  };
});

import {
  cancelQueued,
  enqueueAppend,
  fileTicket,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  queuedFilePaths,
  recoverGraveyardRestores,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { resetFolderSyncFailureForTests } from '../../src/bot/internalSetup/utils/folderChain';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

let n = 0;
let dir = '';
let stub: AppendStub;
const chainCalls = (p: string) => chain.calls.filter(d => d === path.dirname(p)).length;

beforeEach(() => {
  dir = path.join(DATA_ROOT, 'sd1', `${Date.now()}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  stub = stubAppendHandles();
  chain.calls.length = 0;
  chain.syncs.length = 0;
  resetFolderSyncFailureForTests();
  forgetDurableFiles();
});
afterEach(async () => {
  stub.restore();
  await cancelQueued(queuedFilePaths());
  vi.restoreAllMocks();
});

describe('an append to a file on another device', () => {
  it('syncs the folder chain again when the file has the same inode and birth time but another device', async () => {
    const p = path.join(dir, 'a.jsonl');
    stub.statAs(p, () => ({ dev: 5n, ino: 9n, birthtimeNs: 11n }));
    enqueueAppend(p, 'A\n');
    await flushAll();
    expect(chainCalls(p)).toBe(1);

    stub.statAs(p, () => ({ dev: 5n, ino: 9n, birthtimeNs: 11n }));
    enqueueAppend(p, 'B\n');
    await flushAll();
    expect(chainCalls(p)).toBe(1);

    stub.statAs(p, () => ({ dev: 6n, ino: 9n, birthtimeNs: 11n }));
    enqueueAppend(p, 'C\n');
    const t = fileTicket(p);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('A\nB\nC\n');
    expect(chainCalls(p)).toBe(2);
    expect(fileTicketState(t)).toBe('landed');
  });
});

describe("the boot's finish of a replace", () => {
  it('syncs the data folder and the graveyard folder after it moves the copy into place', () => {
    const g = `9${Date.now()}${++n}`;
    const x = 1000;
    const r = 2000;
    const graveyard = path.join(DATA_ROOT, '_graveyard');
    const copy = path.join(graveyard, `.restore-${g}-${x}-${r}`);
    const entry = path.join(graveyard, `${g}-${r}`);
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'a.json'), '{"v":1}');
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: g, reason: `replaced-by-restore-${x}`, ts: 1 }));
    chain.syncs.length = 0;

    recoverGraveyardRestores();

    expect(fs.readFileSync(path.join(DATA_ROOT, g, 'a.json'), 'utf8')).toBe('{"v":1}');
    expect(fs.existsSync(copy)).toBe(false);
    expect(chain.syncs).toContain(path.resolve(DATA_ROOT));
    expect(chain.syncs).toContain(path.resolve(graveyard));
  });
});
