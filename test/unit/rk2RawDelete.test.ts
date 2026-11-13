import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { writeRawAtomic } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rk2 (dataManager.ts): a raw delete's answer and ledger entry, and the base sha baseOf gives.

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setBackendKind('file');
  await dm.flushAll();
  setBackendKind(null);
  _resetRowQueue();
});

describe('a raw delete of a shared file on a Postgres bot', () => {
  it('records in the ledger that it rewrites the file whole, and baseOf then answers absent', () => {
    setBackendKind('postgres');
    const file = dataPath('global', 'rk2raw', 'shared.json');
    put(file, '{"v":1}');
    expect(dm.baseOf(file)).toBe(sha('{"v":1}'));
    const ledger = openLedger('console');
    const res = runInLedger(ledger, null, () => dm.deleteRawAtomicTracked(file));
    expect(res).toEqual({ accepted: true });
    expect(rowQueue.ops('global/rk2raw/shared.json')[0].body).toBeNull();
    expect(ledger.rewriteSeq(`file:${file}`)).toBeGreaterThan(0);
    expect(ledger.rewriteSeq('')).toBe(0);
    expect(ledger.tickets().map(t => t.ticket.kind)).toEqual(['row']);
    expect(dm.baseOf(file)).toBe('absent');
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('a raw delete of a local file', () => {
  it('refused while the file queue holds 32 MiB, with the cause storage-failing', () => {
    setBackendKind('file');
    const file = dataPath('rk2raw', 'held.json');
    put(file, '{}');
    expect(writeRawAtomic(dataPath('rk2raw', 'big.txt'), 'x'.repeat(32 * 1024 * 1024))).toBe(true);
    expect(dm.deleteRawAtomicTracked(file)).toEqual({ accepted: false, cause: 'storage-failing' });
    expect(dm.baseOf(file)).toBe(sha('{}'));
  });

  it('while the delete is queued, baseOf answers absent though the file is still on disk', async () => {
    setBackendKind('file');
    const file = dataPath('rk2raw', 'queued.json');
    put(file, '{"q":1}');
    expect(dm.baseOf(file)).toBe(sha('{"q":1}'));
    expect(dm.deleteRawAtomicTracked(file)).toEqual({ accepted: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(dm.baseOf(file)).toBe('absent');
    await dm.flushAll();
    expect(fs.existsSync(file)).toBe(false);
    expect(dm.baseOf(file)).toBe('absent');
  });

  it('a path that cannot be read as a file answers unreadable', () => {
    setBackendKind('file');
    const dir = dataPath('rk2raw', 'folder.json');
    fs.mkdirSync(dir, { recursive: true });
    expect(dm.baseOf(dir)).toBe('unreadable');
  });
});
