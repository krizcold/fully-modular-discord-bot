import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 32, and the route case of test 5: the data editor's save carries the sha it loaded, and a write built on
// a read never replaces a module write made after that read.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { applyOperatorDataRead, applyOperatorDataWrite, applyOperatorGlobalRead, CHANGED_SINCE_OPEN_TEXT, CHANGED_TEXT, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { put, readJson, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';
const file = () => dataPath(G, 'mod', 'x.json');

async function http(base: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

let close: (() => Promise<void>) | null = null;
async function mount(manager: BotManager): Promise<string> {
  const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
  close = app.close;
  return app.url;
}

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  await resetData();
});

afterEach(async () => {
  await close?.();
  close = null;
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('the data editor with no bot process', () => {
  it('GET answers the sha of the body, and a save with that sha writes', async () => {
    put(file(), { a: 1 });
    const base = await mount(new BotManager());
    const loaded = await http(base, 'GET', `/api/config/data/get?file=mod/x.json&guildId=${G}`);
    expect(loaded.body.sha).toBe(shaOfRaw(fs.readFileSync(file(), 'utf8')));
    const saved = await http(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', guildId: G, data: { a: 2 }, loadedSha: loaded.body.sha });
    expect(saved.status).toBe(200);
    expect(readJson(file())).toEqual({ a: 2 });
  });

  it('after a module write, the old sha answers 409 changed-since-open and the file keeps the module write', async () => {
    put(file(), { a: 1 });
    const base = await mount(new BotManager());
    const loaded = await http(base, 'GET', `/api/config/data/get?file=mod/x.json&guildId=${G}`);
    // The module's own write (the bot process is the only writer; here it lands as the bot's would).
    put(file(), { a: 1, module: true });
    const saved = await http(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', guildId: G, data: { a: 3 }, loadedSha: loaded.body.sha });
    expect(saved).toEqual({ status: 409, body: { success: false, error: CHANGED_SINCE_OPEN_TEXT } });
    expect(CHANGED_SINCE_OPEN_TEXT).toBe('This file changed since you opened it; nothing was saved. Reload it to see the current values.');
    await flushAll();
    expect(readJson(file())).toEqual({ a: 1, module: true });
  });

  it('a save without loadedSha answers 400 with the reload text and writes nothing', async () => {
    put(file(), { a: 1 });
    const base = await mount(new BotManager());
    const saved = await http(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', guildId: G, data: { a: 4 } });
    expect(saved).toEqual({ status: 400, body: { success: false, error: 'This page is out of date; nothing was saved. Reload the page and open the file again.' } });
    expect(readJson(file())).toEqual({ a: 1 });
  });
});

describe('with a bot process', () => {
  it('the executor refuses a data editor save when a module write lands between the route check and its turn', async () => {
    put(file(), { a: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, m => {
      if (m.type === 'data:guild-read') return applyOperatorDataRead(m.data);
      if (m.type === 'data:guild-write') {
        // The bot's module write lands between the route's check and the executor's turn.
        put(file(), { a: 1, module: 'between' });
        return applyOperatorDataWrite(m.data);
      }
      return undefined;
    });
    const base = await mount(manager);
    const loaded = await http(base, 'GET', `/api/config/data/get?file=mod/x.json&guildId=${G}`);
    const saved = await http(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', guildId: G, data: { a: 5 }, loadedSha: loaded.body.sha });
    expect(saved).toMatchObject({ status: 409, body: { success: false, error: CHANGED_SINCE_OPEN_TEXT } });
    await flushAll();
    expect(readJson(file())).toEqual({ a: 1, module: 'between' });
  });

  it('a config save answers 409 changed when a module save is queued between the route read and its write (test 5)', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, m => {
      if (m.type === 'data:global-read') {
        const reply = applyOperatorGlobalRead(m.data);
        put(ROOT_CONFIG_PATH, { a: 1, module: true });
        return reply;
      }
      if (m.type === 'shared:op') return applySharedOp(m.data);
      return undefined;
    });
    const base = await mount(manager);
    const saved = await http(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    expect(saved).toMatchObject({ status: 409, body: { success: false, error: CHANGED_TEXT } });
    await flushAll();
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 1, module: true });
  });
});
