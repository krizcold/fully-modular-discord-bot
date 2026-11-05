import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  closeSharedWritesLost,
  deleteGuildNamespace,
  deleteRawAtomic,
  forgetSharedFileKnowledge,
  onWriterTake,
  reopenSharedWrites,
  restoreGuildFromGraveyard,
  writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataManager';

// NB10 mutation survivors (chunk 8): once another process took the data files, a raw write or delete, a guild's
// retirement and its restore are refused, logged in the operator's words, and recorded in the caller's ledger under
// the document they touched; a writer-take step that throws is logged and the rest still run.

const LOST_RESTORE = "Another process took over the bot's data files, so nothing was restored. Please try again in a moment.";
type Calls = { mock: { calls: unknown[][] } };
const errors = (): string[] => (console.error as unknown as Calls).mock.calls.map(c => c.map(String).join(' '));

beforeEach(() => {
  reopenSharedWrites();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  reopenSharedWrites();
  vi.restoreAllMocks();
});

function guildDir(id: string): string {
  const dir = dataPath(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/data.json`, '{"kept":true}');
  return dir;
}

describe('raw writes once another process took the data files', () => {
  it('a raw write is refused, logged and recorded under its file', () => {
    const abs = dataPath('global', 'nb10s8-write.json');
    closeSharedWritesLost();
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => writeRawAtomic(abs, '{}'))).toBe(false);
    expect(errors()).toContain(`[Data] Write of ${abs} refused: another process took the data files`);
    expect(ledger.refusedDocs()).toEqual([{ cause: 'writer-lost', doc: `file:${abs}`, seq: expect.any(Number), retried: false }]);
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('a raw delete is refused and recorded under its file', () => {
    const abs = dataPath('global', 'nb10s8-delete.json');
    fs.mkdirSync(dataPath('global'), { recursive: true });
    fs.writeFileSync(abs, '{"kept":1}');
    closeSharedWritesLost();
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'mod', () => deleteRawAtomic(abs))).toBe(false);
    expect(ledger.refusedDocs()).toEqual([{ cause: 'writer-lost', doc: `file:${abs}`, seq: expect.any(Number), retried: false }]);
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"kept":1}');
  });
});

describe('writer-take steps', () => {
  it('a throwing step is logged and the next still runs', () => {
    const broke = new Error('take step broke');
    let ran = false;
    onWriterTake(() => { throw broke; });
    onWriterTake(() => { ran = true; });
    forgetSharedFileKnowledge();
    expect(ran).toBe(true);
    expect((console.error as unknown as Calls).mock.calls).toContainEqual(['[Data] A writer-take step failed:', broke]);
  });
});

describe('retiring and restoring a guild in file mode', () => {
  it('a retirement while the files are lost removes nothing, says why and records the refusal', async () => {
    const dir = guildDir('810000000000000001');
    closeSharedWritesLost();
    const ledger = openLedger('panel');
    expect(await runInLedger(ledger, 'mod', () => deleteGuildNamespace('810000000000000001', 'test'))).toEqual({ ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' });
    expect(fs.readFileSync(`${dir}/data.json`, 'utf8')).toBe('{"kept":true}');
    expect(errors()).toContain('[DataManager] Cannot retire guild 810000000000000001: another process took the data files; nothing was removed');
    expect(ledger.refusedDocs()).toEqual([{ cause: 'writer-lost', doc: '810000000000000001', seq: expect.any(Number), retried: false }]);
  });

  it('a retirement, a refused restore while lost, then a restore once the files are back', async () => {
    const id = '810000000000000002';
    const dir = guildDir(id);
    expect(await deleteGuildNamespace(id, 'test')).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(false);

    closeSharedWritesLost();
    const lost = openLedger('panel');
    expect(await runInLedger(lost, 'mod', () => restoreGuildFromGraveyard(id))).toEqual({ ok: false, code: 'invalid', error: LOST_RESTORE });
    expect(fs.existsSync(dir)).toBe(false);
    expect(lost.refusedDocs()).toEqual([{ cause: 'writer-lost', doc: id, seq: expect.any(Number), retried: false }]);

    reopenSharedWrites();
    const back = openLedger('panel');
    expect(await runInLedger(back, 'mod', () => restoreGuildFromGraveyard(id))).toMatchObject({ ok: true, reason: 'test' });
    expect(fs.readFileSync(`${dir}/data.json`, 'utf8')).toBe('{"kept":true}');
    expect(back.refusedDocs()).toEqual([]);
  });

  it('a restore with no graveyard entry records no refusal', async () => {
    const ledger = openLedger('panel');
    expect(await runInLedger(ledger, 'mod', () => restoreGuildFromGraveyard('810000000000000003')))
      .toEqual({ ok: false, code: 'invalid', error: 'no graveyard entry for this guild' });
    expect(ledger.refusedDocs()).toEqual([]);
  });
});
