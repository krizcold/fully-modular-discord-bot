import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _resetOwnerChannel, _setOwnerChannelDeps, ownerMessagesFile } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice } from '../../src/webui/utils/webuiDataReader';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

const TOKEN = 'rt7-token';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 750 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  _setOwnerChannelDeps({ readRow: async () => null, readMs: 150, readKey: async () => null, recordKey: async () => ({ kind: 'ok' }) });
  setBackendKind('file');
  fs.rmSync(ownerMessagesFile(), { force: true });
  fs.rmSync(dataPath('owner-channel.json'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setOwnerChannelDeps(null);
  vi.restoreAllMocks();
});

async function notify(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/notify-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const TEXT_RULE = { status: 400, body: { success: false, error: 'text must be a string of 1 to 2000 characters' } };
const KEY_RULE = { status: 400, body: { success: false, error: 'key must be a string of 1 to 200 characters' } };
const postedInDm = { status: 200, body: { success: true, posted: true, place: 'dm' } };

describe('rt7: notify-owner text and key bounds', () => {
  it('a text of one character posts', async () => {
    expect(await notify({ text: 'x', key: 'rt7-one-char-text' })).toEqual(postedInDm);
    expect(rest.creates(DM)[0].options.body.content).toBe('x');
  });

  it('a text of 2000 characters posts', async () => {
    const text = 't'.repeat(2000);
    expect(await notify({ text, key: 'rt7-long-text' })).toEqual(postedInDm);
    expect(rest.creates(DM)[0].options.body.content).toBe(text);
  });

  it('a text of 2001 characters answers 400 with the rule and posts nothing', async () => {
    expect(await notify({ text: 't'.repeat(2001), key: 'rt7-too-long' })).toEqual(TEXT_RULE);
    expect(rest.calls).toHaveLength(0);
  });

  it('an empty key answers 400 with the rule and posts nothing', async () => {
    expect(await notify({ text: 'hello', key: '' })).toEqual(KEY_RULE);
    expect(rest.calls).toHaveLength(0);
    expect(fs.existsSync(ownerMessagesFile())).toBe(false);
  });

  it('a key of one character posts and is recorded', async () => {
    expect(await notify({ text: 'hello', key: 'k' })).toEqual(postedInDm);
    expect(Object.keys(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys)).toEqual(['k']);
  });

  it('a key of 200 characters posts and is recorded', async () => {
    const key = 'k'.repeat(200);
    expect(await notify({ text: 'hello', key })).toEqual(postedInDm);
    expect(Object.keys(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys)).toEqual([key]);
  });

  it('a key of 201 characters answers 400 with the rule and posts nothing', async () => {
    expect(await notify({ text: 'hello', key: 'k'.repeat(201) })).toEqual(KEY_RULE);
    expect(rest.calls).toHaveLength(0);
  });
});
