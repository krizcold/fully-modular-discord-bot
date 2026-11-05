import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  awaitGuildDataReady: async () => true,
}));

import { setBackendKind } from '../helpers/backendKind';
import { flushAll, saveDataTracked, updateData } from '../../src/bot/internalSetup/utils/dataManager';
import { ConfigWriteRefused, ROOT_CONFIG_PATH, ensureConfigPopulated, saveGlobalConfig } from '../../src/bot/internalSetup/utils/configManager';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { dataPath } from '../../src/utils/dataRoot';
import { BACKUPS, FakeChild, backupNames, call, put, resetData, startConfigApp } from '../helpers/configRig';
import { useDisk } from '../helpers/caseInsensitiveDisk';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 code review round 4 (wip-redesign/sheets/NB12.md): the write rules run before an operator route's backup, so a
// refused write writes and prunes no backup (NB12-DL-R4-1); updateData reads a folder at the key's name as no document
// (NB12-INV3-R4-2); a refused global config write says why, and the boot's config sync logs it (NB12-OPS-R4-1).

const G = '666666666666666666';
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  setBackendKind('file');
  await resetData();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const guildConfig = () => dataPath(G, '_guildConfig', 'config.json');
const saveConfig = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
const bytesOf = (names: string[]) => names.map(name => fs.readFileSync(path.join(BACKUPS(), name), 'utf8'));
const OVER = { pad: 'x'.repeat(4.5 * 1024 * 1024) };
const OVER_REASON = /^The data was not saved: it is 4\.\d+ MiB; one write holds at most 4 MiB$/;

describe('NB12-DL-R4-1: a refused operator write leaves the backups as they were', () => {
  it('11 refused saves of the guild config over a Config.json alias keep every earlier backup', async () => {
    put(guildConfig(), { v: 0 });
    for (const v of [1, 2, 3]) {
      expect((await saveConfig({ v })).status).toBe(200);
      await flushAll();
    }
    const before = backupNames();
    expect(before).toHaveLength(3);
    const kept = bytesOf(before);
    fs.renameSync(guildConfig(), dataPath(G, '_guildConfig', 'Config.json'));
    useDisk('case-insensitive', dataPath());
    for (let i = 0; i < 11; i++) {
      expect(await saveConfig({ x: i })).toEqual({
        status: 422,
        body: { success: false, error: 'The data was not saved: it differs only in letter case from _guildConfig/Config.json' },
      });
    }
    expect(backupNames()).toEqual(before);
    expect(bytesOf(before)).toEqual(kept);
    expect(fs.readFileSync(dataPath(G, '_guildConfig', 'Config.json'), 'utf8')).toBe(JSON.stringify({ v: 3 }, null, 2));
  });

  it('a /restore of a guild config backup over 4 MiB answers 422 with the reason and writes no before-restore copy', async () => {
    put(guildConfig(), { v: 0 });
    expect((await saveConfig({ v: 1 })).status).toBe(200);
    await flushAll();
    const [backup] = backupNames();
    fs.writeFileSync(path.join(BACKUPS(), backup), JSON.stringify(OVER));
    const answer = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G });
    expect(answer.status).toBe(422);
    expect(answer.body.error).toMatch(OVER_REASON);
    expect(backupNames()).toEqual([backup]);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(guildConfig(), 'utf8'))).toEqual({ v: 1 });
  });

  it('a /data/update K refusal on a postgres guild answers 422 before the backup and sends nothing to the bot', async () => {
    setBackendKind('postgres');
    child.guild = () => ({ ok: true, contentJson: '{"a":1}' });
    const answer = await call(base, 'POST', '/api/config/data/update', { file: 'cache.tmp/x.json', data: { a: 2 }, guildId: G });
    expect(answer).toEqual({
      status: 422,
      body: { success: false, error: 'The data was not saved: the part "cache.tmp" ends in ".tmp", which marks an interrupted write' },
    });
    expect(child.writes).toEqual([]);
    expect(backupNames()).toEqual([]);
  });

  it("a postgres guild's /update answers the bot's placement refusal with 422 before the backup", async () => {
    setBackendKind('postgres');
    const reason = 'it differs only in letter case from _guildConfig/Config.json';
    child.guild = () => ({ ok: true, contentJson: '{"v":1}', unstorable: reason });
    expect(await saveConfig({ v: 2 })).toEqual({ status: 422, body: { success: false, error: `The data was not saved: ${reason}` } });
    expect(child.writes).toEqual([]);
    expect(backupNames()).toEqual([]);
  });
});

describe('NB12-OPS-R4-1: a refused global config write says why', () => {
  it('a /restore of a root config backup over 4 MiB answers 422 with the reason, the root config and backups unchanged', async () => {
    const update = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config });
    expect((await update({ v: 1 })).status).toBe(200);
    await flushAll();
    expect((await update({ v: 2 })).status).toBe(200);
    await flushAll();
    const [backup] = backupNames();
    expect(backup).toBeDefined();
    fs.writeFileSync(path.join(BACKUPS(), backup), JSON.stringify(OVER));
    const answer = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup });
    expect(answer.status).toBe(422);
    expect(answer.body.error).toMatch(OVER_REASON);
    expect(backupNames()).toEqual([backup]);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'))).toEqual({ v: 2 });
  });

  it('saveGlobalConfig throws ConfigWriteRefused with the cause and reason', () => {
    let thrown: unknown;
    try {
      saveGlobalConfig('config.json', OVER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigWriteRefused);
    expect((thrown as ConfigWriteRefused).refusal.cause).toBe('unstorable');
    expect((thrown as Error).message).toMatch(/^the config was not saved: it is 4\.\d+ MiB; one write holds at most 4 MiB$/);
  });

  it("the boot's config sync logs a refused write and does not log it as synchronized", () => {
    put(ROOT_CONFIG_PATH, { DEVS: [OVER.pad] });
    const stored = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    const errors = vi.mocked(console.error);
    const logs = vi.mocked(console.log);
    ensureConfigPopulated();
    expect(errors.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('[ConfigManager]'))).toEqual([
      expect.stringMatching(/^\[ConfigManager\] config\.json was not synchronized with the schema \(it is 4\.\d+ MiB; one write holds at most 4 MiB\); it was left as it was$/),
    ]);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(stored);
    expect(logs.mock.calls.some(c => String(c[0]).includes('Config synchronized'))).toBe(false);
  });
});

describe('NB12-INV3-R4-2: updateData over a folder at the key\'s name (file route)', () => {
  const opts = { guildId: G, category: 'm' };

  it("with 'm/a/x.json' stored answers unstorable, as the save does, and runs no I/O refusal", () => {
    put(dataPath(G, 'm', 'a', 'x.json'), { k: 1 });
    const fn = vi.fn((current: any) => ({ ...current, n: 1 }));
    const updated = updateData('a', opts, {}, fn);
    expect(updated).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(updated).toEqual(saveDataTracked('a', opts, { n: 1 }));
    expect(fn).toHaveBeenCalledWith({});
    expect(fs.readFileSync(dataPath(G, 'm', 'a', 'x.json'), 'utf8')).toBe(JSON.stringify({ k: 1 }, null, 2));
  });

  it('with an empty folder m/a answers saved and lands as a file', async () => {
    fs.mkdirSync(dataPath(G, 'm', 'a'), { recursive: true });
    const updated = updateData('a', opts, { n: 0 }, (current: any) => ({ n: current.n + 1 }));
    expect(updated.outcome).toBe('saved');
    await flushAll();
    expect(fs.statSync(dataPath(G, 'm', 'a')).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'm', 'a'), 'utf8'))).toEqual({ n: 1 });
  });

  it('a folder at a global key\'s name still answers io', () => {
    fs.mkdirSync(dataPath('global', 'm', 'a'), { recursive: true });
    expect(updateData('a', { scope: 'global', category: 'm' }, {} as any, () => ({ n: 1 }))).toEqual({ outcome: 'refused', cause: 'io' });
  });
});

describe("the bot's guild read names a placement refusal (postgres)", () => {
  it('a read of a case alias of a stored key carries the reason; a read of the stored key carries none', async () => {
    setBackendKind('postgres');
    const guildId = '9400000000001';
    const store = new FakeStore();
    store.docs.set(`${guildId}|m/Settings.json`, '{"a":1}');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(await applyOperatorDataRead({ guildId, module: 'm', filename: 'settings.json' })).toEqual({
      ok: true, unstorable: 'it differs only in letter case from m/Settings.json',
    });
    expect(await applyOperatorDataRead({ guildId, module: 'm', filename: 'Settings.json' })).toEqual({ ok: true, contentJson: '{"a":1}' });
  });
});
