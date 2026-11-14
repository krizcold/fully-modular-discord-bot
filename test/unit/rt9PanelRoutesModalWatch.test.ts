import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPanelRoutes } from '../../src/webui/routes/panels';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';

const OWNER_ID = '123456789012345678';
const GUILD_ID = '987654321098765432';

function botStub(reply: unknown, isRunning: () => boolean = () => true) {
  const sent: Array<{ type: string; data: any }> = [];
  const bot: any = {
    isRunning,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
  };
  return { bot, sent };
}

let app: { url: string; close: () => Promise<void> } | null = null;
let stub: ReturnType<typeof botStub>;

async function mount(reply: unknown = { success: true, data: { content: 'View' } }, isRunning?: () => boolean) {
  stub = botStub(reply, isRunning);
  app = await startApp(a => a.use('/api/panels', createPanelRoutes(stub.bot)));
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${app!.url}/api/panels${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed as any };
}

beforeEach(() => setBackendKind('file'));
afterEach(async () => {
  await app?.close();
  app = null;
  setBackendKind(null);
});

const MODAL = { panelId: 'giveaway', modalId: 'giveaway:edit/1', fields: { title: 'Prize' }, userId: OWNER_ID, guildId: GUILD_ID, channelId: '111111111111111111' };

describe('the owner modal route', () => {
  it('a valid modal submit sends the panel, the modal, its fields, the user and the channel and answers the panel', async () => {
    await mount();
    expect(await call('POST', '/modal', MODAL)).toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(stub.sent).toEqual([{
      type: 'panel:modal',
      data: { panelId: 'giveaway', modalId: 'giveaway:edit/1', fields: { title: 'Prize' }, userId: OWNER_ID, channelId: '111111111111111111', guildId: GUILD_ID },
    }]);
  });

  it.each([
    ['a panel id with a space', { ...MODAL, panelId: 'give away' }, 'Invalid panel ID format'],
    ['a modal id with a space', { ...MODAL, modalId: 'edit me' }, 'Invalid modal ID format'],
    ['no fields', { ...MODAL, fields: undefined }, 'Fields object is required'],
    ['fields given as text', { ...MODAL, fields: 'Prize' }, 'Fields object is required'],
  ])('a modal submit with %s is refused with its text and sends nothing', async (_name, body, error) => {
    await mount();
    expect(await call('POST', '/modal', body)).toEqual({ status: 400, body: { success: false, error } });
    expect(stub.sent).toEqual([]);
  });

  it('a failed modal submit that gives no reason answers the route text', async () => {
    await mount({ success: false });
    expect(await call('POST', '/modal', MODAL)).toEqual({ status: 500, body: { success: false, error: 'Failed to handle modal' } });
  });
});

describe('the roles and channels routes', () => {
  it.each([
    ['/roles', 'guild:roles', 'roles'],
    ['/channels', 'guild:channels', 'channels'],
  ])('%s answers the list the bot gave', async (path, op, field) => {
    await mount({ success: true, [field]: [{ id: '1', name: 'one' }], other: 'not sent' });
    expect(await call('GET', `${path}?guildId=${GUILD_ID}`)).toEqual({ status: 200, body: { success: true, [field]: [{ id: '1', name: 'one' }] } });
    expect(stub.sent).toEqual([{ type: op, data: { guildId: GUILD_ID } }]);
  });

  it.each(['/roles', '/channels'])('%s with a guild id that is no snowflake is refused with its text', async path => {
    await mount();
    expect(await call('GET', `${path}?guildId=abc`)).toEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' } });
    expect(stub.sent).toEqual([]);
  });

  it.each([
    ['/roles', 'Failed to get roles'],
    ['/channels', 'Failed to get channels'],
  ])('a failed %s read that gives no reason answers the route text', async (path, text) => {
    await mount({ success: false });
    expect(await call('GET', `${path}?guildId=${GUILD_ID}`)).toEqual({ status: 500, body: { success: false, error: text } });
  });

  it.each([
    ['/roles', 'Failed to get roles'],
    ['/channels', 'Failed to get channels'],
  ])('a %s read that throws answers 500 with the route text and the error', async (path, text) => {
    await mount(undefined, () => { throw new Error('the bot state is unreadable'); });
    expect(await call('GET', `${path}?guildId=${GUILD_ID}`)).toEqual({ status: 500, body: { success: false, error: `${text}: the bot state is unreadable` } });
  });

  it('a roles read that throws a value that is no Error answers Unknown error', async () => {
    await mount(undefined, () => { throw 'not an error'; });
    expect(await call('GET', `/roles?guildId=${GUILD_ID}`)).toEqual({ status: 500, body: { success: false, error: 'Failed to get roles: Unknown error' } });
  });
});

describe('the owner watch route', () => {
  const WATCH = { guildId: GUILD_ID, panelId: 'giveaway', userId: OWNER_ID, servedBy: 'BRAVO' };

  it('a valid watch on a file bot reaches the backend check and is refused there', async () => {
    await mount();
    expect(await call('POST', '/watch', WATCH)).toEqual({ status: 400, body: { success: false, error: 'Only a database bot runs panels on other machines' } });
  });

  it.each([
    ['a guild id that is no snowflake', { ...WATCH, guildId: 'abc' }, 'Invalid guild ID format'],
    ['no guild id', { ...WATCH, guildId: undefined }, 'Invalid guild ID format'],
    ['a panel id with a space', { ...WATCH, panelId: 'give away' }, 'Invalid panel ID format'],
    ['no panel id', { ...WATCH, panelId: undefined }, 'Invalid panel ID format'],
    ['a user id that is no snowflake', { ...WATCH, userId: 'abc' }, 'Invalid user ID format'],
  ])('a watch with %s is refused with its text', async (_name, body, error) => {
    await mount();
    expect(await call('POST', '/watch', body)).toEqual({ status: 400, body: { success: false, error } });
  });
});
