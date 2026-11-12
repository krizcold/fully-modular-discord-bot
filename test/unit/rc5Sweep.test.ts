import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  renameSync: null as null | ((real: (a: any, b: any) => void, a: any, b: any) => void),
  statSync: null as null | ((real: (...args: any[]) => any, ...args: any[]) => any),
}));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const renameSync = (a: any, b: any) => (h.renameSync ? h.renameSync(real.renameSync, a, b) : real.renameSync(a, b));
  const statSync = (...args: any[]) => (h.statSync ? h.statSync(real.statSync, ...args) : real.statSync(...args));
  const over = { renameSync, statSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import fs from 'fs';
import { sweepGraveyard } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

const DAY = 24 * 60 * 60 * 1000;
const TTL_BEFORE = process.env.GRAVEYARD_TTL_DAYS;

let guilds = 830_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const grave = (...parts: string[]) => dataPath('_graveyard', ...parts);
const errno = (code: string) => Object.assign(new Error(code), { code });

function folder(name: string, note?: object): void {
  fs.mkdirSync(grave(name), { recursive: true });
  fs.writeFileSync(grave(name, 'a.json'), '{"kept":1}');
  if (note) fs.writeFileSync(grave(name, '.graveyard.json'), JSON.stringify(note));
}
const kept = (name: string) => fs.existsSync(grave(name, 'a.json'));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.renameSync = null;
  h.statSync = null;
  delete process.env.GRAVEYARD_TTL_DAYS;
});
afterEach(() => {
  h.renameSync = null;
  h.statSync = null;
  if (TTL_BEFORE === undefined) delete process.env.GRAVEYARD_TTL_DAYS;
  else process.env.GRAVEYARD_TTL_DAYS = TTL_BEFORE;
  vi.restoreAllMocks();
});

describe('the sweep and restore folders (rc5)', () => {
  it('keeps a .restore- folder whose replace the boot finishes', async () => {
    const g = freshGuild();
    const n = Date.now();
    folder(`${g}-${n}`, { guildId: g, reason: 'x', ts: n });
    folder(`.restore-${g}-5-${n}`);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    await sweepGraveyard();
    expect(kept(`.restore-${g}-5-${n}`)).toBe(true);
    expect(kept(`${g}-${n}`)).toBe(true);
  });

  it('logs a drop whose rename failed as a folder, with its name', async () => {
    const g = freshGuild();
    const name = `.copy-${g}-5-7`;
    folder(name);
    h.renameSync = (real, a, b) => {
      if (path.basename(String(a)) === name) throw errno('EPERM');
      real(a, b);
    };
    await sweepGraveyard();
    expect(kept(name)).toBe(true);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(`[DataManager] Failed to sweep graveyard folder ${name} (tried again at the next sweep):`);
  });
});

describe('the sweep and folders without an entry number (rc5)', () => {
  it('ages a numeric name with no dash by its folder time, not by its name', async () => {
    folder('12345');
    await sweepGraveyard();
    expect(kept('12345')).toBe(true);
  });

  it('ages a name whose tail is not a number by its folder time', async () => {
    folder('abc-def');
    await sweepGraveyard();
    expect(kept('abc-def')).toBe(true);
  });

  it('keeps a folder whose time cannot be read', async () => {
    folder('ghi');
    h.statSync = (real, ...args) => {
      if (path.basename(String(args[0])) === 'ghi') throw errno('EACCES');
      return real(...args);
    };
    await sweepGraveyard();
    h.statSync = null;
    expect(kept('ghi')).toBe(true);
  });
});

describe('the sweep and a restore at the cutoff (rc5)', () => {
  it('keeps an old entry whose newest restore is exactly at the cutoff', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    process.env.GRAVEYARD_TTL_DAYS = '1';
    const g = freshGuild();
    folder(`${g}-1000`, { guildId: g, reason: 'x', ts: 1000, usedAt: now - DAY });
    folder(`${g}-2000`, { guildId: g, reason: 'x', ts: 2000, usedAt: now - DAY - 1 });
    await sweepGraveyard();
    expect(kept(`${g}-1000`)).toBe(true);
    expect(kept(`${g}-2000`)).toBe(false);
  });
});
