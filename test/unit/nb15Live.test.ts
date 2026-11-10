import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// NB15 test 14 (decision 15): live panel changes between machines. The holder keeps a state only for a watched pair,
// announces it on 'smdb_panel_changed' and answers 'panel:live'; the web UI watches, listens, fetches and says when
// its view may be out of date. The migration does not count the listening connection.
import {
  NOTIFY_SQL,
  _interestCount,
  _resetPanelLive,
  _setNotifyDb,
  isNotifying,
  liveAnswer,
  noteLiveChange,
  notifyTick,
  registerInterest,
} from '../../src/bot/internalSetup/fleet/panelLive';
import { sendLiveUpdate } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { readSourceText } from '../helpers/sourceText';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { remotePanelAnswer } from '../../src/webui/utils/guildRequests';
import { countsAsOther, WEBUI_LISTEN_APP } from '../../src/bot/internalSetup/utils/dataMigration';

const G = '4194304';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
});

afterEach(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the holder', () => {
  it('the three senders go through sendLiveUpdate, which still sends the IPC message', () => {
    const adapter = readSourceText(__dirname, '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter.ts');
    const persistent = readSourceText(__dirname, '../../src/bot/internalSetup/utils/panel/persistentPanelResponse.ts');
    expect((adapter.match(/type: 'panel:live_update'/g) ?? []).length).toBe(1);
    expect(persistent).not.toContain("type: 'panel:live_update'");
    expect((persistent.match(/sendLiveUpdate\(/g) ?? []).length).toBe(2);
    const send = vi.fn();
    const before = process.send;
    (process as any).send = send;
    try {
      sendLiveUpdate({ panelId: 'p', guildId: G, sessionId: null, response: { v: 1 } });
    } finally {
      (process as any).send = before;
    }
    expect(send).toHaveBeenCalledWith({ type: 'panel:live_update', data: { panelId: 'p', guildId: G, sessionId: null, response: { v: 1 } } });
  });

  it('a change to a pair with an interest is kept and marked; one without, and a guild-less one, are not', async () => {
    const notify = vi.fn(async (_payloads: string[]) => undefined);
    _setNotifyDb({ notify }, () => false);
    noteLiveChange(G, 'p', { v: 0 });
    noteLiveChange(null, 'p', { v: 0 });
    const since = registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    expect(liveAnswer(G, 'p', since)).toEqual({ success: true, data: { v: 1 }, since, version: 1, notifying: null });
    expect(liveAnswer(G, 'q', registerInterest(G, 'q'))).toMatchObject({ data: null });
    await notifyTick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual([JSON.stringify({ g: G, p: 'p' })]);
    await notifyTick();
    expect(notify.mock.calls[1][0], 'the first statement that works since the start announces every watched pair').toEqual([JSON.stringify({ g: G, p: 'p' }), JSON.stringify({ g: G, p: 'q' })]);
    await notifyTick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('an interest ends 90 s after its last renewal with its kept state, and lives on while renewed', () => {
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(60_000);
      registerInterest(G, 'p');
    }
    expect(liveAnswer(G, 'p', 1)).toMatchObject({ data: { v: 1 } });
    vi.advanceTimersByTime(90_001);
    expect(_interestCount()).toBe(0);
  });

  it('the 129th interest is not registered and answers since null; an oversize state is kept as oversize', () => {
    for (let i = 0; i < 128; i++) expect(registerInterest(G, `p${i}`)).not.toBeNull();
    expect(registerInterest(G, 'last')).toBeNull();
    expect(liveAnswer(G, 'last', null)).toEqual({ success: true, data: null, since: null, version: 0, notifying: null });
    noteLiveChange(G, 'p0', { big: 'z'.repeat(300 * 1024) });
    expect(liveAnswer(G, 'p0', 1)).toMatchObject({ data: null, oversize: { reason: 'too-large' } });
  });

  it('one notify statement per tick with at most 100 payloads, the rest next tick', async () => {
    const notify = vi.fn(async (_payloads: string[]) => undefined);
    _setNotifyDb({ notify }, () => false);
    registerInterest(G, 'p0');
    await notifyTick();
    notify.mockClear();
    for (let i = 0; i < 120; i++) {
      registerInterest(G, `p${i}`);
      noteLiveChange(G, `p${i}`, { i });
    }
    await notifyTick();
    await notifyTick();
    expect(notify.mock.calls.map(c => c[0].length)).toEqual([100, 20]);
    expect(NOTIFY_SQL).toBe("SELECT pg_notify('smdb_panel_changed', p) FROM unnest($1::text[]) AS p");
  });

  it('R11 ruling: a process starts with its notify state unknown, and the first interest starts the probe', async () => {
    const sent: string[][] = [];
    _setNotifyDb({ notify: async payloads => { sent.push(payloads); } }, () => true);
    expect(isNotifying()).toBeNull();
    const since = registerInterest(G, 'p');
    expect(liveAnswer(G, 'p', since).notifying).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([[]]);
    expect(liveAnswer(G, 'p', since).notifying).toBe(true);
  });

  it('a failed statement keeps the pairs marked, sets notifying false and logs at once and every 60 s, then the works-again line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let fail = true;
    const notify = vi.fn(async (_payloads: string[]) => { if (fail) throw new Error('Query read timeout'); });
    _setNotifyDb({ notify }, () => false);
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await notifyTick();
    expect(liveAnswer(G, 'p', 1).notifying).toBe(false);
    await notifyTick();
    expect(error).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await notifyTick();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toBe("[PanelLive] Could not tell other machines' web panels that panels changed (Query read timeout); panels shown there may be out of date until this works");
    fail = false;
    await notifyTick();
    expect(log).toHaveBeenCalledWith("[PanelLive] Telling other machines' web panels about panel changes works again");
    expect(liveAnswer(G, 'p', 1).notifying).toBe(true);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('the notify pool: application name, max 1, a 3 s client bound, a 2 s statement_timeout, keepalive after 30 s', () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/fleet/panelLive.ts');
    for (const piece of ["application_name: PANEL_NOTIFY_APPLICATION_NAME", 'max: 1', 'statement_timeout: 2000', 'keepAliveInitialDelayMillis: 30_000', 'query_timeout: NOTIFY_QUERY_MS']) expect(src).toContain(piece);
    expect(src).toMatch(/const NOTIFY_QUERY_MS = 3000;/);
  });
});

class FakeListen extends EventEmitter {
  queries: string[] = [];
  answer: (text: string) => 'hang' | Error | undefined = () => undefined;
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: any) { super(); }
  connect() { return Promise.resolve(); }
  query(text: string) {
    this.queries.push(text);
    const step = this.answer(text);
    if (step === 'hang') return new Promise(() => undefined);
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({ rows: [] });
  }
  end() { return Promise.resolve(); }
}

describe('the web UI', () => {
  let clients: FakeListen[];
  let fetches: Array<{ g: string; p: string; have: { haveVersion: number; haveSince: number | null }; done: (a: FetchAnswer) => void }>;
  let updates: any[];
  let statuses: any[];
  let entry: string;

  function watcher(): PanelLiveWatch {
    clients = [];
    fetches = [];
    updates = [];
    statuses = [];
    entry = 'postgres://bot@localhost/bot';
    const deps: WatchDeps = {
      fetch: (g, p, _u, have) => new Promise(done => { fetches.push({ g, p, have, done }); }),
      emitUpdate: data => updates.push(data),
      emitStatus: data => statuses.push(data),
      entry: () => ({ entry }),
      makeClient: config => { const c = new FakeListen(config); clients.push(c); return c as any; },
    };
    return new PanelLiveWatch(deps);
  }
  const ok = (over: Record<string, unknown> = {}): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: null, since: 5, notifying: true, servedBy: 'BRAVO', ...over } });
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('a watch call registers, starts a fetch, opens the listener with LISTEN; it expires 90 s after its last call; the 51st registers none', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(clients).toHaveLength(1);
    expect(clients[0].config).toMatchObject({ application_name: WEBUI_LISTEN_APP, connectionTimeoutMillis: 5000, keepAlive: true, keepAliveInitialDelayMillis: 30000 });
    expect(clients[0].queries).toEqual(['LISTEN smdb_panel_changed']);
    expect(fetches.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < 50; i++) w.watch(G, `p${i}`, 'web-ui-owner', 'BRAVO');
    expect(w.watch(G, 'p50', 'web-ui-owner', 'BRAVO')).toEqual({ live: false, reason: LIVE_REASONS.tooMany });
    vi.advanceTimersByTime(90_001);
    expect(w.count()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(w.listenerUp()).toBe(false);
  });

  it('a notification for a watched pair starts one fetch, one more after it during it, never more than 4 at once', async () => {
    const w = watcher();
    for (let i = 0; i < 6; i++) w.watch(G, `p${i}`, 'web-ui-owner', 'BRAVO');
    await settle();
    expect(fetches.length).toBeLessThanOrEqual(4);
    const first = fetches.length;
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p0' }) });
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p0' }) });
    expect(fetches.length).toBe(first);
    fetches[0].done(ok());
    await settle();
    expect(fetches.length).toBeLessThanOrEqual(first + 1);
  });

  it("a fetched state goes out as 'panel:updated' with servedBy; data null with the same process and since keeps the pair live; another since marks it missed", async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ data: { v: 2 }, version: 1 }));
    await settle();
    expect(updates).toEqual([{ panelId: 'p', guildId: G, sessionId: null, response: { v: 2 }, servedBy: 'BRAVO' }]);
    expect(statuses.at(-1), 'a fetch sent before the listener listened makes nothing live').toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.connecting });
    expect(fetches, 'the LISTEN fetched the pair once more').toHaveLength(1);
    fetches.shift()!.done(ok({ data: { v: 2 }, version: 1 }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: true, reason: null });
    while (fetches.length) fetches.shift()!.done(ok());
    await settle();
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok());
    await settle();
    expect(statuses.at(-1)?.live).toBe(true);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ since: 9 }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
    w.noteAnswer(G, 'p', 'p-b', 9, 1);
    expect(statuses.at(-1)?.live).toBe(true);
  });

  it('an answer with notifying false turns the line on, a later notifying true turns it off; a refusal logs at most every 60 s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ notifying: false }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.connecting });
    fetches.shift()!.done(ok({ notifying: false }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.cannotAnnounce('BRAVO') });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok());
    await settle();
    expect(statuses.at(-1)?.live).toBe(true);
    for (let i = 0; i < 2; i++) {
      w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      fetches.shift()!.done({ status: 503, reply: { success: false, error: 'BRAVO did not answer in time' } });
      await settle();
    }
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith('[PanelLive] Could not fetch the new state of panel p of server')).length).toBe(1);
  });

  it('R11 ruling: a known miss outranks checking: notifying null with since null shows the too-many line', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ notifying: null, since: null }));
    await settle();
    fetches.shift()!.done(ok({ notifying: null, since: null }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.tooMany });
  });

  it('an answer with notifying null shows the pair as being checked, never live or out of date; the announced refetch makes it live', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ notifying: null }));
    await settle();
    fetches.shift()!.done(ok({ notifying: null }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: null, checking: true });
    expect(w.watch(G, 'p', 'web-ui-owner', 'BRAVO')).toEqual({ live: false, reason: null, checking: true });
    await settle();
    fetches.shift()!.done(ok({ notifying: null }));
    await settle();
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    fetches.shift()!.done(ok());
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: true, reason: null });
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    fetches.shift()!.done(ok({ notifying: false }));
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.cannotAnnounce('BRAVO') });
  });

  it('a listening socket that stops answering is found by the 30 s check within 35 s, every pair goes not live, it retries every 5 s and fetches every pair on reconnect', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) {
      fetches.shift()!.done(ok());
      await settle();
    }
    clients[0].answer = text => (text === 'SELECT 1' ? 'hang' : undefined);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.unreachable });
    expect(fetches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(fetches).toHaveLength(1);
  });

  it('a change of the resolved entry listens on the new database and fetches every pair once', async () => {
    const w = watcher();
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    entry = 'postgres://bot@127.0.0.1/other';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients).toHaveLength(2);
    expect(clients[1].config.database).toBe('other');
  });

  it("an 'unprotected' listening connection is closed unused and the line names the certificate", async () => {
    const w = watcher();
    entry = 'postgres://bot@db.example/bot';
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(clients[0].queries).toEqual([]);
    expect(w.watch(G, 'p', 'web-ui-owner', 'BRAVO')).toEqual({ live: false, reason: LIVE_REASONS.insecure });
  });

  it('T14: a second notification during a fetch starts exactly one more fetch after it, and no third', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p0', 'p-b', 5);
    w.watch(G, 'p0', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p0' }) });
    await settle();
    expect(fetches.map(x => x.p)).toEqual(['p0']);
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p0' }) });
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p0' }) });
    await settle();
    expect(fetches).toHaveLength(1);
    fetches.shift()!.done(ok({ data: { v: 1 }, version: 1 }));
    await settle();
    expect(fetches.map(x => x.p), 'one follow-up fetch for the notification that came during the fetch').toEqual(['p0']);
    fetches.shift()!.done(ok({ data: { v: 2 }, version: 2 }));
    await settle();
    expect(fetches).toHaveLength(0);
    expect(updates.map(u => u.response)).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it.each([
    ['another holder process with data null', { status: null, holderProcess: 'p-x', reply: { success: true, data: null, since: 5, notifying: true, servedBy: 'BRAVO' } }],
  ] as const)('T14: %s marks the pair missed and sends live false until the panel is next used', async (_what, answer) => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    expect(statuses.at(-1)?.live).toBe(true);
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    fetches.shift()!.done(answer as FetchAnswer);
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
    expect(updates).toEqual([]);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(answer as FetchAnswer);
    await settle();
    expect(statuses.at(-1)?.live, 'still missed: nothing showed the dropped change').toBe(false);
    w.noteAnswer(G, 'p', answer.holderProcess, 5, 1);
    expect(statuses.at(-1)?.live, 'the panel was used: its answer shows the current state').toBe(true);
  });

  it.each([
    ['a refusal', { status: 503, reply: { success: false, code: 'no-holder', error: "BRAVO's bot is restarting" } }],
    ['no answer', { status: 503, reply: { success: false, code: 'no-answer', noAnswer: 'timeout', error: "BRAVO did not send the panel's new state in time; nothing was changed." } }],
  ] as const)('T14: %s sends live_status false for the pair', async (_what, answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    expect(statuses.at(-1)?.live).toBe(true);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(answer as FetchAnswer);
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
  });

  const OVERSIZE = { bytes: 300 * 1024, reason: 'too-large' };
  const holderOversize = (): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: null, oversize: OVERSIZE, since: 5, version: 1, notifying: true, servedBy: 'BRAVO' } });
  const routeOversize = (): FetchAnswer => ({ ...remotePanelAnswer('panel:live', { k: 'reply', reply: { success: true, data: null, oversize: OVERSIZE, since: 5, version: 1, notifying: true } }, 'owner', 'BRAVO'), holderProcess: 'p-b' });

  it.each([
    ["the holder's oversize note", holderOversize],
    ["the route's 502 for it", routeOversize],
  ] as const)('T14 (R3 ruling): %s stays "may be out of date" with the size reason after a failed fetch, until a state that fits arrives', async (_what, oversize) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    if (oversize === routeOversize) expect(routeOversize()).toMatchObject({ status: 502, reply: { success: false, code: 'answer-too-large' } });
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    expect(statuses.at(-1)?.live).toBe(true);
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    fetches.shift()!.done(oversize());
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.tooLarge });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const failed = fetches.shift()!;
    expect(failed.have, 'the oversize state was never delivered').toEqual({ haveVersion: 0, haveSince: 5 });
    failed.done({ status: 503, reply: { success: false, code: 'no-answer', noAnswer: 'lost', error: 'BRAVO did not answer' } });
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.tooLarge });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok());
    await settle();
    expect(statuses.at(-1), 'data null delivers nothing').toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.tooLarge });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    fetches.shift()!.done(ok({ data: { v: 2 }, version: 2 }));
    await settle();
    expect(updates.map(u => u.response)).toEqual([{ v: 2 }]);
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: true, reason: null });
  });

  it('T14 (R3 ruling): a fetch whose answer the holder wrote but this web UI never read leaves haveVersion, so the next fetch gets the state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const since = registerInterest(G, 'p')!;
    _setNotifyDb({ notify: async () => undefined });
    await notifyTick();
    const holder = (have: { haveVersion: number; haveSince: number | null }): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { ...liveAnswer(G, 'p', registerInterest(G, 'p'), have.haveVersion, have.haveSince), servedBy: 'BRAVO' } });
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', since, 0);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { const f = fetches.shift()!; f.done(holder(f.have)); await settle(); }
    expect(statuses.at(-1)?.live).toBe(true);
    noteLiveChange(G, 'p', { v: 1 });
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    const lost = fetches.shift()!;
    expect(holder(lost.have).reply).toMatchObject({ data: { v: 1 }, version: 1 });
    lost.done({ status: 503, reply: { success: false, code: 'no-answer', noAnswer: 'lost', error: "BRAVO's answer could not be read" } });
    await settle();
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const next = fetches.shift()!;
    expect(next.have).toEqual({ haveVersion: 0, haveSince: since });
    next.done(holder(next.have));
    await settle();
    expect(updates.map(u => u.response)).toEqual([{ v: 1 }]);
    expect(statuses.at(-1)).toEqual({ guildId: G, panelId: 'p', live: true, reason: null });
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const after = fetches.shift()!;
    expect(after.have).toEqual({ haveVersion: 1, haveSince: since });
    after.done(holder(after.have));
    await settle();
    expect(updates).toHaveLength(1);
    expect(statuses.at(-1)?.live).toBe(true);
  });

  it("T14 (R3 ruling): an owner action's view noted during a fetch raises haveVersion, and that fetch's older state is not shown", async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    const inFlight = fetches.shift()!;
    w.noteAnswer(G, 'p', 'p-b', 5, 2);
    inFlight.done(ok({ data: { v: 2 }, version: 2 }));
    await settle();
    expect(updates).toEqual([]);
    expect(statuses.at(-1)?.live).toBe(true);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(fetches.shift()!.have).toEqual({ haveVersion: 2, haveSince: 5 });
  });

  it('T14 (ruling 11): a change of the resolved entry fetches every watched pair exactly once on the new connection', async () => {
    const w = watcher();
    for (const p of ['p0', 'p1', 'p2']) { w.noteAnswer(G, p, 'p-b', 5); w.watch(G, p, 'web-ui-owner', 'BRAVO'); }
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    entry = 'postgres://bot@127.0.0.1/other';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients).toHaveLength(2);
    expect(clients[1].queries).toEqual(['LISTEN smdb_panel_changed']);
    const seen: string[] = [];
    while (fetches.length) { const x = fetches.shift()!; seen.push(x.p); x.done(ok()); await settle(); }
    expect(seen.sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('T14 (NB15-RUN-A): with no watch call and no count(), the watch ends, the listener closes and a notification for it starts no fetch', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    while (fetches.length) { fetches.shift()!.done(ok()); await settle(); }
    const first = clients[0];
    await vi.advanceTimersByTimeAsync(100_000);
    first.emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    await settle();
    expect(fetches, 'a notification for a watch that ended starts no fetch').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(w.listenerUp()).toBe(false);
    expect(clients).toHaveLength(1);
  });

  it('no member route registers a watch', () => {
    const guild = readSourceText(__dirname, '../../src/webui/routes/guildPanels.ts');
    expect(guild).not.toMatch(/watcherFor|panelLiveWatch|\/watch/);
  });
});

describe("the migration's session count (NB3)", () => {
  it("does not count 'smdb-webui-listen' and still counts 'smdb-webui-requests'", () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/utils/dataMigration.ts');
    expect(WEBUI_LISTEN_APP).toBe('smdb-webui-listen');
    expect(countsAsOther({ app: WEBUI_LISTEN_APP, own: true, kind: 'client backend' }, 'job-nb15-live')).toBe(false);
    expect(countsAsOther({ app: 'smdb-webui-requests', own: true, kind: 'client backend' }, 'job-nb15-live')).toBe(true);
    expect(src).not.toContain('smdb-webui-requests');
  });
});
