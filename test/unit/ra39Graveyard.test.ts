import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { listGraveyardEntries, nextGraveyardName } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT } from '../../src/utils/dataRoot';

const GRAVE = path.join(DATA_ROOT, '_graveyard');
let n = 0;
const guild = () => `939${Date.now()}${++n}`;
const folder = (name: string) => fs.mkdirSync(path.join(GRAVE, name), { recursive: true });

describe('the next graveyard name of a guild', () => {
  it('takes no number from a folder whose name holds more before the guild id', () => {
    const G = guild();
    const far = Date.now() + 10 ** 12;
    folder(`x${G}-${far}`);
    expect(nextGraveyardName(G)).toBeLessThan(far);
  });

  it('takes no number from a folder whose name holds more after the number', () => {
    const G = guild();
    const far = Date.now() + 10 ** 12;
    folder(`${G}-${far}x`);
    expect(nextGraveyardName(G)).toBeLessThan(far);
  });

  it('goes one above the number of an entry of the guild', () => {
    const G = guild();
    const far = Date.now() + 10 ** 12;
    folder(`${G}-${far}`);
    expect(nextGraveyardName(G)).toBe(far + 1);
  });
});

describe('the graveyard listing', () => {
  it('lists only folders named by a numeric guild id and a number', async () => {
    const G = guild();
    folder(`${G}-100`);
    folder(`a${G}-101`);
    folder(`${G}a-102`);
    folder(`ab-103`);
    folder(`${G}-abc`);
    const listed = (await listGraveyardEntries()).filter(e => e.guildId.includes(G) || e.guildId === 'ab');
    expect(listed).toEqual([{ guildId: G, retiredAt: 100, reason: '' }]);
  });
});
