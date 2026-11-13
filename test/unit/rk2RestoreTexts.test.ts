import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import type { DataBackend, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk rk2 (dataManager.ts): the restore answers an operator reads, and which retires on the wire step (e)
// of a database move settles.

const G = '880000000000000212';

describe('the restore texts', () => {
  it('a put that failed while another process took the files names the entry, the code and what to check', () => {
    const text = dm.RESTORE_TEXTS.undoTaken(4, 'EIO');
    expect(text).toContain('the copy of entry 4 could not be put in place (EIO); nothing was restored.');
    expect(text).toContain('Entry 4 stays listed. Check the server\'s data before you try again.');
  });

  it('a move back the disk did not confirm gives the command that puts the data back', () => {
    const text = dm.RESTORE_TEXTS.undoUnconfirmed(G, 9, 'EIO');
    expect(text).toContain('The disk did not confirm the move back (EIO)');
    expect(text).toContain(`graveyard entry 9 instead; it stays listed there, and smdb graveyard restore ${G} 9 --replace puts it back.`);
  });

  it('an error after the move says the outcome is unknown and where the old data is', () => {
    const text = dm.RESTORE_TEXTS.afterMove(G, 9, 'boom', 4);
    expect(text).toContain(`can't confirm whether server ${G} was restored: the restore stopped on an error in the bot (boom)`);
    expect(text).toContain('moved to graveyard entry 9; see the bot log.');
    expect(text).toContain('lists entry 9, it holds the server\'s data from before.');
  });

  it('a late commit with no known entry asks for its retiredAt by name', () => {
    const text = dm.RESTORE_TEXTS.late(G, { committed: false, old: 'the old database', why: 'it was replaced' }, undefined);
    expect(text).toContain(`smdb graveyard restore ${G} <its retiredAt> --replace`);
    expect(text).toContain('if that database lists no entry <its retiredAt>,');
    expect(text).not.toContain('undefined');
  });

  it('a late commit with its entry names the entry', () => {
    const text = dm.RESTORE_TEXTS.late(G, { committed: true, old: 'the old database', why: 'it was replaced' }, 12);
    expect(text).toContain(`smdb graveyard restore ${G} 12 --replace`);
    expect(text).not.toContain('<its retiredAt>');
  });
});

describe('retires on the wire at a database move', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dm.setGuildDataBackend(null);
    dm.setOwnerInfoProvider(() => null);
    setBackendKind(null);
  });

  it('a retire sent in the epoch given is not one to settle; in another epoch it is', async () => {
    setBackendKind('postgres');
    let answer: ((outcome: RetireOutcome) => void) | null = null;
    const retireGuild = vi.fn(() => new Promise<RetireOutcome>(resolve => { answer = resolve; }));
    dm.setGuildDataBackend({ retireGuild, databaseEpoch: () => 7 } as unknown as DataBackend);
    dm.setOwnerInfoProvider(() => ({ nodeId: 'n1', processId: 'p1', shardCount: 1, claimOf: () => 1 }));
    const reply = dm.deleteGuildNamespace(G, 'rk2 test');
    for (let i = 0; i < 100 && retireGuild.mock.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    expect(retireGuild).toHaveBeenCalledTimes(1);
    expect(dm.retiresToSettle(7)).toEqual([]);
    expect(dm.retiresToSettle(8).map(r => r.guildId)).toEqual([G]);
    answer!({ ok: true, moved: 1 } as RetireOutcome);
    expect(await reply).toEqual({ ok: true });
    expect(dm.retiresToSettle(8)).toEqual([]);
  });
});
