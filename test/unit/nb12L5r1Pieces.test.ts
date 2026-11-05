import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 (wip-redesign/sheets/NB12.md): rule P answers nothing for a set that never went ready, and a sealed ledger
// keeps none of the refused documents or their reasons.

let guilds = 9_741_500_000;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('rule P on a set still hydrating', () => {
  it('a set whose hydrate broke partway answers no placement, though some stored keys were taken in', async () => {
    const guildId = String(++guilds);
    const store = new FakeStore();
    store.docs.set(`${guildId}|a/x.json`, '{}');
    store.docs.set(`${guildId}|b/y.json`, null as unknown as string);
    const ws = initWorkingSet(store);
    await expect(ws.hydrate(guildId, tokenFor())).rejects.toThrow(TypeError);
    expect(ws.stateOf(guildId)).toBe('hydrating');
    expect(ws.placementOf(guildId, 'A', 'x.json')).toBeNull();
    expect(ws.placementOf(guildId, 'B', 'y.json')).toBeNull();
  });
});

describe('a sealed ledger', () => {
  it('drops the reason of every unstorable refusal it held', () => {
    const ledger = new WriteLedger('console', null);
    ledger.noteRefusal('unstorable', 'm', 'm/a.json', 'it is over 4 MiB');
    ledger.noteRefusal('unstorable', 'm', 'm/b.json', 'it differs only in letter case from m/B.json');
    expect(ledger.refusedDocs().map(d => d.reason)).toEqual(['it is over 4 MiB', 'it differs only in letter case from m/B.json']);
    ledger.seal();
    expect(ledger.refusedDocs()).toEqual([]);
    expect((ledger as unknown as { reasons: Map<string, string> }).reasons.size).toBe(0);
  });
});
