import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _resetOwnerChannel, _setOwnerChannelDeps, ownerMessagesFile, type KeyWrite } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

const TOKEN = 'sa14-notify-token';
const ENTRY = 'postgres://bot:pw@db.example:5432/bot';
let rest: FakeOwnerRest;
let router: Router;
let readBounds: number[];
let recordKey: (key: string, at: string) => Promise<KeyWrite>;

function invoke(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req: any = { method: 'POST', url: path, headers: { 'x-bot-token': TOKEN }, body };
    const res: any = {
      status(code: number) { status = code; return res; },
      json(answer: unknown) { resolve({ status, body: answer }); return res; },
    };
    (router as any)(req, res, (error?: unknown) => reject(error ?? new Error(`no route answered ${path}`)));
  });
}

beforeEach(() => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  router = createManagedRoutes({} as BotManager);
  rest = new FakeOwnerRest(300);
  _resetOwnerChannel();
  _resetWebuiChoice();
  readBounds = [];
  recordKey = async () => ({ kind: 'ok' });
  _setOwnerChannelDeps({
    readRow: async () => null,
    readMs: 150,
    readKey: async (_key, boundMs) => { readBounds.push(boundMs); return null; },
    recordKey: (key, at) => recordKey(key, at),
  });
  setBackendKind('postgres');
  setWebuiDataStoreUrl({ url: ENTRY });
  fs.rmSync(ownerMessagesFile(), { force: true });
  fs.rmSync(dataPath('owner-channel.json'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setOwnerChannelDeps(null);
  setWebuiDataStoreUrl(null);
  setBackendKind(null);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
});

const POSTED = { status: 200, body: { success: true, posted: true, place: 'dm' } };

describe('sa14: the key read in the main database is bounded by 5 s or the budget left', () => {
  it('a 600 ms budget bounds the read by what is left of it, at least 1 ms', async () => {
    _setManagedTiming({ notifyMs: 600 });
    expect(await invoke('/notify-owner', { text: 'Backup failed', key: 'sa14-short' })).toEqual(POSTED);
    expect(readBounds).toHaveLength(1);
    expect(readBounds[0]).toBeGreaterThan(300);
    expect(readBounds[0]).toBeLessThanOrEqual(600);
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('the default 20 s budget bounds the read by 5 s', async () => {
    _setManagedTiming({});
    expect(await invoke('/notify-owner', { text: 'Backup failed', key: 'sa14-default' })).toEqual(POSTED);
    expect(readBounds).toEqual([5_000]);
  });
});

describe('sa14: the key record in the main database gets 5 s even past the route budget', () => {
  it('a record that answers after the budget ended but within 5 s is saved, with no note', async () => {
    _setManagedTiming({ notifyMs: 3_000 });
    let called!: () => void;
    const reached = new Promise<void>(resolve => { called = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recordKey = () => {
      called();
      return new Promise(resolve => setTimeout(() => resolve({ kind: 'ok' }), 4_000));
    };
    const answer = invoke('/notify-owner', { text: 'Backup failed', key: 'sa14-late-record' });
    await reached;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await answer).toEqual(POSTED);
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('a record with no answer within 5 s answers posted with the can\'t-confirm note naming the database\'s silence', async () => {
    _setManagedTiming({ notifyMs: 600 });
    let called!: () => void;
    const reached = new Promise<void>(resolve => { called = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recordKey = () => {
      called();
      return new Promise<KeyWrite>(() => undefined);
    };
    const answer = invoke('/notify-owner', { text: 'Backup failed', key: 'sa14-silent-record' });
    await reached;
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await answer).toEqual({
      status: 200,
      body: {
        success: true, posted: true, place: 'dm',
        note: "can't confirm whether the repeat check was saved in the bot's main database (the database did not answer in time), so a repeat of this key may post again after the main database moves to another machine.",
      },
    });
    expect(Object.keys(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys)).toEqual(['sa14-silent-record']);
  });
});
