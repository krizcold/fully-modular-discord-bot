import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ existsThrow: null as string | null }));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const existsSync = (p: any) => {
    if (h.existsThrow && String(p).includes(h.existsThrow)) throw new Error('lookup failed');
    return real.existsSync(p);
  };
  return { ...real, default: { ...real, existsSync }, existsSync };
});

import fs from 'fs';
import { enqueueWrite } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { deleteGuildNamespace, flushAll, restoreGuildFromGraveyard, saveData, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB11 (wip-redesign/sheets/NB11.md) on JSON: the log lines of a delete refused for a write not saved, and of a restore
// that stopped on an error.

let guilds = 830_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const opts = (guildId: string) => ({ guildId, category: 'm' });
const errno = (code: string) => Object.assign(new Error(code), { code });
let error: ReturnType<typeof vi.spyOn>;
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.map(String).join(' '));

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  h.existsThrow = null;
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  await flushAll();
  setBackendKind(null);
});

describe('a JSON delete refused for a write not saved', () => {
  it('a file whose flush keeps failing is named in the log with its code', async () => {
    const g = freshGuild();
    saveData('seed.json', opts(g), { s: 1 });
    await flushAll();
    const target = dataPath(g, 'm', 'a.json');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(`${target}.`)) throw errno('ENOSPC');
      return (open as any)(p, ...rest);
    }) as any);
    saveDataTracked('a.json', opts(g), { a: 1 });
    const reply = await deleteGuildNamespace(g, 'test', 5000);
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable' });
    expect(lines(error)).toContain(`[DataManager] Cannot retire guild ${g}: m/a.json keeps failing to save (ENOSPC); nothing was removed`);
    vi.restoreAllMocks();
    await flushAll();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1 });
  }, 20_000);

  it('an op queued with no recorded failure logs that a write is not saved yet', async () => {
    const g = freshGuild();
    saveData('a.json', opts(g), { a: 1 });
    await flushAll();
    const deleting = deleteGuildNamespace(g, 'test', 5000);
    enqueueWrite(dataPath(g, 'm', 'late.json'), '{}');
    expect(await deleting).toEqual({ ok: false, code: 'backend-unavailable', error: "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment" });
    expect(lines(error)).toContain(`[DataManager] Cannot retire guild ${g}: a write of it is not saved yet; nothing was removed`);
    expect(fs.existsSync(dataPath(g, 'm', 'a.json'))).toBe(true);
  });
});

describe('a JSON restore that stopped on an error', () => {
  it('logs the error with the guild', async () => {
    const g = freshGuild();
    const entry = dataPath('_graveyard', `${g}-1000`);
    fs.mkdirSync(path.join(entry, 'm'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'm', 'a.json'), '{"n":5}');
    h.existsThrow = `${g}-1000`;
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (lookup failed); nothing was restored; see the bot log' });
    const call = error.mock.calls.find((c: unknown[]) => c[1] instanceof Error && (c[1] as Error).message === 'lookup failed');
    expect(call?.[0]).toBe(`[Data] The restore of guild ${g} stopped on an error:`);
  });
});
