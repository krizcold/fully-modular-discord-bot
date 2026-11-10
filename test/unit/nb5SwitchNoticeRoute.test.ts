import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce, NOTICE_TITLE } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { BOT, DM, FakeOwnerRest, discordError, httpError, networkError } from '../helpers/fakeOwnerRest';
import { ownerChannelState } from '../../src/webui/utils/ownerChannel';
import fs from 'fs';
import { MARKER_FILE, writeFileMarker } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';

// NB5 section 8 test 11 (decision 15 with decision 23's copy), over a fake prober and a fake REST.

const TOKEN = 'nb5-token';
const C = '500000000000000001';
const A = 'postgres://bot:pw@a.example:5432/bot';
const W = 'postgres://bot:pw@w.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let answers: ProbeAnswer[] = [];
let probes = 0;

function main(entry: string, generation: number, machine: string | null, extra: Partial<ProbeAnswer> = {}): ProbeAnswer {
  const [e] = parseAddressList(entry);
  return {
    kind: 'answered', address: e.shown, entry, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'store-1', ownerChannel: { kind: 'none' }, ...extra,
  } as ProbeAnswer;
}

function noticeMessage(generation: number, machine: string) {
  return { embeds: [{ title: NOTICE_TITLE, timestamp: DATE, fields: [{ name: 'Machine', value: machine }, { name: 'Generation', value: String(generation) }] }] };
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
  answers = [main(A, 2, 'M')];
  probes = 0;
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(`${A},${W}`),
    probe: async () => { probes++; return answers; },
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
  vi.restoreAllMocks();
});

async function post(body: unknown, token = TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const ok = { machine: 'M', generation: 2, date: DATE };

describe('decision 15: switch-notice', () => {
  it('needs the manager token', async () => {
    expect((await post(ok, 'wrong')).status).toBe(403);
  });

  it.each([
    [{ ...ok, machine: '' }], [{ ...ok, machine: 'm'.repeat(257) }], [{ ...ok, generation: 0 }], [{ ...ok, generation: -1 }],
    [{ ...ok, generation: 1.5 }], [{ ...ok, generation: 'abc' }], [{ ...ok, date: '2026-11-05T12:00:00.000' }], [{ ...ok, date: 'yesterday' }],
  ])('400 for %j', async body => {
    expect((await post(body)).status).toBe(400);
    expect(rest.calls).toHaveLength(0);
  });

  it('a file bot answers 409', async () => {
    setBackendKind('file');
    expect(await post(ok)).toEqual({ status: 409, body: { success: false, error: 'This bot keeps its data in files, so it has no main database' } });
  });

  it('a main at the generation and machine posts with the nonce, pins and unpins older notices', async () => {
    const older = rest.seed(DM, noticeMessage(1, 'OLD'), true);
    const res = await post({ ...ok, generation: '2' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, pinned: true, channel: 'none' } });
    const [create] = rest.creates(DM);
    expect(create.options.body).toMatchObject({ nonce: hashNonce('["main",2,"M"]'), enforce_nonce: true });
    expect(create.options.body.embeds[0]).toMatchObject({ title: NOTICE_TITLE, fields: [{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }], timestamp: DATE });
    const posted = rest.messages.get(DM)![0];
    expect(rest.pinned.get(DM)!.has(posted.id)).toBe(true);
    expect(rest.pinned.get(DM)!.has(older.id)).toBe(false);
    expect(rest.creates(C)).toHaveLength(0);
  });

  it.each([
    ['a main at a lower generation', () => [main(A, 1, 'M')], 'The databases this bot reaches hold generation 1 (M) as the main, not 2 (M); no notice was posted'],
    ['a main naming another machine', () => [main(A, 2, 'N')], 'The databases this bot reaches hold generation 2 (N) as the main, not 2 (M); no notice was posted'],
    ['a higher generation seen', () => [main(A, 2, 'M'), main(W, 3, 'N')], 'The databases this bot reaches hold generation 3 (N) as the main, not 2 (M); no notice was posted'],
  ])('%s answers 409 and posts nothing', async (_n, set, text) => {
    answers = set();
    expect(await post(ok)).toEqual({ status: 409, body: { success: false, error: text } });
    expect(rest.creates()).toHaveLength(0);
  });

  it.each([
    ['a tie', () => [main(A, 2, 'M'), main(W, 2, 'N')]],
    ['an unreachable list', () => [{ kind: 'failed', address: 'a.example:5432/bot', entry: A, cause: 'a timeout' } as ProbeAnswer]],
    ['a main of another store', () => [main(A, 2, 'M', { storeId: 'store-2' })]],
  ])("%s answers 409 can't confirm and posts nothing", async (_n, set) => {
    answers = set();
    const res = await post(ok);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^can't confirm the main database: .+; no notice was posted$/);
    expect(rest.creates()).toHaveLength(0);
  });

  it('a notice at or above the generation already pinned answers posted false', async () => {
    rest.seed(DM, noticeMessage(3, 'N'), true);
    expect((await post(ok)).body).toEqual({ success: true, posted: false, newer: { generation: 3, machines: ['N'] }, channel: 'none', note: 'A switch notice of generation 3 (N) is already posted; this one was not posted.' });
    expect(rest.creates()).toHaveLength(0);
  });

  it('one found only among the newest 100 is pinned', async () => {
    const found = rest.seed(DM, noticeMessage(2, 'M'));
    expect((await post(ok)).body.posted).toBe(false);
    expect(rest.pinned.get(DM)!.has(found.id)).toBe(true);
  });

  it('a failed read posts', async () => {
    rest.fail('get', /\/messages\/pins$/, discordError(500, 0, 'Internal Server Error'));
    expect((await post(ok)).body.posted).toBe(true);
  });

  it('a failed pin answers pinned false with the note', async () => {
    rest.fail('put', /\/messages\/pins\//, discordError(403, 50013, 'Missing Permissions'));
    const res = await post(ok);
    expect(res.body).toMatchObject({ success: true, posted: true, pinned: false });
    expect(res.body.note).toMatch(/^Posted, but not pinned \(.+\); a machine that comes back after more than 100 later messages in that conversation will not find it$/);
  });

  it('a Discord refusal answers 502 with the keep-it-off text', async () => {
    rest.fail('post', /^\/channels\/\d+\/messages$/, discordError(403, 50007, 'Cannot send messages to this user'));
    expect(await post(ok)).toEqual({ status: 502, body: { success: false, error: "Discord refused the switch notice to the bot's owner (50007 Cannot send messages to this user). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again." } });
  });

  it('a budget that lapses during the post aborts the call and answers unknown', async () => {
    rest.hang('post', /^\/channels\/\d+\/messages$/);
    const res = await post(ok);
    expect(res).toEqual({ status: 502, body: { success: false, unknown: true, error: "can't confirm whether the notice was posted: Discord did not answer within 25 s" } });
    expect(rest.aborted.length).toBeGreaterThan(0);
  });
});

describe('review round 1, lane D: switch-notice', () => {
  it.each([
    ['a network error', () => networkError(), 'a network error (fetch failed)'],
    ['a 500', () => httpError(500, 'Internal Server Error'), 'HTTP 500 (Internal Server Error)'],
  ])("D3: the DM create failing with %s answers 502 can't confirm, not the refusal", async (_name, error, cause) => {
    rest.fail('post', new RegExp(`^/channels/${DM}/messages$`), error());
    expect(await post(ok)).toEqual({ status: 502, body: { success: false, unknown: true, error: `can't confirm whether the notice was posted: ${cause}` } });
  });

  it("D3: the copy failing with a 503 answers channel failed with can't confirm and keeps no refusal", async () => {
    answers = [main(A, 2, 'M', { ownerChannel: { kind: 'id', id: C } })];
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), httpError(503, 'Service Unavailable'));
    expect((await post(ok)).body).toEqual({
      success: true, posted: true, pinned: true, channel: 'failed',
      note: `can't confirm whether the copy in channel ${C} was posted: HTTP 503 (Service Unavailable)`,
    });
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('R2-D1: a slow verify pass after the wait behind a hanging create ends at the deadline set at arrival: 503, nothing posted', async () => {
    rest = new FakeOwnerRest(5_000);
    rest.hang('post', /^\/channels\/\d+\/messages$/);
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(`${A},${W}`),
      probe: async () => { probes++; if (probes > 1) await new Promise(resolve => setTimeout(resolve, 2_000)); return answers; },
      readNotice: async () => ({ kind: 'none' }),
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    const started = Date.now();
    const first = post(ok);
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await post(ok);
    expect(second).toEqual({ status: 503, body: { success: false, error: 'This switch notice waited for an earlier one and ran out of time; nothing was posted; try again' } });
    expect(Date.now() - started).toBeLessThan(50 + 900 + 150);
    expect((await first).body.unknown).toBe(true);
    expect(rest.creates()).toHaveLength(1);
  });
});

describe("decision 15 with decision 23: the copy in the chosen channel", () => {
  beforeEach(() => { answers = [main(A, 2, 'M', { ownerChannel: { kind: 'id', id: C } })]; });

  it('posts and pins in the DM, then posts the copy unpinned with its own nonce', async () => {
    const res = await post(ok);
    expect(res.body).toEqual({ success: true, posted: true, pinned: true, channel: 'posted' });
    const [copy] = rest.creates(C);
    expect(copy.options.body.nonce).toBe(hashNonce(JSON.stringify(['copy', C, 2, 'M'])));
    expect(copy.options.body.nonce).not.toBe(hashNonce(JSON.stringify(['main', 2, 'M'])));
    expect(copy.options.body.embeds[0].title).toBe(NOTICE_TITLE);
    expect(rest.pinned.get(C)?.size ?? 0).toBe(0);
  });

  it('a repeat with the DM notice found and the copy in the channel answers already and posts nothing', async () => {
    rest.seed(DM, noticeMessage(2, 'M'), true);
    rest.seed(C, noticeMessage(2, 'M'));
    expect((await post(ok)).body).toMatchObject({ posted: false, channel: 'already' });
    expect(rest.creates()).toHaveLength(0);
  });

  it('a repeat whose channel lacks the copy posts only the copy', async () => {
    rest.seed(DM, noticeMessage(2, 'M'), true);
    expect((await post(ok)).body).toMatchObject({ posted: false, channel: 'posted' });
    expect(rest.creates(DM)).toHaveLength(0);
    expect(rest.creates(C)).toHaveLength(1);
  });

  it('the channel refusing answers posted with channel failed and the cause in the note', async () => {
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), discordError(403, 50001, 'Missing Access'));
    expect((await post(ok)).body).toEqual({
      success: true, posted: true, pinned: true, channel: 'failed',
      note: `The notice is in the owner's DMs, but its copy in channel ${C} was not posted (50001 Missing Access: the bot cannot see that channel)`,
    });
  });

  it('the budget running out before the copy answers channel failed', async () => {
    rest.on('put', /\/messages\/pins\//, async () => { await new Promise(resolve => setTimeout(resolve, 950)); return undefined; });
    const res = await post(ok);
    expect(res.body).toMatchObject({ posted: true, channel: 'failed' });
    expect(rest.creates(C)).toHaveLength(0);
  });

  it('a DM refusal posts no copy', async () => {
    rest.fail('post', new RegExp(`^/channels/${DM}/messages$`), discordError(403, 50007, 'Cannot send messages to this user'));
    expect((await post(ok)).status).toBe(502);
    expect(rest.creates(C)).toHaveLength(0);
  });

  it("a copy answered with the DM notice answers channel failed naming the owner's DMs", async () => {
    rest.on('post', new RegExp(`^/channels/${C}/messages$`), () => ({ id: 'dmNotice', channel_id: DM, author: { id: BOT } }));
    const res = await post(ok);
    expect(res.body).toMatchObject({ posted: true, channel: 'failed' });
    expect(res.body.note).toBe(`The notice is in the owner's DMs, but its copy in channel ${C} was not posted (Discord returned a message in the owner's DMs instead of a copy in channel ${C})`);
  });

  it('a DM create answered with a message in C answers the DM refusal and posts no copy', async () => {
    rest.on('post', new RegExp(`^/channels/${DM}/messages$`), () => ({ id: 'cMsg', channel_id: C }));
    const res = await post(ok);
    expect(res).toEqual({ status: 502, body: { success: false, error: `Discord refused the switch notice to the bot's owner (Discord returned a message in channel ${C} instead). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.` } });
    expect(rest.creates(C)).toHaveLength(0);
  });
});

// NB5F F1-4: the marker as the real writer leaves it, then its path replaced by a directory (EISDIR).
function markerAsDirectory(): string {
  fs.rmSync(MARKER_FILE, { recursive: true, force: true });
  writeFileMarker({ live: 'postgres', storeId: 'store-1', flippedAt: 1 });
  expect(fs.readFileSync(MARKER_FILE, 'utf-8')).toContain('"storeId": "store-1"');
  fs.rmSync(MARKER_FILE);
  fs.mkdirSync(MARKER_FILE);
  let message = '';
  try { fs.readFileSync(MARKER_FILE, 'utf-8'); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/^EISDIR/);
  return `${MARKER_FILE} cannot be read (${message})`;
}

describe("NB5F F1-4: switch-notice reads this machine's marker strictly", () => {
  it("with the marker a directory, a main at the generation and machine answers 409 with the marker's why and posts nothing", async () => {
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(`${A},${W}`),
      probe: async () => { probes++; return answers; },
      readNotice: async () => ({ kind: 'none' }),
      noticeCheckOff: () => false,
    });
    try {
      const why = markerAsDirectory();
      expect(await post(ok)).toEqual({
        status: 409,
        body: { success: false, error: `can't confirm the main database: ${why}, so the bot can't confirm which store this machine records; no notice was posted` },
      });
      expect(rest.calls).toHaveLength(0);
    } finally {
      fs.rmSync(MARKER_FILE, { recursive: true, force: true });
    }
  });
});
