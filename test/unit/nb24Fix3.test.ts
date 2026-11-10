import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { noticeEmbed } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel, ownerChannelState } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, discordError, httpError } from '../helpers/fakeOwnerRest';

// NB24 code review round 3: regression tests of the fixer's changes.

const TOKEN = 'nb24-fix3-token';
const C = '500000000000000001';
const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let answers: ProbeAnswer[] = [];

function main(generation: number, machine: string, channel?: string): ProbeAnswer {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: channel ? { kind: 'id', id: channel } : { kind: 'none' },
  } as ProbeAnswer;
}

const noticeMessage = (generation: number, machine: string) => ({ embeds: [noticeEmbed({ machine, generation, date: DATE })] });
const channelRead = new RegExp(`^/channels/${C}/messages$`);
const call = { machine: 'M', generation: 2, date: DATE };
const memoryNote = (shown: string) => `can't confirm that the copy in channel ${C} of the notice saying that two machines announced generation 2 is still there: ${shown}; this web UI process posted it earlier and did not post it again`;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

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
  _setManagedTiming({ notifyMs: 600, switchMs: 900 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  answers = [main(2, 'M', C)];
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => answers,
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
  _resetWebuiChoice();
  vi.restoreAllMocks();
});

describe('NB24-C3-D1 / R3-RUN-1: an already answered from the tie-copy memory says what the bot could not see', () => {
  it('a later call whose channel read fails with a 5xx answers already with the read cause and records no refusal', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    const first = await post(call);
    expect(first.body.channel).toBe('posted');
    expect(first.body.note ?? '').not.toContain("can't confirm that the copy");
    rest.expireNonces();
    rest.fail('get', channelRead, httpError(500, 'Internal Server Error'));
    const again = await post(call);
    expect(again.status).toBe(409);
    expect(again.body.channel).toBe('already');
    expect(again.body.note).toContain(memoryNote('the channel could not be read (HTTP 500 (Internal Server Error))'));
    expect(rest.creates(C)).toHaveLength(1);
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('a later call whose channel read is refused with 403 records the refusal for the panel', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    expect((await post(call)).body.channel).toBe('posted');
    rest.expireNonces();
    rest.fail('get', channelRead, discordError(403, 50001, 'Missing Access'));
    const again = await post(call);
    expect(again.body.channel).toBe('already');
    expect(again.body.note).toContain(memoryNote('the channel could not be read (HTTP 403 (Missing Access))'));
    expect(rest.creates(C)).toHaveLength(1);
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: 'the bot cannot see that channel' });
  });

  it('a repeat whose channel read lists no messages answers already with the empty-read note', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    rest.on('get', channelRead, () => []);
    expect((await post(call)).body.channel).toBe('posted');
    rest.expireNonces();
    const again = await post({ ...call, repeat: true });
    expect(again.body.channel).toBe('already');
    expect(again.body.note).toContain(memoryNote('the channel shows the bot no messages (it may lack Read Message History there)'));
    expect(rest.creates(C)).toHaveLength(1);
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('an already from a read that shows the copy carries no memory note', async () => {
    rest.seed(DM, noticeMessage(2, 'O'), true);
    expect((await post(call)).body.channel).toBe('posted');
    rest.expireNonces();
    const again = await post({ ...call, repeat: true });
    expect(again.body.channel).toBe('already');
    expect(again.body.note ?? '').not.toContain("can't confirm that the copy");
  });
});
