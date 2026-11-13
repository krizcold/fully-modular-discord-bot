import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { drainForExit, flushAll, restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

function bury(g: string, ms: number): void {
  const dir = dataPath('_graveyard', `${g}-${ms}`);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2));
}

describe('the exit drain after a JSON restore ended', () => {
  it('waits on no ended rename section: with nothing held it settles in the same number of turns as with no restore', async () => {
    setBackendKind('file');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const g = '810000000000000001';
    bury(g, 1000);
    expect(await restoreGuildFromGraveyard(g, 1000)).toMatchObject({ ok: true, retiredAt: 1000 });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    await flushAll();

    let settled = false;
    void drainForExit(2000).then(() => { settled = true; });
    let turns = 0;
    while (!settled && turns < 200) {
      await Promise.resolve();
      turns += 1;
    }
    expect(settled).toBe(true);
    expect(turns).toBe(DRAIN_TURNS);
    vi.restoreAllMocks();
  });
});

const DRAIN_TURNS = 4;
