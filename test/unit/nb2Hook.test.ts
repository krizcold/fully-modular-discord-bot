import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes } from '../../src/webui/routes/managed';
import { BotManager } from '../../src/webui/botManager';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { maintenanceFilePath, readMaintenanceFile } from '../../src/utils/maintenanceFile';
import { startApp, later } from '../helpers/configRig';

// NB2 rulings 1, 2, 3 (the hook's answer) and 5 (leaving) on the web UI process, in front of a scripted bot.

const failWrite = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string) => {
      if (failWrite.on) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.atomicWriteFileSync(file, contents);
    },
  };
});

const TOKEN = 'nb2-token';
const bot = {
  running: true,
  serving: true,
  enter: vi.fn<(message: string) => Promise<object>>(),
  leave: vi.fn<() => Promise<object>>(),
  restart: vi.fn(async () => ({ success: true })),
};
const fakeBot = {
  isRunning: () => bot.running,
  isServingNormally: () => bot.running && bot.serving,
  enterMaintenance: (message: string) => bot.enter(message),
  leaveMaintenance: () => bot.leave(),
  restart: () => bot.restart(),
  requestRestart: () => bot.restart(),
} as unknown as BotManager;

let app: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes(fakeBot)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  failWrite.on = false;
  bot.running = true;
  bot.serving = true;
  bot.enter.mockReset();
  bot.enter.mockImplementation(async () => ({ saved: true }));
  bot.leave.mockReset();
  bot.leave.mockImplementation(async () => ({ restarting: true, note: 'The bot restarts once it has saved what it holds; a change the database refuses for its content is dropped at that restart.' }));
  bot.restart.mockClear();
  fs.rmSync(maintenanceFilePath(), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function hook(body: unknown, token = TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/maintenance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const fileExists = () => fs.existsSync(maintenanceFilePath());

describe('ruling 1: the hook', () => {
  it('needs the manager token', async () => {
    const res = await hook({ state: 'maintenance' }, 'wrong');
    expect(res.status).toBe(403);
    expect(fileExists()).toBe(false);
  });

  for (const [label, body, error] of [
    ['no state', { message: 'x' }, "state must be 'running' or 'maintenance'"],
    ['an unknown state', { state: 'off' }, "state must be 'running' or 'maintenance'"],
    ['a message that is not a string', { state: 'maintenance', message: 5 }, 'message must be a string'],
    ['a null message', { state: 'maintenance', message: null }, 'message must be a string'],
    ['a message over 1,800 characters', { state: 'maintenance', message: 'x'.repeat(1801) }, 'message must be at most 1800 characters'],
  ] as const) {
    it(`answers 400 for ${label} and changes nothing`, async () => {
      const res = await hook(body);
      expect(res).toEqual({ status: 400, body: { success: false, error } });
      expect(fileExists()).toBe(false);
      expect(bot.enter).not.toHaveBeenCalled();
      expect(bot.restart).not.toHaveBeenCalled();
    });
  }

  it('takes a message of exactly 1,800 characters', async () => {
    const res = await hook({ state: 'maintenance', message: 'y'.repeat(1800) });
    expect(res.status).toBe(200);
    expect(readMaintenanceFile().message).toBe('y'.repeat(1800));
  });

  it('a missing or empty message in maintenance is the default text', async () => {
    await hook({ state: 'maintenance' });
    expect(readMaintenanceFile().message).toBe(DEFAULT_MAINTENANCE_MESSAGE);
    expect(bot.enter).toHaveBeenLastCalledWith(DEFAULT_MAINTENANCE_MESSAGE);
    await hook({ state: 'maintenance', message: '' });
    expect(readMaintenanceFile().message).toBe('This bot is down for maintenance. Please try again later.');
  });
});

describe('ruling 2: the state file', () => {
  it('saves { state, message, since } before the bot process is asked', async () => {
    let fileWhenAsked: unknown = null;
    bot.enter.mockImplementation(async () => {
      fileWhenAsked = JSON.parse(fs.readFileSync(maintenanceFilePath(), 'utf-8'));
      return { saved: true };
    });
    await hook({ state: 'maintenance', message: 'Moving servers.' });
    expect(fileWhenAsked).toMatchObject({ state: 'maintenance', message: 'Moving servers.' });
    expect(typeof (fileWhenAsked as { since: unknown }).since).toBe('string');
  });

  it('a write that throws answers 500 with the cause and nothing else happens', async () => {
    failWrite.on = true;
    const entering = await hook({ state: 'maintenance', message: 'm' });
    expect(entering.status).toBe(500);
    expect(entering.body).toEqual({ success: false, error: 'The maintenance state could not be saved: ENOSPC: no space left on device' });
    const leaving = await hook({ state: 'running' });
    expect(leaving.status).toBe(500);
    await later(20, () => undefined);
    expect(bot.enter).not.toHaveBeenCalled();
    expect(bot.restart).not.toHaveBeenCalled();
    expect(fileExists()).toBe(false);
  });

  it('a missing file means running', () => {
    expect(readMaintenanceFile().state).toBe('running');
  });

  it('a damaged file reads as maintenance with the default text', () => {
    fs.writeFileSync(maintenanceFilePath(), '{ not json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(readMaintenanceFile()).toEqual({ state: 'maintenance', message: DEFAULT_MAINTENANCE_MESSAGE, since: null });
  });
});

describe('ruling 3: the hook answers what was saved', () => {
  it('saved', async () => {
    expect(await hook({ state: 'maintenance', message: 'm' })).toEqual({ status: 200, body: { success: true, state: 'maintenance', saved: true } });
  });

  it('not saved, with the counts and the text', async () => {
    bot.enter.mockImplementation(async () => ({ saved: false, unsavedGuilds: 2, unsavedFiles: 1, note: '2 guild(s) and 1 file(s) hold changes that could not be saved' }));
    const res = await hook({ state: 'maintenance', message: 'm' });
    expect(res.body).toEqual({ success: true, state: 'maintenance', saved: false, unsavedGuilds: 2, unsavedFiles: 1, note: '2 guild(s) and 1 file(s) hold changes that could not be saved' });
  });

  it("ruling A: can't confirm is saved null with the note", async () => {
    bot.enter.mockImplementation(async () => ({ saved: null, note: "can't confirm whether the held changes were saved" }));
    expect((await hook({ state: 'maintenance', message: 'm' })).body).toEqual({
      success: true, state: 'maintenance', saved: null, note: "can't confirm whether the held changes were saved",
    });
  });

  it('a second maintenance hook saves the new message and does not restart', async () => {
    await hook({ state: 'maintenance', message: 'first' });
    await hook({ state: 'maintenance', message: 'second' });
    expect(readMaintenanceFile()).toMatchObject({ state: 'maintenance', message: 'second' });
    expect(bot.enter).toHaveBeenLastCalledWith('second');
    expect(bot.restart).not.toHaveBeenCalled();
  });
});

describe('ruling 3: BotManager.enterMaintenance', () => {
  const call = (self: object, message = 'm') => (BotManager.prototype as any).enterMaintenance.call(self, message);
  const child = (reply: () => Promise<unknown>) => ({ isRunning: () => true, botProcess: {}, sendIPCMessage: vi.fn(reply) });

  it('no bot process: saved, with a note', async () => {
    expect(await call({ isRunning: () => false, botProcess: null })).toEqual({ saved: true, note: 'No bot process runs, so it holds no changes.' });
  });

  it('ruling A: asks the bot process with maintenance:enter and the message, waiting at most 20 seconds', async () => {
    const self = child(async () => ({ saved: true }));
    expect(await call(self, 'hello')).toEqual({ saved: true });
    expect(self.sendIPCMessage).toHaveBeenCalledWith('maintenance:enter', { message: 'hello' }, 20_000);
  });

  it('not saved: the counts and the text', async () => {
    expect(await call(child(async () => ({ saved: false, unsavedGuilds: 3, unsavedFiles: 0 })))).toEqual({
      saved: false, unsavedGuilds: 3, unsavedFiles: 0, note: '3 guild(s) and 0 file(s) hold changes that could not be saved',
    });
  });

  for (const [label, error] of [
    ['the request timed out', 'IPC request timed out; the operation may still complete in the background - check bot logs before retrying'],
    ['the process exited before it answered', 'bot process exited before replying'],
  ] as const) {
    it(`can't confirm when ${label}`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await call(child(async () => { throw new Error(error); }))).toEqual({ saved: null, note: "can't confirm whether the held changes were saved" });
    });
  }
});

describe('ruling B: leaving', () => {
  it('saves the file, asks the bot process to leave and answers restarting true; the hook itself restarts nothing', async () => {
    await hook({ state: 'maintenance', message: 'm' });
    let fileWhenAsked: unknown = null;
    bot.leave.mockImplementation(async () => {
      fileWhenAsked = readMaintenanceFile().state;
      return { restarting: true, note: 'The bot restarts once it has saved what it holds; a change the database refuses for its content is dropped at that restart.' };
    });
    const response = await hook({ state: 'running' });
    expect(response).toEqual({ status: 200, body: { success: true, state: 'running', restarting: true, note: 'The bot restarts once it has saved what it holds; a change the database refuses for its content is dropped at that restart.' } });
    expect(fileWhenAsked).toBe('running');
    await later(50, () => undefined);
    expect(bot.leave).toHaveBeenCalledTimes(1);
    expect(bot.restart).not.toHaveBeenCalled();
  });

  it('nothing restarts when the file already said running and the bot serves normally', async () => {
    const res = await hook({ state: 'running' });
    expect(res.body).toEqual({ success: true, state: 'running', restarting: false, note: 'The bot is already running.' });
    await later(50, () => undefined);
    expect(bot.leave).not.toHaveBeenCalled();
    expect(bot.restart).not.toHaveBeenCalled();
  });

  it('F2: a bot off Discord for an outage (not serving normally) is asked to leave, never restarted by the hook', async () => {
    bot.serving = false;
    const res = await hook({ state: 'running' });
    expect(res.body.restarting).toBe(true);
    await later(50, () => undefined);
    expect(bot.leave).toHaveBeenCalledTimes(1);
    expect(bot.restart).not.toHaveBeenCalled();
  });

  it('passes on what the bot manager answers: no bot process (false) and no answer (null)', async () => {
    bot.leave.mockImplementation(async () => ({ restarting: false, note: 'No bot process runs, so nothing restarts; the bot stays stopped until it is started.' }));
    await hook({ state: 'maintenance', message: 'm' });
    expect((await hook({ state: 'running' })).body).toEqual({
      success: true, state: 'running', restarting: false, note: 'No bot process runs, so nothing restarts; the bot stays stopped until it is started.',
    });
    bot.leave.mockImplementation(async () => ({ restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance" }));
    await hook({ state: 'maintenance', message: 'm' });
    expect((await hook({ state: 'running' })).body).toEqual({
      success: true, state: 'running', restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance",
    });
    expect(bot.restart).not.toHaveBeenCalled();
  });

  it('F10c: running with no message keeps the saved message', async () => {
    await hook({ state: 'maintenance', message: 'The owner text.' });
    await hook({ state: 'running' });
    expect(readMaintenanceFile()).toMatchObject({ state: 'running', message: 'The owner text.' });
    await hook({ state: 'running', message: '' });
    expect(readMaintenanceFile().message).toBe('The owner text.');
    await hook({ state: 'running', message: 'New text.' });
    expect(readMaintenanceFile().message).toBe('New text.');
  });
});

describe('ruling B: BotManager.leaveMaintenance', () => {
  const call = (self: object) => (BotManager.prototype as any).leaveMaintenance.call(self);
  const child = (reply: () => Promise<unknown>) => ({ isRunning: () => true, botProcess: {}, sendIPCMessage: vi.fn(reply) });

  it('no bot process: restarting false, and nothing is started', async () => {
    const self = { isRunning: () => false, botProcess: null, start: vi.fn(), restart: vi.fn() };
    expect(await call(self)).toEqual({ restarting: false, note: 'No bot process runs, so nothing restarts; the bot stays stopped until it is started.' });
    expect(self.start).not.toHaveBeenCalled();
    expect(self.restart).not.toHaveBeenCalled();
  });

  it('sends maintenance:leave, waiting at most 5 seconds; an answer is restarting true', async () => {
    const self = child(async () => ({ leaving: true }));
    expect(await call(self)).toEqual({ restarting: true, note: 'The bot restarts once it has saved what it holds; a change the database refuses for its content is dropped at that restart.' });
    expect(self.sendIPCMessage).toHaveBeenCalledWith('maintenance:leave', {}, 5_000);
  });

  it("no answer is restarting null with a can't-confirm note", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await call(child(async () => { throw new Error('IPC request timed out'); }))).toEqual({
      restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance",
    });
    expect(await call(child(async () => ({})))).toEqual({
      restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance",
    });
  });
});
