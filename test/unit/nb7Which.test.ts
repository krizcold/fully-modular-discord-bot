import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { applyOperatorDataWrite, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { put, readJson } from '../helpers/configRig';

// NB7 decision 11: the executor's changed answer names which read went stale, the target or its global twin, so the
// sender of a request answers the twin's own text and never NB10's reload text for a twin.

const G = '123456789012345679';
const guildFile = () => dataPath(G, 'mod', 'w.json');
const globalFile = () => dataPath('global', 'mod', 'w.json');
const raw = (p: string) => fs.readFileSync(p, 'utf8');

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await flushAll();
  fs.rmSync(dataPath(G), { recursive: true, force: true });
  fs.rmSync(dataPath('global', 'mod', 'w.json'), { force: true });
});

afterEach(() => vi.restoreAllMocks());

describe('which read went stale', () => {
  it('a twin whose global file differs answers changed with which twin, and the guild file is unchanged', async () => {
    put(guildFile(), { a: 1 });
    put(globalFile(), { a: 0 });
    const twinRead = shaOfRaw(raw(globalFile()));
    put(globalFile(), { a: 9 });
    const reply = await applyOperatorDataWrite({
      guildId: G, module: 'mod', filename: 'w.json', op: 'write', contentJson: '{"a":2}',
      expectSha: shaOfRaw(raw(guildFile())), twin: { rel: 'mod/w.json', expectSha: twinRead },
    });
    expect(reply).toMatchObject({ ok: false, code: 'changed', which: 'twin' });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ a: 1 });
  });

  it('a target whose sha differs answers changed with which target, before the twin is read', async () => {
    put(guildFile(), { a: 1 });
    put(globalFile(), { a: 0 });
    const twinStale = shaOfRaw(raw(globalFile()));
    put(globalFile(), { a: 9 });
    const reply = await applyOperatorDataWrite({
      guildId: G, module: 'mod', filename: 'w.json', op: 'write', contentJson: '{"a":2}',
      expectSha: 'absent', twin: { rel: 'mod/w.json', expectSha: twinStale },
    });
    expect(reply).toMatchObject({ ok: false, code: 'changed', which: 'target' });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ a: 1 });
  });

  it('a read made since the editor opened answers changed-since-open with no which', async () => {
    put(guildFile(), { a: 1 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'w.json', op: 'write', contentJson: '{"a":2}', expectSha: 'absent', sinceOpen: true });
    expect(reply).toMatchObject({ ok: false, code: 'changed-since-open' });
    expect((reply as { which?: string }).which).toBeUndefined();
  });

  it('both current: the write lands', async () => {
    put(guildFile(), { a: 1 });
    put(globalFile(), { a: 0 });
    const reply = await applyOperatorDataWrite({
      guildId: G, module: 'mod', filename: 'w.json', op: 'write', contentJson: '{"a":2}',
      expectSha: shaOfRaw(raw(guildFile())), twin: { rel: 'mod/w.json', expectSha: shaOfRaw(raw(globalFile())) },
    });
    expect(reply).toMatchObject({ ok: true });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ a: 2 });
  });
});
