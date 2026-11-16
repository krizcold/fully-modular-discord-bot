import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ importError: null as unknown }));

vi.mock('../../src/cli/client', async orig => {
  const real = await orig<any>();
  class Client { async panelAnswers() { return { bot: 'no', migration: 'no' }; } }
  return { ...real, Client, resolveTarget: () => ({}) };
});
vi.mock('../../src/bot/internalSetup/utils/dataInterchange', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    bundleRefusal: () => null,
    readBundle: async function* () { yield { guildId: '860000000000000002' }; },
    importBundle: async () => { throw h.importError; },
  };
});

import { FolderSyncError } from '../../src/bot/internalSetup/utils/folderChain';

const MESSAGE = "Guild 860000000000000002 is imported, but sa4 could not sync /data (EIO), so can't confirm it is stored. The previous copy is at /data/_graveyard/x.";

let argv: string[];
beforeEach(() => {
  argv = process.argv;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe('tools/dataBundle import when the folder sync after the swap fails', () => {
  it('prints one can\'t confirm line with the error text and exits 1, with no Imported line', async () => {
    const exits: Array<number | undefined> = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as never);
    h.importError = new FolderSyncError('/data/860000000000000002', { failed: true, kind: 'sync', dir: '/data', errno: 'EIO', error: null } as never, MESSAGE);
    process.argv = [argv[0], 'dataBundle', 'import', 'sa4.dbex'];
    await import('../../src/tools/dataBundle');
    await vi.waitFor(() => expect(vi.mocked(console.error)).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
    await new Promise(resolve => setImmediate(resolve));
    expect(vi.mocked(console.error).mock.calls).toEqual([[`bundle import can't be confirmed: ${MESSAGE}`]]);
    expect(exits).toEqual([1]);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });
});
