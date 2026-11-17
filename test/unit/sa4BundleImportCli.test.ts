import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ importError: null as unknown }));

vi.mock('../../src/bot/internalSetup/utils/dataInterchange', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    bundleRefusal: () => null,
    readBundle: async function* () { yield { guildId: '860000000000000001' }; },
    importBundle: async () => { throw h.importError; },
  };
});

import { dispatch } from '../../src/cli/commands';
import { EXIT_ERR } from '../../src/cli/output';
import { FolderSyncError } from '../../src/bot/internalSetup/utils/folderChain';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

const MESSAGE = "Guild 860000000000000001 is imported, but sa4 could not sync /data (EIO), so can't confirm it is stored.";
const syncError = (replaced?: string) => {
  const error = new FolderSyncError('/data/860000000000000001', { failed: true, kind: 'sync', dir: '/data', errno: 'EIO', error: null } as never, MESSAGE);
  if (replaced) error.replaced = replaced;
  return error;
};

let out: string;
let err: string;
let tty: PropertyDescriptor | undefined;

async function runImport(flags: Record<string, string | boolean>): Promise<number | undefined | 'none'> {
  const client = { panelAnswers: async () => ({ bot: 'no', migration: 'no' }) } as never;
  try {
    await dispatch(client, ['bundle', 'import', 'sa4.dbex'], flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    return e.code;
  }
  return 'none';
}

beforeEach(() => {
  out = '';
  err = '';
  tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out += String(chunk); return true; }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err += String(chunk); return true; }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe('smdb bundle import when the folder sync after the swap fails', () => {
  it('--json: the JSON answer is a can\'t confirm failure with the replaced path, stderr says it, and the exit is EXIT_ERR', async () => {
    h.importError = syncError('/data/_graveyard/860000000000000001-1');
    const code = await runImport({ json: true });
    expect(code).toBe(EXIT_ERR);
    expect(JSON.parse(out)).toEqual({
      success: false,
      error: `bundle import can't be confirmed: ${MESSAGE}`,
      replaced: '/data/_graveyard/860000000000000001-1',
    });
    expect(err).toBe(`smdb: bundle import can't be confirmed: ${MESSAGE}\n`);
  });

  it('--json with no replaced copy: the JSON answer has no replaced field', async () => {
    h.importError = syncError();
    const code = await runImport({ json: true });
    expect(code).toBe(EXIT_ERR);
    expect(JSON.parse(out)).toEqual({ success: false, error: `bundle import can't be confirmed: ${MESSAGE}` });
    expect(err).toBe(`smdb: bundle import can't be confirmed: ${MESSAGE}\n`);
  });

  it('on a terminal without --json: only the stderr line, no JSON on stdout', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
    h.importError = syncError('/data/_graveyard/860000000000000001-2');
    const code = await runImport({});
    expect(code).toBe(EXIT_ERR);
    expect(out).toBe('');
    expect(err).toBe(`smdb: bundle import can't be confirmed: ${MESSAGE}\n`);
  });

  it('any other import error: bundle import failed, no JSON', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
    h.importError = new Error('ENOSPC: no space');
    const code = await runImport({});
    expect(code).toBe(EXIT_ERR);
    expect(out).toBe('');
    expect(err).toBe('smdb: bundle import failed: ENOSPC: no space\n');
  });
});
