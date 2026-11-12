import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepGraveyard } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

const DAY_MS = 24 * 60 * 60 * 1000;
const graveyard = () => dataPath('_graveyard');

function makeDir(name: string): string {
  const dir = path.join(graveyard(), name);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":1}');
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the file graveyard sweep log', () => {
  it('removes a leftover .sweep- folder without logging it as a swept entry', async () => {
    const leftover = makeDir('.sweep-830000000000000001-1');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await sweepGraveyard();
    expect(fs.existsSync(leftover)).toBe(false);
    expect(logs.filter(line => line.includes('Swept expired graveyard entry'))).toEqual([]);
  });

  it('logs the name of an expired entry it removes', async () => {
    const name = `830000000000000002-${Date.now() - 30 * DAY_MS}`;
    const dir = makeDir(name);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await sweepGraveyard(g => g !== '830000000000000002');
    expect(fs.existsSync(dir)).toBe(false);
    expect(logs.filter(line => line.includes('Swept expired graveyard entry'))).toEqual([`[DataManager] Swept expired graveyard entry: ${name}`]);
  });
});
