import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({
  safe: false,
  recordCrash: () => undefined,
  isInSafeMode(): boolean { return this.safe; },
  getStatus: () => ({}),
}));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { forkLogin, forks } from '../helpers/forkMock';

const JOB = { jobId: 'job-rr3-0001', to: 'postgres' as const };
const ASKED = '[BotManager] The bot process asked for a restart: ';
const NOT_DONE = '[BotManager] The restart the bot process asked for did not happen: ';

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  safety.safe = false;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function running() {
  const manager = new BotManager();
  const started = manager.start();
  await advance(600);
  expect((await started).success).toBe(true);
  const broadcast = vi.fn((_type: string, _data: unknown) => 1);
  manager.setWebSocketManager({ broadcast } as any);
  const child = forks.children[forks.children.length - 1];
  const sent = (type: string) => broadcast.mock.calls.filter(call => call[0] === type).map(call => call[1]);
  return { manager, child, sent };
}

describe('rr3 a restart the bot process asks for', () => {
  it('rr3 logs the reason it gave, and the error of a restart that did not happen', async () => {
    const { manager, child } = await running();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    child.emit('message', { type: 'control:restart-bot', data: { reason: 'The database accepted the login again' } });
    expect(lines(warnSpy)).toContain(`${ASKED}The database accepted the login again`);
    await vi.waitFor(() => expect(lines(errorSpy).filter(line => line.startsWith(NOT_DONE))).toEqual([`${NOT_DONE}A data migration is running`]), { timeout: 2000 });
    expect(forks.children).toHaveLength(1);
    expect(child.signals).toEqual([]);
  });

  it('rr3 a request with no data logs "no reason given" and is still handled', async () => {
    const { manager, child } = await running();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    expect(() => child.emit('message', { type: 'control:restart-bot' })).not.toThrow();
    expect(lines(warnSpy)).toContain(`${ASKED}no reason given`);
    await vi.waitFor(() => expect(lines(errorSpy)).toContain(`${NOT_DONE}A data migration is running`), { timeout: 2000 });
  });

  it('rr3 a request whose reason is no text logs "no reason given"', async () => {
    const { manager, child } = await running();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    child.emit('message', { type: 'control:restart-bot', data: { reason: 42 } });
    expect(lines(warnSpy)).toContain(`${ASKED}no reason given`);
    expect(lines(warnSpy).filter(line => line.startsWith(ASKED))).toEqual([`${ASKED}no reason given`]);
  });

  it('rr3 a restart that happened logs no error', async () => {
    const { manager, child } = await running();
    child.emit('message', { type: 'control:restart-bot', data: { reason: 'saved' } });
    await advance(1500);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(true);
    expect(lines(errorSpy).filter(line => line.startsWith(NOT_DONE))).toEqual([]);
  });
});

describe('rr3 the shut down button of the access-log channel', () => {
  it('rr3 control:shutdown-bot stops the bot process with SIGTERM and logs it', async () => {
    const { manager, child } = await running();
    child.emit('message', { type: 'control:shutdown-bot' });
    expect(lines(warnSpy)).toContain('[BotManager] control:shutdown-bot received from access-log action');
    await vi.waitFor(() => expect(manager.isRunning()).toBe(false), { timeout: 2000 });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(1);
  });
});

describe('rr3 the web UI listener controls', () => {
  it('rr3 control:stop-webui stops the listener only and logs it', async () => {
    const { manager, child } = await running();
    const control = { stop: vi.fn(), start: vi.fn() };
    manager.setWebUiControl(control);
    child.emit('message', { type: 'control:stop-webui' });
    expect(control.stop).toHaveBeenCalledTimes(1);
    expect(control.start).not.toHaveBeenCalled();
    expect(lines(warnSpy)).toContain('[BotManager] control:stop-webui received; stopping the web-UI listener (bot stays connected)');
    expect(manager.isRunning()).toBe(true);
  });

  it('rr3 control:start-webui starts the listener and never stops it', async () => {
    const { manager, child } = await running();
    const control = { stop: vi.fn(), start: vi.fn() };
    manager.setWebUiControl(control);
    child.emit('message', { type: 'control:start-webui' });
    expect(control.start).toHaveBeenCalledTimes(1);
    expect(control.stop).not.toHaveBeenCalled();
  });

  it('rr3 a message of an unknown type touches neither the listener nor the bot', async () => {
    const { manager, child } = await running();
    const control = { stop: vi.fn(), start: vi.fn() };
    manager.setWebUiControl(control);
    child.emit('message', { type: 'control:something-else' });
    expect(control.stop).not.toHaveBeenCalled();
    expect(control.start).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
  });
});

describe('rr3 a maintenance:mode report with no mode', () => {
  it('rr3 leaves the status the last report set and sends no status', async () => {
    const { manager, child, sent } = await running();
    child.emit('message', { type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 2 } } });
    expect(manager.getStatus()).toMatchObject({ mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 2 } });
    const before = sent('bot:status').length;
    child.emit('message', { type: 'maintenance:mode', data: { held: { unsavedGuilds: 5, unsavedFiles: 6 } } });
    expect(manager.getStatus()).toMatchObject({ mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 2 } });
    expect(sent('bot:status')).toHaveLength(before);
  });

  it('rr3 a report with no data is ignored without an error', async () => {
    const { manager, child, sent } = await running();
    const mode = manager.getStatus().mode;
    expect(() => child.emit('message', { type: 'maintenance:mode' })).not.toThrow();
    expect(manager.getStatus().mode).toBe(mode);
    expect(sent('bot:status')).toEqual([]);
  });
});
