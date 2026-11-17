import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPanelRoutes } from '../../src/webui/routes/panels';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';

const OWNER_ID = '123456789012345678';
const CHANNEL = '234567890123456789';

function botStub(reply: unknown) {
  const sent: Array<{ type: string; data: any }> = [];
  const bot: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
  };
  return { bot, sent };
}

let app: { url: string; close: () => Promise<void> } | null = null;
let stub: ReturnType<typeof botStub>;

async function mount(reply: unknown = { success: true, data: { content: 'View' } }) {
  stub = botStub(reply);
  app = await startApp(a => a.use('/api/panels', createPanelRoutes(stub.bot)));
}

async function post(route: string, body: Record<string, unknown>) {
  const res = await fetch(`${app!.url}/api/panels/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const refused = (error: string) => ({ status: 400, body: { success: false, error } });

beforeEach(() => setBackendKind('file'));
afterEach(async () => {
  await app?.close();
  app = null;
  setBackendKind(null);
});

describe('an execute request: the checks of the panel, the user and the channel', () => {
  it.each([
    ['no panel id', { userId: OWNER_ID }],
    ['a panel id with a space', { panelId: 'give away', userId: OWNER_ID }],
  ])('an execute with %s is refused with the panel text and sends nothing', async (_name, body) => {
    await mount();
    expect(await post('execute', body)).toEqual(refused('Invalid panel ID format'));
    expect(stub.sent).toEqual([]);
  });

  it.each([
    ['no user id', { panelId: 'giveaway' }],
    ['a user id that is no snowflake', { panelId: 'giveaway', userId: 'abc' }],
  ])('an execute with %s is refused with the user text and sends nothing', async (_name, body) => {
    await mount();
    expect(await post('execute', body)).toEqual(refused('Invalid user ID format'));
    expect(stub.sent).toEqual([]);
  });

  it.each([
    ['letters', 'abc'],
    ['a letter before the digits', `x${CHANNEL}`],
    ['a letter after the digits', `${CHANNEL}x`],
  ])('an execute whose channel id has %s is refused with the channel text and sends nothing', async (_name, channelId) => {
    await mount();
    expect(await post('execute', { panelId: 'giveaway', userId: OWNER_ID, channelId })).toEqual(refused('Invalid channel ID format'));
    expect(stub.sent).toEqual([]);
  });

  it('an execute with a snowflake channel sends the panel, the user and the channel and answers the view', async () => {
    await mount();
    expect(await post('execute', { panelId: 'giveaway', userId: OWNER_ID, channelId: CHANNEL }))
      .toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(stub.sent).toEqual([{ type: 'panel:execute', data: { panelId: 'giveaway', userId: OWNER_ID, channelId: CHANNEL, guildId: null } }]);
  });

  it('an execute whose reply has no data answers a null panel', async () => {
    await mount({ success: true });
    expect(await post('execute', { panelId: 'giveaway', userId: OWNER_ID }))
      .toEqual({ status: 200, body: { success: true, panel: null } });
  });

  it('a failed execute that gives no reason answers the route text', async () => {
    await mount({ success: false });
    expect(await post('execute', { panelId: 'giveaway', userId: OWNER_ID }))
      .toEqual({ status: 500, body: { success: false, error: 'Failed to execute panel' } });
  });
});

describe('a button request', () => {
  it.each([
    ['no panel id', { userId: OWNER_ID }],
    ['a panel id with a space', { panelId: 'give away', userId: OWNER_ID }],
  ])('a button with %s and a bad button id is refused with the panel text first', async (_name, body) => {
    await mount();
    expect(await post('button', { ...body, buttonId: 'b b' })).toEqual(refused('Invalid panel ID format'));
    expect(stub.sent).toEqual([]);
  });

  it.each([
    ['no button id', {}],
    ['a button id with a space', { buttonId: 'b b' }],
  ])('a button with %s is refused with the button text and sends nothing', async (_name, extra) => {
    await mount();
    expect(await post('button', { panelId: 'giveaway', userId: OWNER_ID, ...extra })).toEqual(refused('Invalid button ID format'));
    expect(stub.sent).toEqual([]);
  });

  it('a button sends the panel, the button, the user and the channel and answers the view', async () => {
    await mount();
    expect(await post('button', { panelId: 'giveaway', buttonId: 'enter:1', userId: OWNER_ID, channelId: CHANNEL }))
      .toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(stub.sent).toEqual([{ type: 'panel:button', data: { panelId: 'giveaway', buttonId: 'enter:1', userId: OWNER_ID, channelId: CHANNEL, guildId: null } }]);
  });

  it('a failed button that gives no reason answers the route text', async () => {
    await mount({ success: false });
    expect(await post('button', { panelId: 'giveaway', buttonId: 'enter', userId: OWNER_ID }))
      .toEqual({ status: 500, body: { success: false, error: 'Failed to handle button' } });
  });
});

describe('a dropdown request', () => {
  it.each([
    ['no panel id', { userId: OWNER_ID }],
    ['a panel id with a space', { panelId: 'give away', userId: OWNER_ID }],
  ])('a dropdown with %s and no values is refused with the panel text first', async (_name, body) => {
    await mount();
    expect(await post('dropdown', body)).toEqual(refused('Invalid panel ID format'));
    expect(stub.sent).toEqual([]);
  });

  it('a dropdown with no values is refused with the values text', async () => {
    await mount();
    expect(await post('dropdown', { panelId: 'giveaway', userId: OWNER_ID })).toEqual(refused('Values array is required'));
    expect(stub.sent).toEqual([]);
  });

  it('a dropdown with 26 values is refused with the limits text and sends nothing', async () => {
    await mount();
    const values = Array.from({ length: 26 }, (_v, i) => `v${i}`);
    expect(await post('dropdown', { panelId: 'giveaway', userId: OWNER_ID, values }))
      .toEqual(refused('Invalid values format - max 25 items, each under 100 characters'));
    expect(stub.sent).toEqual([]);
  });

  it('a valid dropdown sends the panel, the values, the user, the dropdown and the channel and answers the view', async () => {
    await mount();
    expect(await post('dropdown', { panelId: 'giveaway', userId: OWNER_ID, values: ['a', 'b'], dropdownId: 'pick', channelId: CHANNEL }))
      .toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(stub.sent).toEqual([{
      type: 'panel:dropdown',
      data: { panelId: 'giveaway', values: ['a', 'b'], userId: OWNER_ID, dropdownId: 'pick', channelId: CHANNEL, guildId: null },
    }]);
  });

  it('a failed dropdown that gives no reason answers the route text', async () => {
    await mount({ success: false });
    expect(await post('dropdown', { panelId: 'giveaway', userId: OWNER_ID, values: ['a'] }))
      .toEqual({ status: 500, body: { success: false, error: 'Failed to handle dropdown' } });
  });
});

describe('a modal request', () => {
  it.each([
    ['no panel id', { userId: OWNER_ID }],
    ['a panel id with a space', { panelId: 'give away', userId: OWNER_ID }],
  ])('a modal with %s and no modal id is refused with the panel text first', async (_name, body) => {
    await mount();
    expect(await post('modal', body)).toEqual(refused('Invalid panel ID format'));
    expect(stub.sent).toEqual([]);
  });
});
