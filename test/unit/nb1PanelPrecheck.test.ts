import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { closeGuildWrites, drainForExit } from '../../src/bot/internalSetup/utils/dataManager';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB1 round 3, R3-2: an unparsable panel registry file is moved aside only when the update that follows can be
// accepted. Its own file: closing guild writes and the exit drain both last for the process.

afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
});

const panel = { messageId: 'm-1', channelId: 'c-1', userId: '13', createdAt: 0, lastUpdated: 0, state: 'a' };

function seedUnparsable(guildId?: string): string {
  const file = path.join(DATA_ROOT, guildId ?? 'global', '_panels', 'persistent-panels.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  return file;
}

function asideFiles(file: string): string[] {
  return fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('persistent-panels.json.corrupt-'));
}

describe('the panel registry pre-check on a data layer that refuses the write', () => {
  it('leaves the file in place while guild writes are closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBackendKind('file');
    const guildId = `nb1-r32-${Date.now()}`;
    const file = seedUnparsable(guildId);
    closeGuildWrites();
    expect((await storePersistentPanel('p', { ...panel, guildId }, guildId)).success).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('not json');
    expect(asideFiles(file)).toHaveLength(0);
  });

  it('leaves the file in place once the exit drain has closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBackendKind('file');
    const file = seedUnparsable();
    for (const name of asideFiles(file)) fs.unlinkSync(path.join(path.dirname(file), name));
    await drainForExit(200);
    expect((await storePersistentPanel('p', panel)).success).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('not json');
    expect(asideFiles(file)).toHaveLength(0);
  });
});
