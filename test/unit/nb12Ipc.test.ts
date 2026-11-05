import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<any>()),
  awaitGuildDataReady: async () => true,
}));

import { applyOperatorDataRead, applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { getWorkingSet, initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 item 5 (wip-redesign/sheets/NB12.md, decision 16): operator writes over IPC keep today's key checks, read every
// stored key, and answer a write the bot cannot store 'invalid' with the facade's reason.

let guilds = 9_300_000_000;

async function hydrated(): Promise<{ guildId: string; store: FakeStore }> {
  setBackendKind('postgres');
  const guildId = String(++guilds);
  const store = new FakeStore();
  store.docs.set(`${guildId}|cache.tmp/x.json`, '{"a":1}');
  store.docs.set(`${guildId}|m/.graveyard.json`, '{"b":2}');
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, store };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('operator writes over IPC', () => {
  it('reads every stored key, also one a write rule refuses', async () => {
    const { guildId } = await hydrated();
    const tmp = await applyOperatorDataRead({ guildId, module: 'cache.tmp', filename: 'x.json' });
    const grave = await applyOperatorDataRead({ guildId, module: 'm', filename: '.graveyard.json' });
    expect(tmp).toMatchObject({ ok: true });
    expect(grave).toMatchObject({ ok: true });
    expect(tmp).toEqual({ ok: true, contentJson: '{"a":1}' });
    expect(grave).toEqual({ ok: true, contentJson: '{"b":2}' });
  });

  it("takes a write of m/.graveyard.json, which is not at the guild folder's root", async () => {
    const { guildId, store } = await hydrated();
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename: '.graveyard.json', op: 'write', contentJson: '{"c":3}' })).toMatchObject({ ok: true });
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.get(`${guildId}|m/.graveyard.json`)).toBe(JSON.stringify({ c: 3 }, null, 2));
  });

  it("answers a write of a .tmp folder 'invalid' with the reason", async () => {
    const { guildId, store } = await hydrated();
    expect(await applyOperatorDataWrite({ guildId, module: 'cache.tmp', filename: 'x.json', op: 'write', contentJson: '{"c":3}' })).toEqual({
      ok: false, code: 'invalid', error: 'The data was not saved: the part "cache.tmp" ends in ".tmp", which marks an interrupted write',
    });
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.get(`${guildId}|cache.tmp/x.json`)).toBe('{"a":1}');
  });

  it("answers a filename with a 201-byte part 'invalid' with the reason", async () => {
    const { guildId } = await hydrated();
    const reply = await applyOperatorDataWrite({ guildId, module: 'm', filename: `${'a'.repeat(196)}.json`, op: 'write', contentJson: '{}' });
    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect((reply as { error: string }).error).toMatch(/^The data was not saved: the part ".+" is 201 bytes; one part of a key holds at most 200$/);
  });

  it("answers a filename of 257 UTF-16 units 'invalid', so a joined key over 1024 bytes never reaches the facade", async () => {
    const { guildId, store } = await hydrated();
    const filename = `${'x'.repeat(200)}/${'y'.repeat(51)}.json`;
    expect(filename).toHaveLength(257);
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename, op: 'write', contentJson: '{}' })).toEqual({ ok: false, code: 'invalid', error: 'invalid filename' });
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect([...store.docs.keys()].filter(k => k.startsWith(`${guildId}|`)).sort()).toEqual([`${guildId}|cache.tmp/x.json`, `${guildId}|m/.graveyard.json`]);
  });

  it('takes the longest key the IPC caps allow, which is under 1024 bytes, and stores its bytes', async () => {
    const { guildId, store } = await hydrated();
    const module = '\u00E9'.repeat(100);
    const part = '\u4E00'.repeat(66);
    const filename = `${part}/${part}/${part}/${'\u4E00'.repeat(50)}.json`;
    expect(filename).toHaveLength(256);
    expect(Buffer.byteLength(`${module}/${filename}`, 'utf8')).toBe(953);
    expect(await applyOperatorDataWrite({ guildId, module, filename, op: 'write', contentJson: '{"n":1}' })).toMatchObject({ ok: true });
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.get(`${guildId}|${module}/${filename}`)).toBe(JSON.stringify({ n: 1 }, null, 2));
  });

  it('deletes a stored key a write rule refuses', async () => {
    const { guildId, store } = await hydrated();
    expect(await applyOperatorDataWrite({ guildId, module: 'cache.tmp', filename: 'x.json', op: 'delete' })).toMatchObject({ ok: true });
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.has(`${guildId}|cache.tmp/x.json`)).toBe(false);
    expect(store.docs.get(`${guildId}|m/.graveyard.json`)).toBe('{"b":2}');
    const after = await applyOperatorDataRead({ guildId, module: 'cache.tmp', filename: 'x.json' });
    expect(after).toMatchObject({ ok: true });
    expect(after).not.toHaveProperty('contentJson');
  });
});
