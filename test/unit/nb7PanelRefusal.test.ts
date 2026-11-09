import { afterEach, describe, expect, it, vi } from 'vitest';

// NB15 decision 6 and gatekeeper ruling 5 (in place of NB7 decision 19's lookup): once the process's lease is set, a
// panel action or a console invoke of a guild whose shard is not in it answers not-held at once, from the lease alone,
// so the web UI sends it to the machine that runs the server. No database lookup runs.
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client, getPanel: () => undefined, executePanelForWebUI: vi.fn(async () => ({ success: true })) }) };
});

import { gateCauseText } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { answerInvokeMessage } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { answerPanelMessage, NOT_HELD, _resetPanelHandler } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { readSourceText } from '../helpers/sourceText';
import { setBackendKind } from '../helpers/backendKind';
import { fakeClock, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

afterEach(() => {
  _resetPanelHandler();
  stopDrivers();
  vi.useRealTimers();
});

describe('a panel action of a server another machine runs', () => {
  it('answers not-held in one turn, with no lookup', async () => {
    fakeClock();
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.settled()).toBe(true);
    expect(seen.value()).toEqual(NOT_HELD);
  });

  it('before the lease is set, holds as today', async () => {
    fakeClock();
    const r = readinessRig(null);
    const guildId = r.guild();
    const seen = watch(answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.value()).toEqual({ success: false, ran: false, error: gateCauseText('not-served') });
  });

  it('a JSON bot is unchanged: it never answers not-held', async () => {
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    setBackendKind('file');
    const answer = await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'u', guildId }, 'ipc');
    expect(answer).not.toEqual(NOT_HELD);
  });

  it('the lookup NB7 decision 19 added is gone from the bot process', () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/fleet/guildRequests.ts');
    expect(src).not.toMatch(/notServedHereText|_setLookupDb|LOOKUP_BOUND_MS/);
  });
});

describe('a console invoke of a server another machine runs', () => {
  it.each([[false], [true]])('force %s: not-held before the cache check, the command not run', async force => {
    fakeClock();
    const ran = vi.fn();
    local.commands = [{ name: 'probe', callback: ran }];
    const r = readinessRig(NOT_LEASED);
    const guildId = r.guild();
    const seen = watch(answerInvokeMessage({ command: 'probe', guildId, force }, 'ipc'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.value()).toEqual(NOT_HELD);
    expect(ran).not.toHaveBeenCalled();
  });
});
