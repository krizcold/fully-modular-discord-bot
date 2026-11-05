import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 46: what NB11's restore and delete rely on. JSON guild writes from the config routes reach the child as
// data:guild-write and the web UI queues nothing under the guild; the executor's compare and its facade write are one
// synchronous turn; a not-ready refusal answers the still-loading text; with no child the guild-wide ops answer bot-down.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const turn = vi.hoisted(() => ({ events: [] as string[], refuse: false }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    readGuildDocRaw: (...args: any[]) => {
      turn.events.push('compare');
      queueMicrotask(() => turn.events.push('next turn'));
      return real.readGuildDocRaw(...args);
    },
    saveDataTracked: (...args: any[]) => {
      turn.events.push('save');
      return turn.refuse ? { outcome: 'refused', cause: 'not-ready' } : real.saveDataTracked(...args);
    },
    deleteDataTracked: (...args: any[]) => {
      turn.events.push('delete');
      return real.deleteDataTracked(...args);
    },
  };
});

import fs from 'fs';
import { BotManager } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { applyOperatorDataRead, applyOperatorDataWrite, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  turn.events.length = 0;
  turn.refuse = false;
  await resetData();
});

afterEach(() => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('JSON guild writes while a child runs at guild', () => {
  it('reach the child as data:guild-write from each config route, and the web UI queues nothing under the guild', async () => {
    put(dataPath(G, '_guildConfig', 'config.json'), { g: 1 });
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, m => (m.type === 'data:guild-read' ? applyOperatorDataRead(m.data) : m.type === 'data:guild-write' ? { ok: true } : undefined));
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      expect((await call(app.url, 'POST', '/api/config/update', { file: 'config.json', config: { g: 2 }, guildId: G })).status).toBe(200);
      expect((await call(app.url, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { d: 2 }, guildId: G })).status).toBe(200);
      expect((await call(app.url, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: G })).status).toBe(200);
      expect((await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G })).status).toBe(200);
      expect(sentTo(child, 'data:guild-write').map(m => m.data.op)).toEqual(['write', 'write', 'delete', 'delete-namespace']);
      expect(queuedFilePaths().filter(p => p.startsWith(dataPath(G)))).toEqual([]);
      expect(readJson(dataPath(G, 'mod', 'x.json'))).toEqual({ d: 1 });
    } finally {
      await app.close();
    }
  });
});

describe('the executor in the bot process', () => {
  it('compares expectSha and calls saveDataTracked in one synchronous turn', async () => {
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"d":2}', expectSha: shaOfRaw(fs.readFileSync(dataPath(G, 'mod', 'x.json'), 'utf8')) });
    expect(reply).toMatchObject({ ok: true });
    expect(turn.events.slice(0, 3)).toEqual(['compare', 'save', 'next turn']);
  });

  it('a not-ready refusal answers the still-loading truth text', async () => {
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    turn.refuse = true;
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"d":2}', expectSha: shaOfRaw(fs.readFileSync(dataPath(G, 'mod', 'x.json'), 'utf8')) });
    expect(reply).toMatchObject({ ok: false });
    expect((reply as any).error).toContain('still loading');
    expect(readJson(dataPath(G, 'mod', 'x.json'))).toEqual({ d: 1 });
  });
});

describe('with no child', () => {
  it.each(['restore-graveyard', 'delete-namespace', 'delete'] as const)('%s answers bot-down and changes nothing', async op => {
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const reply = await new BotManager().writeGuildData({ guildId: G, module: op === 'delete' ? 'mod' : '', filename: op === 'delete' ? 'x.json' : '', op });
    expect(reply).toMatchObject({ ok: false, code: 'bot-down' });
    expect(readJson(dataPath(G, 'mod', 'x.json'))).toEqual({ d: 1 });
    expect(fs.existsSync(dataPath('.writer.lock'))).toBe(false);
  });
});
