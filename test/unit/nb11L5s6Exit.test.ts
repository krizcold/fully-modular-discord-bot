import fs from 'fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  deleteGuildNamespace,
  drainForExit,
  isClosedForExit,
  restoreGuildFromGraveyard,
  setGuildDataBackend,
} from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB11 (wip-redesign/sheets/NB11.md): a restore or a delete asked once the exit drain has closed the data layer.
// The drain closes it for the rest of this file's process.

let guilds = 820_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
type Thrown = { causeKey: string; message: string };
const thrownBy = (p: Promise<unknown>) => p.then(() => null, (e: Thrown) => e);

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await drainForExit(1000);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('after the exit drain closed the data layer', () => {
  it('a restore on Postgres throws node-stopping with the restore text, before looking for a backend', async () => {
    expect(isClosedForExit()).toBe(true);
    setBackendKind('postgres');
    setGuildDataBackend(null);
    const thrown = await thrownBy(restoreGuildFromGraveyard(freshGuild(), 5));
    expect(thrown?.causeKey).toBe('node-stopping');
    expect(thrown?.message).toBe('[Data] This process is stopping; nothing was restored');
  });

  it('a delete on JSON throws node-stopping with the delete text and keeps the folder', async () => {
    setBackendKind('file');
    const g = freshGuild();
    fs.mkdirSync(dataPath(g, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"a":1}');
    const thrown = await thrownBy(deleteGuildNamespace(g, 'test', 1000));
    expect(thrown?.causeKey).toBe('node-stopping');
    expect(thrown?.message).toBe('[Data] This process is stopping; nothing was removed');
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
  });
});
