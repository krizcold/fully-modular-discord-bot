import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { hashNonce } from '../../src/utils/ownerMessages';
import { _setOwnerChannelDeps, _resetOwnerChannel, ownerChannelState, ownerMessagesFile } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, _setWebuiChoiceDeps, noteWebuiChild, resolveWebuiDatabase, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { NoticeRead, ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, discordError, httpError, networkError } from '../helpers/fakeOwnerRest';

// NB5 section 8 test 10 (decision 14 with decision 23's place), on createManagedRoutes over a fake REST.

const failWrite = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string) => {
      if (failWrite.on && file.endsWith('owner-messages.json')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.atomicWriteFileSync(file, contents);
    },
  };
});

const TOKEN = 'nb5-token';
const C = '500000000000000001';
const ENTRY = 'postgres://bot:pw@db.example:5432/bot';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
const row = { value: null as unknown, hang: false, fail: null as Error | null };

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  failWrite.on = false;
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 750 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  row.value = null;
  row.hang = false;
  row.fail = null;
  _setOwnerChannelDeps({
    readRow: async () => {
      if (row.hang) return new Promise(() => undefined);
      if (row.fail) throw row.fail;
      return row.value;
    },
    readMs: 150,
  });
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
  setWebuiDataStoreUrl(null);
  vi.restoreAllMocks();
});

async function notify(body: unknown, token = TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/notify-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const record = () => JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8'));
const channelFile = (id: string) => fs.writeFileSync(dataPath('owner-channel.json'), JSON.stringify({ channelId: id }));

describe('decision 14: notify-owner', () => {
  it('needs the manager token', async () => {
    expect((await notify({ text: 'hi', key: 'k' }, 'wrong')).status).toBe(403);
    expect(rest.calls).toHaveLength(0);
  });

  it.each([
    [{ key: 'k' }],
    [{ text: '', key: 'k' }],
    [{ text: 'x'.repeat(2001), key: 'k' }],
    [{ text: 'hi' }],
    [{ text: 'hi', key: 'k'.repeat(201) }],
  ])('400 for %j, and nothing posted', async body => {
    const res = await notify(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(rest.calls).toHaveLength(0);
  });

  it('a new key posts in the DM with the nonce of dm:<key>, records the key and answers posted', async () => {
    const res = await notify({ text: 'Backup failed', key: 'backup-1' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm' } });
    const [create] = rest.creates(DM);
    expect(create.options.body).toEqual({ content: 'Backup failed', nonce: hashNonce('dm:backup-1'), enforce_nonce: true });
    expect(Object.keys(record().keys)).toEqual(['backup-1']);
  });

  it('the same key again answers posted false with the note and posts nothing', async () => {
    await notify({ text: 'one', key: 'k1' });
    const at = record().keys.k1;
    const again = await notify({ text: 'one', key: 'k1' });
    expect(again.body).toEqual({ success: true, posted: false, note: `A message with this key was posted on ${at}; this repeat was not posted.` });
    expect(rest.creates()).toHaveLength(1);
  });

  it('a record write that throws after the post answers posted with the note', async () => {
    failWrite.on = true;
    const res = await notify({ text: 'one', key: 'k2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true, posted: true, place: 'dm',
      note: 'The repeat check could not be saved (ENOSPC: no space left on device), so a repeat of this key would post again.',
    });
  });

  it('a Discord 50007 in the DM answers 502 with the code and records nothing', async () => {
    rest.fail('post', /^\/channels\/\d+\/messages$/, discordError(403, 50007, 'Cannot send messages to this user'));
    const res = await notify({ text: 'one', key: 'k3' });
    expect(res).toEqual({ status: 502, body: { success: false, error: "Discord refused the message to the bot's owner (50007 Cannot send messages to this user)" } });
    expect(fs.existsSync(ownerMessagesFile())).toBe(false);
  });

  it('a REST that never answers gives 502 unknown within the budget, the call aborted, nothing recorded', async () => {
    rest.answering = false;
    const started = Date.now();
    const res = await notify({ text: 'one', key: 'k4' });
    expect(Date.now() - started).toBeLessThan(600 + 200);
    expect(res).toEqual({ status: 502, body: { success: false, unknown: true, error: "can't confirm whether the message was posted: Discord did not answer within 20 s" } });
    expect(rest.aborted.length).toBeGreaterThan(0);
    expect(fs.existsSync(ownerMessagesFile())).toBe(false);
  });

  it('a second request with the key waits for the first call to settle, then answers by the record', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rest.on('post', /^\/channels\/\d+\/messages$/, async () => { await gate; return undefined; });
    const first = notify({ text: 'one', key: 'k5' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = notify({ text: 'one', key: 'k5' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rest.creates()).toHaveLength(1);
    release();
    expect((await first).body.posted).toBe(true);
    expect((await second).body.posted).toBe(false);
    expect(rest.creates()).toHaveLength(1);
  });

  it('an unreadable record file answers 502 and posts nothing', async () => {
    fs.writeFileSync(ownerMessagesFile(), '{not json');
    const res = await notify({ text: 'one', key: 'k6' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^The record of posted messages \(\/data\/owner-messages\.json\) cannot be read \(.+\); nothing was posted$/);
    expect(rest.calls).toHaveLength(0);
  });

  it('two concurrent requests with one key post once', async () => {
    const answers = await Promise.all([notify({ text: 'one', key: 'k7' }), notify({ text: 'one', key: 'k7' })]);
    expect(answers.map(a => a.body.posted).sort()).toEqual([false, true]);
    expect(rest.creates()).toHaveLength(1);
  });

  it('the record keeps at most 1000 keys and none older than 90 days', async () => {
    const keys: Record<string, string> = { old: new Date(Date.now() - 91 * 86_400_000).toISOString() };
    for (let i = 0; i < 1000; i++) keys[`k${i}`] = new Date(Date.now() - (1000 - i) * 1000).toISOString();
    fs.writeFileSync(ownerMessagesFile(), JSON.stringify({ keys }));
    await notify({ text: 'one', key: 'newest' });
    const kept = Object.keys(record().keys);
    expect(kept).toHaveLength(1000);
    expect(kept).not.toContain('old');
    expect(kept).not.toContain('k0');
    expect(kept).toContain('newest');
  });
});

describe('review round 1, lane D: notify-owner', () => {
  it("D3: a network error on the DM create answers 502 can't confirm, not the refusal, and records nothing", async () => {
    rest.fail('post', /^\/channels\/\d+\/messages$/, networkError());
    expect(await notify({ text: 'one', key: 'd3a' })).toEqual({
      status: 502, body: { success: false, unknown: true, error: "can't confirm whether the message was posted: a network error (fetch failed)" },
    });
    expect(fs.existsSync(ownerMessagesFile())).toBe(false);
  });

  it("D3: a 503 on the create in the chosen channel answers 502 can't confirm and keeps no refusal for the panel", async () => {
    channelFile(C);
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), httpError(503, 'Service Unavailable'));
    expect(await notify({ text: 'one', key: 'd3b' })).toEqual({
      status: 502, body: { success: false, unknown: true, error: "can't confirm whether the message was posted: HTTP 503 (Service Unavailable)" },
    });
    expect(ownerChannelState().lastRefusal).toBeNull();
    expect(rest.creates(DM)).toHaveLength(0);
  });

  it('D4: two keys posting at once both stay in the record', async () => {
    const gates = new Map<string, () => void>();
    rest.on('post', /^\/channels\/\d+\/messages$/, call => new Promise<undefined>(resolve => { gates.set(call.options.body.content, () => resolve(undefined)); }));
    const one = notify({ text: 'one', key: 'K1' });
    const two = notify({ text: 'two', key: 'K2' });
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get('one')!();
    expect((await one).body.posted).toBe(true);
    gates.get('two')!();
    expect((await two).body.posted).toBe(true);
    expect(Object.keys(record().keys).sort()).toEqual(['K1', 'K2']);
  });

  it('D5: a request waiting behind a hung one with its key answers by its own deadline, not one budget later', async () => {
    rest = new FakeOwnerRest(5_000);
    rest.hang('post', /^\/channels\/\d+\/messages$/);
    const started = Date.now();
    const first = notify({ text: 'one', key: 'd5a' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await notify({ text: 'one', key: 'd5a' });
    expect(Date.now() - started).toBeLessThan(50 + 600 + 200);
    expect(second.status).toBeGreaterThanOrEqual(502);
    expect(second.body.success).toBe(false);
    expect((await first).body.unknown).toBe(true);
    for (const call of rest.creates()) expect(call.aborted).toBe(true);
  });

  it('R2-D1: a slow setting read after the wait behind a hanging create ends at the deadline set at arrival: 503, nothing posted', async () => {
    rest = new FakeOwnerRest(5_000);
    rest.hang('post', /^\/channels\/\d+\/messages$/);
    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: ENTRY });
    let reads = 0;
    _setOwnerChannelDeps({ readRow: async () => (++reads === 1 ? null : new Promise(() => undefined)), readMs: 900 });
    const started = Date.now();
    const first = notify({ text: 'one', key: 'r2d1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await notify({ text: 'one', key: 'r2d1' });
    expect(second).toEqual({ status: 503, body: { success: false, error: 'This request waited for an earlier request for this key and ran out of time; nothing was posted; try again' } });
    expect(Date.now() - started).toBeLessThan(50 + 600 + 200);
    expect((await first).body.unknown).toBe(true);
    expect(rest.creates()).toHaveLength(1);
  });
});

describe('decision 14 with decision 23: the place', () => {
  it('a JSON bot with a channel set posts in that channel only, with the nonce of channel:<id>:<key>', async () => {
    channelFile(C);
    const res = await notify({ text: 'one', key: 'k8' });
    expect(res.body).toEqual({ success: true, posted: true, place: 'channel' });
    expect(rest.creates(DM)).toHaveLength(0);
    expect(rest.calls.some(c => c.route === '/users/@me/channels')).toBe(false);
    expect(rest.creates(C)[0].options.body.nonce).toBe(hashNonce(`channel:${C}:k8`));
  });

  it('a Postgres bot reads the setting through the resolution: no row posts in the DM', async () => {
    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: ENTRY });
    const res = await notify({ text: 'one', key: 'k9' });
    expect(res.body).toEqual({ success: true, posted: true, place: 'dm' });
  });

  it('a Postgres bot with the row C posts in C', async () => {
    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: ENTRY });
    row.value = JSON.stringify(C);
    const res = await notify({ text: 'one', key: 'k10' });
    expect(res.body).toEqual({ success: true, posted: true, place: 'channel' });
  });

  it.each([
    [10003, 404, 'Unknown Channel', 'the channel does not exist, or the bot is not in its server'],
    [50001, 403, 'Missing Access', 'the bot cannot see that channel'],
    [50013, 403, 'Missing Permissions', 'the bot lacks the Send Messages permission there'],
  ])('the channel refusing with %i answers 502 with the cause, nothing in the DM, no key, the refusal kept', async (code, status, message, cause) => {
    channelFile(C);
    rest.fail('post', new RegExp(`^/channels/${C}/messages$`), discordError(status, code, message));
    const res = await notify({ text: 'one', key: `k-${code}` });
    expect(res).toEqual({ status: 502, body: {
      success: false,
      error: `Discord refused the message in the chosen channel ${C} (${code} ${message}): ${cause}. Nothing was posted; give the bot access to that channel in Discord, or choose another place in the web panel.`,
    } });
    expect(rest.creates(DM)).toHaveLength(0);
    expect(fs.existsSync(ownerMessagesFile())).toBe(false);
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: cause });
  });

  it.each([
    ['the resolution refused (the bot process choosing)', () => { setBackendKind('postgres'); setWebuiDataStoreUrl({ url: null, choosing: true, reason: 'checking the databases' }); }, 'checking the databases'],
    ['the SELECT timing out', () => { setBackendKind('postgres'); setWebuiDataStoreUrl({ url: ENTRY }); row.hang = true; }, 'the database did not answer within 5 s'],
    ['a value "abc"', () => { setBackendKind('postgres'); setWebuiDataStoreUrl({ url: ENTRY }); row.value = JSON.stringify('abc'); }, 'the stored value is not a channel ID of 17 to 20 digits'],
    ['an unreadable file', () => { fs.writeFileSync(dataPath('owner-channel.json'), '{oops'); }, null],
    ['a child in a normal boot with no data:store yet', () => { setBackendKind('postgres'); noteWebuiChild('started'); }, 'the bot process is starting; try again once it has started'],
  ])('%s posts in the DM with the setting note', async (_name, arrange, cause) => {
    arrange();
    const res = await notify({ text: 'one', key: `k-${_name.length}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, posted: true, place: 'dm' });
    if (cause) expect(res.body.note).toBe(`Posted in the owner's DMs: the chosen channel setting could not be read (${cause}).`);
    else expect(res.body.note).toMatch(/^Posted in the owner's DMs: the chosen channel setting could not be read \(.+\)\.$/);
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('a failed record write after a channel post answers with both notes when the setting note applies too', async () => {
    channelFile(C);
    failWrite.on = true;
    const res = await notify({ text: 'one', key: 'k11' });
    expect(res.body).toEqual({
      success: true, posted: true, place: 'channel',
      note: 'The repeat check could not be saved (ENOSPC: no space left on device), so a repeat of this key would post again.',
    });
  });

  it('one key in the DM and, after the setting changed, in C carries two nonces', async () => {
    await notify({ text: 'one', key: 'same' });
    fs.rmSync(ownerMessagesFile());
    channelFile(C);
    await notify({ text: 'one', key: 'same' });
    expect(rest.creates(DM)[0].options.body.nonce).toBe(hashNonce('dm:same'));
    expect(rest.creates(C)[0].options.body.nonce).toBe(hashNonce(`channel:${C}:same`));
    expect(hashNonce('dm:same')).not.toBe(hashNonce(`channel:${C}:same`));
  });

  it('a create in C answered with a message in the DM records the key and answers dm with the note', async () => {
    channelFile(C);
    rest.on('post', new RegExp(`^/channels/${C}/messages$`), () => ({ id: 'old', channel_id: DM }));
    const res = await notify({ text: 'one', key: 'k12' });
    expect(res.body).toEqual({
      success: true, posted: true, place: 'dm',
      note: `Discord answered with a message in the owner's DMs instead of a new one in channel ${C}.`,
    });
    expect(Object.keys(record().keys)).toEqual(['k12']);
  });

  it("a maintenance-boot child posts in the channel that its own choice's main holds, with place channel", async () => {
    setBackendKind('postgres');
    noteWebuiChild('maintenance-boot');
    const [main] = parseAddressList(ENTRY);
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(ENTRY),
      probe: async () => [{
        kind: 'answered', address: main.shown, entry: ENTRY, inRecovery: false, readOnly: false, generation: 1, machine: 'M',
        since: '2026-11-05T12:00:00.000Z', sysid: 's', started: 't', storeId: 'store-1', ownerChannel: { kind: 'id', id: C },
      } as ProbeAnswer],
      readNotice: async () => ({ kind: 'none' }) as NoticeRead,
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    try {
      resolveWebuiDatabase();
      await vi.waitFor(() => expect(resolveWebuiDatabase()).toEqual({ entry: ENTRY, tag: '1:M' }));
      _setOwnerChannelDeps({
        readRow: async () => {
          const resolved = resolveWebuiDatabase();
          return 'entry' in resolved && resolved.entry === ENTRY ? JSON.stringify(C) : null;
        },
        readMs: 150,
      });
      const res = await notify({ text: 'one', key: 'k13' });
      expect(res.body).toEqual({ success: true, posted: true, place: 'channel' });
      expect(rest.creates(C)).toHaveLength(1);
      expect(rest.creates(DM)).toHaveLength(0);
    } finally {
      _setWebuiChoiceDeps(null);
      noteWebuiChild('gone');
    }
  });
});
