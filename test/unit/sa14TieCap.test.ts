import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { DM, FakeOwnerRest, httpError } from '../helpers/fakeOwnerRest';

const TOKEN = 'sa14-cap-token';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
let rest: FakeOwnerRest;
let router: Router;
let channel = '';

const channelOf = (i: number) => `5000000000014${String(i).padStart(5, '0')}`;

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

function probe(): ProbeAnswer[] {
  const [e] = parseAddressList(A);
  return [{
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation: 2, machine: 'M', since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: { kind: 'id', id: channel },
  } as ProbeAnswer];
}

beforeEach(() => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  router = createManagedRoutes({} as BotManager);
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 900 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => probe(),
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
  setBackendKind('postgres');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setWebuiChoiceDeps(null);
  setBackendKind(null);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
});

const unreadable = (i: number) => rest.fail('get', new RegExp(`^/channels/${channelOf(i)}/messages$`), httpError(500, 'Internal Server Error'));

describe('sa14: this process remembers the newest 1000 tie copies', () => {
  it('after 1001 tie copies the first is forgotten and posts again on a failed read; the second is still remembered', async () => {
    rest.seed(DM, { embeds: [noticeEmbed({ machine: 'O', generation: 2, date: DATE })] }, true);
    for (let i = 0; i <= 1000; i++) {
      channel = channelOf(i);
      const res = await post();
      expect(res.body.channel).toBe('posted');
    }
    expect(rest.creates()).toHaveLength(1002);

    unreadable(1);
    channel = channelOf(1);
    const second = await post();
    expect(second.body.channel).toBe('already');
    expect(rest.creates(channelOf(1))).toHaveLength(1);

    unreadable(0);
    channel = channelOf(0);
    const first = await post();
    expect(first.status).toBe(409);
    expect(first.body.channel).toBe('posted');
    expect(rest.creates(channelOf(0))).toHaveLength(2);
    expect(first.body.note ?? '').not.toContain("can't confirm that the copy");
  }, 30_000);
});

function post() {
  return invoke('/switch-notice', { machine: 'M', generation: 2, date: DATE });
}
