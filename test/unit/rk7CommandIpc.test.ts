import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  commands: [] as unknown[],
  client: null as any,
  gate: { runnable: true } as { runnable: boolean; reason?: string; error?: string },
  tracked: null as null | (() => unknown),
}));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => h.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getClient: () => h.client }) };
});
vi.mock('../../src/bot/internalSetup/utils/commandGate', () => ({ isCommandRunnable: () => h.gate }));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/maintenanceGate')>();
  return { ...real, runTracked: (fn: () => unknown) => (h.tracked ? h.tracked() : real.runTracked(fn as never)) };
});

import { answerInvokeMessage, findLocalCommand, handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';

function readyClient() {
  return { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.commands = [[{ name: 'alpha' }], { name: 'beta' }];
  h.client = readyClient();
  h.gate = { runnable: true };
  h.tracked = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finding a local command by name', () => {
  it('returns the command with that name, not the first one listed', () => {
    expect(findLocalCommand('beta')).toEqual({ name: 'beta' });
    expect(findLocalCommand('alpha')).toEqual({ name: 'alpha' });
  });

  it('returns nothing for a name no command has', () => {
    expect(findLocalCommand('gamma')).toBeUndefined();
  });

  it('answers no such command for an unknown name', async () => {
    expect(await handleInvoke({ command: 'gamma' })).toEqual({ success: false, ran: false, error: 'no such command: gamma' });
  });
});

describe('the invoke refusals before the command runs', () => {
  it('an empty command answers that a command is required', async () => {
    expect(await handleInvoke({ command: '  ' })).toEqual({ success: false, ran: false, error: 'command is required' });
  });

  it('a client that is not ready answers so', async () => {
    h.client = { ...readyClient(), isReady: () => false };
    expect(await handleInvoke({ command: 'beta' })).toEqual({ success: false, ran: false, error: 'bot client not ready' });
    h.client = null;
    expect(await handleInvoke({ command: 'beta' })).toEqual({ success: false, ran: false, error: 'bot client not ready' });
  });

  it('a command switched off in Components did not run', async () => {
    h.gate = { runnable: false, reason: 'disabled' };
    expect(await handleInvoke({ command: 'beta' })).toEqual({ success: false, ran: false, error: 'beta is disabled in Components' });
  });

  it('an unreadable component-config answers can\'t confirm, and the command did not run', async () => {
    h.gate = { runnable: false, reason: 'unknown', error: 'EACCES: permission denied' };
    expect(await handleInvoke({ command: 'beta' })).toEqual({
      success: false,
      ran: false,
      error: "can't confirm whether beta is enabled: component-config.json cannot be read (EACCES: permission denied)",
    });
  });

  it('a guild this bot does not serve is refused unless forced', async () => {
    expect(await handleInvoke({ command: 'beta', guildId: '424242' })).toEqual({
      success: false,
      ran: false,
      error: 'this bot does not serve guild 424242 (not in cache); pass force to attempt anyway',
    });
  });
});

describe('the invoke message', () => {
  it('a message with no data answers that a command is required', async () => {
    await expect(answerInvokeMessage(undefined as never, 'ipc')).resolves.toEqual({ success: false, ran: false, error: 'command is required' });
  });

  it('an invoke that threw answers not successful with the error', async () => {
    h.tracked = () => {
      throw new Error('tracker broke');
    };
    expect(await answerInvokeMessage({ command: 'beta' }, 'ipc')).toEqual({ success: false, error: 'tracker broke' });
  });

  it('an invoke that threw a non-error answers Unknown error', async () => {
    h.tracked = () => {
      throw 'not an error';
    };
    expect(await answerInvokeMessage({ command: 'beta' }, 'ipc')).toEqual({ success: false, error: 'Unknown error' });
  });
});
