import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPanelRoutes } from '../../src/webui/routes/panels';
import { watcherFor } from '../../src/webui/routes/panelRequestRoute';
import { _resetPanelLiveWatch } from '../../src/webui/utils/panelLiveWatch';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';

const GUILD = '223456789012345678';
const USER = '123456789012345678';
const DEFAULT_NAME = 'the machine that runs it';

function botStub() {
  const bot: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async () => ({ success: true }),
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
  };
  return bot;
}

describe('POST /api/panels/watch: the checks, the served-by name, the answer', () => {
  let app: { url: string; close: () => Promise<void> } | null = null;
  let calls: unknown[][];
  let throwText: string | null;

  beforeEach(async () => {
    setBackendKind('postgres');
    calls = [];
    throwText = null;
    const bot = botStub();
    const watcher = watcherFor(bot);
    vi.spyOn(watcher, 'watch').mockImplementation((...args: unknown[]) => {
      calls.push(args);
      if (throwText !== null) throw new Error(throwText);
      return { live: true, reason: null } as any;
    });
    app = await startApp(a => a.use('/api/panels', createPanelRoutes(bot)));
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    _resetPanelLiveWatch();
    setBackendKind(null);
    vi.restoreAllMocks();
  });

  async function watch(body: Record<string, unknown>) {
    const res = await fetch(`${app!.url}/api/panels/watch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    return { status: res.status, body: await res.json() };
  }

  it('a watch with no userId and no servedBy registers the owner with the default name and answers the status', async () => {
    expect(await watch({ guildId: GUILD, panelId: 'giveaway' })).toEqual({ status: 200, body: { success: true, live: true, reason: null } });
    expect(calls).toEqual([[GUILD, 'giveaway', 'web-ui-owner', DEFAULT_NAME]]);
  });

  it('a watch with a snowflake userId and a servedBy registers that user under that name', async () => {
    expect(await watch({ guildId: GUILD, panelId: 'giveaway', userId: USER, servedBy: 'ALPHA' })).toEqual({ status: 200, body: { success: true, live: true, reason: null } });
    expect(calls).toEqual([[GUILD, 'giveaway', USER, 'ALPHA']]);
  });

  it('a panel id that is no id is refused with its text and watches nothing', async () => {
    expect(await watch({ guildId: GUILD, panelId: 'bad id!' })).toEqual({ status: 400, body: { success: false, error: 'Invalid panel ID format' } });
    expect(calls).toEqual([]);
  });

  it('a user id that is no snowflake is refused with its text and watches nothing', async () => {
    expect(await watch({ guildId: GUILD, panelId: 'giveaway', userId: 'abc' })).toEqual({ status: 400, body: { success: false, error: 'Invalid user ID format' } });
    expect(calls).toEqual([]);
  });

  it('a file bot refuses the watch with its text and watches nothing', async () => {
    setBackendKind('file');
    expect(await watch({ guildId: GUILD, panelId: 'giveaway' })).toEqual({ status: 400, body: { success: false, error: 'Only a database bot runs panels on other machines' } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['an empty text', ''],
    ['a list with a length', ['ALPHA']],
    ['a number', 5],
    ['a text of 201 characters', 'A'.repeat(201)],
  ])('a servedBy that is %s is replaced by the default name', async (_name, servedBy) => {
    expect((await watch({ guildId: GUILD, panelId: 'giveaway', servedBy })).status).toBe(200);
    expect(calls).toEqual([[GUILD, 'giveaway', 'web-ui-owner', DEFAULT_NAME]]);
  });

  it('a servedBy of exactly 200 characters is kept', async () => {
    const name = 'B'.repeat(200);
    expect((await watch({ guildId: GUILD, panelId: 'giveaway', servedBy: name })).status).toBe(200);
    expect(calls).toEqual([[GUILD, 'giveaway', 'web-ui-owner', name]]);
  });

  it('a servedBy of one character is kept', async () => {
    expect((await watch({ guildId: GUILD, panelId: 'giveaway', servedBy: 'C' })).status).toBe(200);
    expect(calls).toEqual([[GUILD, 'giveaway', 'web-ui-owner', 'C']]);
  });

  it('a watch that throws answers 500 with the route text and the error', async () => {
    throwText = 'the watcher broke';
    expect(await watch({ guildId: GUILD, panelId: 'giveaway' })).toEqual({ status: 500, body: { success: false, error: 'Failed to watch the panel: the watcher broke' } });
  });
});
