import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 30: a request the child cannot take yet (it has not reported, or waits for the data files) answers at once
// with the stage's text and sends nothing; maintenance enter and leave follow the child's stage without an IPC timeout.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, ROUTE_TEXT } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { call, put, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, logged, quiet, report, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  await resetData();
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

/** The text of an answer, whether the call resolved with an error field or rejected. */
async function textOf(run: () => Promise<any>): Promise<string> {
  try {
    const reply = await run();
    return String(reply?.error ?? reply?.message ?? JSON.stringify(reply));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const calls: Array<[string, (m: BotManager) => Promise<any>]> = [
  ['readGlobalData', m => m.readGlobalData({ root: 'config' })],
  ['readGuildData', m => m.readGuildData({ guildId: G, module: 'mod', filename: 'x.json' })],
  ['runSharedOp', m => m.runSharedOp('premium.setTier', { args: [] })],
  ['writeGuildData', m => m.writeGuildData({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent' })],
  ['executePanel', m => m.executePanel('p', 'u')],
  ['loadModule', m => m.loadModule('mod')],
  ['invokeCommand', m => m.invokeCommand({ command: 'ping' })],
  ['getPanelList', m => m.getPanelList()],
  ['getBotGuilds', m => m.getBotGuilds()],
];

describe.each([
  ['no report', [], 'The bot is starting'],
  ['waiting with a holder', [{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }], 'The bot is waiting for the web UI (pid 77)'],
  ['waiting with a cause', [{ stage: 'waiting', cause: 'EROFS' }], 'waiting for the data disk to take writes'],
])('a child with %s', (_name, stages, text) => {
  it.each(calls)('%s answers at once with the stage text and sends nothing', async (_method, run) => {
    const { manager, child } = await startedWith(stages);
    answering(child, () => ({ ok: true }));
    const started = Date.now();
    const answer = await textOf(() => run(manager));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answer).toContain(text);
    expect(answer).not.toMatch(/may still complete in the background|timed out/);
    expect(sentTo(child)).toEqual([]);
  });
});

describe('a child at shared', () => {
  it('guild-stage requests answer at once; maintenance:enter and shared:op are sent', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, m => (m.type === 'maintenance:enter' ? { saved: true } : { ok: true }));
    for (const run of [(m: BotManager) => m.executePanel('p', 'u'), (m: BotManager) => m.loadModule('mod'), (m: BotManager) => m.invokeCommand({ command: 'ping' }), (m: BotManager) => m.readGuildData({ guildId: G, module: 'mod', filename: 'x.json' })]) {
      const started = Date.now();
      expect(await textOf(() => run(manager))).toContain('The bot is starting');
      expect(Date.now() - started).toBeLessThan(1000);
    }
    expect(sentTo(child)).toEqual([]);
    await manager.enterMaintenance('m');
    await manager.runSharedOp('premium.setTier', { args: [] });
    expect(sentTo(child).map(m => m.type)).toEqual(['maintenance:enter', 'shared:op']);
  });
});

describe('the config reads', () => {
  it('GET /api/config/get and /data/get answer starting at once while the child has not reported', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const { manager, child } = await startedWith([]);
    answering(child, () => ({ ok: true }));
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      const started = Date.now();
      const global = await call(app.url, 'GET', '/api/config/get?file=config.json');
      const guild = await call(app.url, 'GET', `/api/config/data/get?file=mod/x.json&guildId=${G}`);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(global.status).toBe(503);
      expect(JSON.stringify(global.body)).toContain(ROUTE_TEXT.starting);
      expect(guild.status).toBe(503);
      expect(JSON.stringify(guild.body)).toContain(ROUTE_TEXT.starting);
      report(child, { stage: 'shared' });
      const guildAtShared = await call(app.url, 'GET', `/api/config/data/get?file=mod/x.json&guildId=${G}`);
      expect(JSON.stringify(guildAtShared.body)).toContain(ROUTE_TEXT.starting);
      expect(sentTo(child)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('maintenance enter and leave by the child stage (round 4 cases)', () => {
  it('enter waits for the shared report (3 s) and answers the child reply', async () => {
    const { manager, child } = await startedWith([]);
    answering(child, m => (m.type === 'maintenance:enter' ? { saved: true, note: 'child saved' } : undefined));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const entering = manager.enterMaintenance('m');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentTo(child)).toEqual([]);
    report(child, { stage: 'shared' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await entering).toMatchObject({ saved: true });
    expect(sentTo(child, 'maintenance:enter')).toHaveLength(1);
  });

  it('enter with a child still waiting after 20 s answers saved with the note and sends nothing', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    answering(child, () => ({ saved: true }));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const entering = manager.enterMaintenance('m');
    await vi.advanceTimersByTimeAsync(20_100);
    const answer = await entering;
    expect(answer).toEqual({ saved: true, note: 'The bot process has not opened the data files yet, so it holds no changes; it reads maintenance.json when it opens them.' });
    expect(sentTo(child)).toEqual([]);
    expect(logged(vi.mocked(console.log)).concat(logged(vi.mocked(console.error))).some(l => /did not answer|got no answer/.test(l))).toBe(false);
  });

  it('enter with a child that exits first answers the exited note', async () => {
    const { manager, child } = await startedWith([]);
    const entering = manager.enterMaintenance('m');
    exitChild(child, 0);
    expect(await entering).toEqual({ saved: true, note: expect.stringContaining('exited before it opened the data files') });
  });

  it('leave with a child short of shared answers at once with restarting false and the note', async () => {
    const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: 77 } }]);
    const started = Date.now();
    const answer = await manager.leaveMaintenance();
    expect(Date.now() - started).toBeLessThan(500);
    expect(answer).toEqual({ restarting: false, note: expect.stringContaining('reads maintenance.json') });
    expect(sentTo(child)).toEqual([]);
  });
});
