import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// NB15 review round 4, the gatekeeper's rulings: the holder keeps an owner action's view as the pair's state under a
// new version (a); the web UI sends that view to every tab watching the pair and raises the pair's version only after
// the response finished, or after an aborted one only when a tab got the view (b); a web UI restart after an action
// gets the action's view (c); a kept answer of a re-claimed action changes nothing (d); sendPanelOp with a fake
// response (e).
import { sendPanelOp, type PanelOpSpec } from '../../src/webui/routes/panelRequestRoute';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetPanelLive, _setNotifyDb, liveAnswer, noteLiveChange, notifyTick, recordActionView, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { keptAnswer } from '../../src/bot/internalSetup/fleet/guildRequests';
import { LIVE_REASONS, PanelLiveWatch, _resetPanelLiveWatch, actionViewVersion, getPanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { setBackendKind } from '../helpers/backendKind';
import { GUILD, fakeTime, heldRow, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
const G = GUILD;
let rig: Rig;

class FakeListen extends EventEmitter {
  queries: string[] = [];
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: any) { super(); }
  connect() { return Promise.resolve(); }
  query(text: string) { this.queries.push(text); return Promise.resolve({ rows: [] }); }
  end() { return Promise.resolve(); }
}

interface Fetch { have: { haveVersion: number; haveSince: number | null }; done: (a: FetchAnswer) => void }

/** The web UI's watcher with two tabs: every update goes to both, and the status each tab shows is the last one sent. */
function twoTabs() {
  const fetches: Fetch[] = [];
  const tab = () => ({ shown: [] as unknown[], live: null as boolean | null, reason: null as string | null });
  const tabs = [tab(), tab()];
  let clients = 2;
  const deps: WatchDeps = {
    fetch: (_g, _p, _u, have) => new Promise(done => { fetches.push({ have, done }); }),
    emitUpdate: data => { for (const tab of tabs.slice(0, clients)) tab.shown.push(data.response); return clients; },
    emitStatus: data => { for (const each of tabs) { each.live = data.live; each.reason = data.reason; } },
    entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
    makeClient: config => new FakeListen(config) as any,
  };
  const w = getPanelLiveWatch(() => deps);
  return { w, fetches, tabs, setClients: (n: number) => { clients = n; } };
}

const ok = (over: Record<string, unknown> = {}): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: null, since: 5, version: 1, notifying: true, servedBy: 'BRAVO', ...over } });
const settle = () => vi.advanceTimersByTimeAsync(0);

async function livePair(t: ReturnType<typeof twoTabs>) {
  t.w.noteAnswer(G, 'p', 'p-b', 5, 1);
  t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
  await settle();
  while (t.fetches.length) { t.fetches.shift()!.done(ok()); await settle(); }
  expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
}

function fakeRes() {
  const r: any = new EventEmitter();
  r.writableFinished = false;
  r.statusCode = 0;
  r.body = null;
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (body: unknown) => { r.body = body; return r; };
  r.finish = () => { r.writableFinished = true; r.emit('finish'); r.emit('close'); };
  r.abort = () => { r.emit('close'); };
  return r;
}

function bot() {
  return {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async () => ({ success: false, code: 'not-held' }),
    emitPanelUpdate: () => 0,
    emitPanelLiveStatus: () => undefined,
  } as any;
}

const spec = (over: Partial<PanelOpSpec> = {}): PanelOpSpec => ({
  op: 'panel:button', guildId: G, payload: { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner' }, audience: 'owner', userId: 'web-ui-owner',
  success: reply => ({ panel: reply.data ?? null }), failureText: 'Failed to handle button', ...over,
});

/** The holder's answer the request route reads from the row. */
function holderAnswers(reply: Record<string, unknown>): void {
  rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL
    ? { rows: [], rowCount: 1 }
    : sql.includes('WHERE id = $1') && !sql.includes('AND state')
      ? { rows: [{ state: 'done', reply: JSON.stringify(reply), pickup_over: true, answer_over: false }] }
      : undefined);
}

const VIEW = { content: 'After the press' };

/** sendPanelOp to its end; the request route's follow runs on the fake clock. */
async function send(res: any, s: PanelOpSpec): Promise<void> {
  let done = false;
  const run = sendPanelOp(bot(), res, s).finally(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(50);
  await run;
}

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  _resetPanelLive();
  _resetPanelLiveWatch();
});
afterEach(() => {
  _resetPanelLiveWatch();
  _resetPanelLive();
  resetNb7();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R4 (b): an owner action's view goes to every tab watching the pair", () => {
  it('two tabs on one pair: one presses a button, both get the view, the pair stays live on both and its version is raised at finish', async () => {
    const t = twoTabs();
    await livePair(t);
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
    const res = fakeRes();
    await send(res, spec());
    expect(res.body).toMatchObject({ success: true, panel: VIEW, servedBy: 'BRAVO' });
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const early = t.fetches.shift()!;
    expect(early.have, 'not raised before the response finished').toEqual({ haveVersion: 1, haveSince: 5 });
    early.done(ok({ data: VIEW, version: 2 }));
    await settle();
    res.finish();
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const next = t.fetches.shift()!;
    expect(next.have).toEqual({ haveVersion: 2, haveSince: 5 });
    next.done(ok({ data: VIEW, version: 2 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown), 'no fetch sends the tabs a version they were sent').toEqual([[VIEW], [VIEW]]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
  });

  it('a response already finished when the answer is noted raises the version at once', async () => {
    const t = twoTabs();
    await livePair(t);
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
    const res = fakeRes();
    res.writableFinished = true;
    await send(res, spec());
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 2, haveSince: 5 });
  });

  it('an aborted response with no tab that got the view leaves the version; with a tab that got it, raises it', async () => {
    const t = twoTabs();
    await livePair(t);
    t.setClients(0);
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
    const lost = fakeRes();
    await send(lost, spec());
    lost.abort();
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const after = t.fetches.shift()!;
    expect(after.have).toEqual({ haveVersion: 1, haveSince: 5 });
    after.done(ok());
    await settle();
    t.setClients(1);
    const seen = fakeRes();
    await send(seen, spec());
    seen.abort();
    expect(t.tabs[0].shown).toEqual([VIEW]);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 2, haveSince: 5 });
  });

  it('a newer state the other tabs got before the answer reached its page is fetched again for that page', async () => {
    const t = twoTabs();
    await livePair(t);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    t.fetches.shift()!.done(ok({ data: { content: 'Newer' }, version: 3 }));
    await settle();
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
    const res = fakeRes();
    await send(res, spec());
    expect(t.tabs[1].shown, 'the other tabs keep the newer state').toEqual([{ content: 'Newer' }]);
    res.finish();
    await settle();
    const again = t.fetches.shift()!;
    expect(again.have).toEqual({ haveVersion: 2, haveSince: 5 });
    again.done(ok({ data: { content: 'Newer' }, version: 3 }));
    await settle();
    expect(t.tabs[0].shown.at(-1)).toEqual({ content: 'Newer' });
  });

  it('a member answer, a failure and an answer without liveSince note nothing', async () => {
    const t = twoTabs();
    await livePair(t);
    for (const [s, reply] of [
      [spec({ audience: 'member', userId: '1234567890' }), { success: true, data: VIEW }],
      [spec(), { success: false, error: 'no' }],
      [spec(), { success: true, data: VIEW }],
    ] as const) {
      holderAnswers(reply);
      const res = fakeRes();
      await send(res, s);
      res.finish();
    }
    expect(t.tabs.map(tab => tab.shown)).toEqual([[], []]);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 1, haveSince: 5 });
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
  });
});

describe('R5: the version the tabs were last sent', () => {
  it('a fetch answered with the older state before an action, resolved after its view was shared, never reaches a tab', async () => {
    const t = twoTabs();
    await livePair(t);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const stale = t.fetches.shift()!;
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 3 });
    const res = fakeRes();
    await send(res, spec());
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
    stale.done(ok({ data: { content: 'Older' }, version: 2 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown), 'the tabs keep the view').toEqual([[VIEW], [VIEW]]);
    expect(t.tabs.map(tab => tab.reason)).toEqual([LIVE_REASONS.updating, LIVE_REASONS.updating]);
    const refetch = t.fetches.shift()!;
    expect(refetch.have, 'fetched again at once, the stale answer changed nothing').toEqual({ haveVersion: 1, haveSince: 5 });
    res.finish();
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    refetch.done(ok({ data: VIEW, version: 3 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 3, haveSince: 5 });
  });

  it('R6: a late answer of the old holder after a move and an action on the new holder never reaches a tab', async () => {
    const t = twoTabs();
    await livePair(t);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const old = t.fetches.shift()!;
    const reply = { success: true, data: VIEW, liveSince: 7, liveVersion: 2, servedBy: 'CHARLIE' };
    expect(t.w.shareActionView(G, 'p', 'p-c', reply)).toBe(2);
    old.done(ok({ data: { content: 'Old holder' }, version: 2 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
    const refetch = t.fetches.shift()!;
    expect(refetch.have, 'the old answer changed nothing').toEqual({ haveVersion: 1, haveSince: 5 });
    t.w.noteAnswer(G, 'p', 'p-c', 7, 2);
    refetch.done({ ...ok({ data: VIEW, since: 7, version: 2, servedBy: 'CHARLIE' }), holderProcess: 'p-c' });
    await settle();
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
    expect(t.fetches).toHaveLength(0);
    t.w.watch(G, 'p', 'web-ui-owner', 'CHARLIE');
    await settle();
    const next = t.fetches.shift()!;
    expect(next.have, "the new holder's state is the pair's").toEqual({ haveVersion: 2, haveSince: 7 });
    next.done({ ...ok({ data: { content: 'Changed on CHARLIE' }, since: 7, version: 3, servedBy: 'CHARLIE' }), holderProcess: 'p-c' });
    await settle();
    expect(t.tabs.map(tab => tab.shown.at(-1))).toEqual([{ content: 'Changed on CHARLIE' }, { content: 'Changed on CHARLIE' }]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
  });

  it('a fetch sent after a share is shown as before', async () => {
    const t = twoTabs();
    await livePair(t);
    expect(t.w.shareActionView(G, 'p', 'p-b', { success: true, data: VIEW, liveSince: 5, liveVersion: 3, servedBy: 'BRAVO' })).toBe(2);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const after = t.fetches.shift()!;
    after.done(ok({ data: { content: 'Newer' }, version: 4 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW, { content: 'Newer' }], [VIEW, { content: 'Newer' }]]);
    expect(t.fetches).toHaveLength(0);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
  });

  it("an older action's view shared after a newer one never reaches a tab", () => {
    const t = twoTabs();
    t.w.noteAnswer(G, 'p', 'p-b', 5, 1);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    expect(t.w.shareActionView(G, 'p', 'p-b', { data: { content: 'Newer' }, liveSince: 5, liveVersion: 4, servedBy: 'BRAVO' })).toBe(2);
    expect(t.w.shareActionView(G, 'p', 'p-b', { data: VIEW, liveSince: 5, liveVersion: 3, servedBy: 'BRAVO' })).toBe(0);
    expect(t.tabs.map(tab => tab.shown)).toEqual([[{ content: 'Newer' }], [{ content: 'Newer' }]]);
  });

  it("opening a panel in one tab leaves another tab's view of that pair unchanged", async () => {
    const t = twoTabs();
    await livePair(t);
    const drawn = { success: true, data: VIEW, liveSince: 5, liveVersion: 2 };
    holderAnswers(drawn);
    const res = fakeRes();
    await send(res, spec({ op: 'panel:execute', payload: { panelId: 'p', userId: 'web-ui-owner' } }));
    expect(res.body).toMatchObject({ success: true, panel: VIEW });
    res.finish();
    await settle();
    expect(t.tabs.map(tab => tab.shown), "a view above the pair's version, kept from the tabs by the route").toEqual([[], []]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 1, haveSince: 5 });
    expect(t.w.shareActionView(G, 'p', 'p-b', { ...drawn, servedBy: 'BRAVO' }), 'the watcher alone would have sent it').toBe(2);
  });

  it("opening a panel no tab watches yet starts the watch at the version it was drawn after", async () => {
    const t = twoTabs();
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
    const res = fakeRes();
    await send(res, spec({ op: 'panel:execute', payload: { panelId: 'p', userId: 'web-ui-owner' } }));
    res.finish();
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    const first = t.fetches.shift()!;
    expect(first.have).toEqual({ haveVersion: 2, haveSince: 5 });
    first.done(ok({ data: { content: 'Kept' }, version: 2 }));
    await settle();
    expect(t.tabs.map(tab => tab.shown), 'the kept state from before the panel was drawn is not sent').toEqual([[], []]);
  });
});

describe('R7: an answer to a request sent before the latest apply applies nothing', () => {
  const ON_C = { content: 'On CHARLIE' };
  const fromC = (over: Record<string, unknown>): FetchAnswer => ({ ...ok({ since: 7, servedBy: 'CHARLIE', ...over }), holderProcess: 'p-c' });
  const holderIsC = () => { rig.holder = () => ({ rows: [heldRow({ holder_process: 'p-c', node_process_id: 'p-c', holder_node: 'n-c', holder_name: 'CHARLIE' })] }); };
  const updating = [LIVE_REASONS.updating, LIVE_REASONS.updating];

  /** The holder's answer, read only once released: until then the row says the holder runs it. */
  function gatedAnswer(reply: Record<string, unknown>): () => void {
    let ready = false;
    rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL
      ? { rows: [], rowCount: 1 }
      : sql.includes('WHERE id = $1') && !sql.includes('AND state')
        ? { rows: [ready ? { state: 'done', reply: JSON.stringify(reply), pickup_over: true, answer_over: false } : { state: 'applying', reply: null, pickup_over: true, answer_over: false }] }
        : undefined);
    return () => { ready = true; };
  }

  function start(res: any): { run: Promise<void>; finished: () => boolean } {
    let done = false;
    const run = sendPanelOp(bot(), res, spec()).finally(() => { done = true; });
    return { run, finished: () => done };
  }

  async function drive(h: { run: Promise<void>; finished: () => boolean }): Promise<void> {
    for (let i = 0; i < 100 && !h.finished(); i++) await vi.advanceTimersByTimeAsync(50);
    await h.run;
  }

  describe("an old holder's late fetch answer after the new holder's action view", () => {
    async function setup(clients = 2) {
      const t = twoTabs();
      await livePair(t);
      t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      const old = t.fetches.shift()!;
      holderIsC();
      t.setClients(clients);
      holderAnswers({ success: true, data: VIEW, liveSince: 7, liveVersion: 2 });
      const res = fakeRes();
      await send(res, spec());
      expect(res.body).toMatchObject({ success: true, panel: VIEW, servedBy: 'CHARLIE' });
      old.done(ok({ data: { content: 'Old holder' }, version: 2 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown), 'the late answer reaches no tab').toEqual(clients ? [[VIEW], [VIEW]] : [[], []]);
      expect(t.tabs.map(tab => tab.reason), 'not live while the refetch is pending').toEqual(updating);
      const refetch = t.fetches.shift()!;
      expect(refetch.have, 'the late answer changed nothing').toEqual({ haveVersion: 1, haveSince: 5 });
      expect(t.fetches).toHaveLength(0);
      return { t, res, refetch };
    }

    async function ends(t: ReturnType<typeof twoTabs>) {
      expect(t.tabs.map(tab => tab.shown.at(-1))).toEqual([VIEW, VIEW]);
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      expect(t.fetches).toHaveLength(0);
      t.w.watch(G, 'p', 'web-ui-owner', 'CHARLIE');
      await settle();
      expect(t.fetches.shift()!.have, "the new holder's state is the pair's").toEqual({ haveVersion: 2, haveSince: 7 });
    }

    it('the response finishes, then the refetch is answered', async () => {
      const { t, res, refetch } = await setup();
      res.finish();
      expect(t.tabs.map(tab => tab.reason)).toEqual(updating);
      refetch.done(fromC({ data: VIEW, version: 2 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
      await ends(t);
    });

    it('the refetch is answered, then the response finishes', async () => {
      const { t, res, refetch } = await setup();
      refetch.done(fromC({ data: VIEW, version: 2 }));
      await settle();
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      res.finish();
      await settle();
      expect(t.tabs.map(tab => tab.shown), 'no tab is sent the view twice').toEqual([[VIEW], [VIEW]]);
      await ends(t);
    });

    it('the response is aborted with no tab that got the view: the refetch shows the new state', async () => {
      const { t, res, refetch } = await setup(0);
      res.abort();
      t.setClients(2);
      refetch.done(fromC({ data: VIEW, version: 2 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
      await ends(t);
    });
  });

  describe("an old holder's late action answer after the new holder's fetched state", () => {
    async function setup(clients = 2) {
      const t = twoTabs();
      await livePair(t);
      const release = gatedAnswer({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
      const res = fakeRes();
      const h = start(res);
      await vi.advanceTimersByTimeAsync(50);
      t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      t.fetches.shift()!.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[ON_C], [ON_C]]);
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      expect(h.finished()).toBe(false);
      t.setClients(clients);
      release();
      await drive(h);
      expect(res.body, "the pressing tab still gets its action's answer").toMatchObject({ success: true, panel: VIEW, servedBy: 'BRAVO' });
      expect(t.tabs.map(tab => tab.shown), 'the older view reaches no tab').toEqual([[ON_C], [ON_C]]);
      expect(t.tabs.map(tab => tab.reason)).toEqual(updating);
      const refetch = t.fetches.shift()!;
      expect(refetch.have, "the refetch asks for the holder's whole state").toEqual({ haveVersion: 0, haveSince: null });
      expect(t.fetches).toHaveLength(0);
      t.setClients(2);
      return { t, res, refetch };
    }

    async function ends(t: ReturnType<typeof twoTabs>) {
      expect(t.tabs.map(tab => tab.shown.at(-1)), 'every tab, the pressing one included, shows the newest state').toEqual([ON_C, ON_C]);
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      expect(t.fetches).toHaveLength(0);
      t.w.watch(G, 'p', 'web-ui-owner', 'CHARLIE');
      await settle();
      expect(t.fetches.shift()!.have, "the pair stays on the new holder's state").toEqual({ haveVersion: 1, haveSince: 7 });
    }

    it('the response finishes, then the refetch is answered', async () => {
      const { t, res, refetch } = await setup();
      res.finish();
      await settle();
      expect(t.fetches, 'the pending refetch serves the pressing tab too').toHaveLength(0);
      refetch.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[ON_C, ON_C], [ON_C, ON_C]]);
      await ends(t);
    });

    it('the refetch is answered, then the response finishes: fetched again for the pressing tab', async () => {
      const { t, res, refetch } = await setup();
      refetch.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      res.finish();
      await settle();
      expect(t.tabs.map(tab => tab.reason)).toEqual(updating);
      const again = t.fetches.shift()!;
      expect(again.have).toEqual({ haveVersion: 0, haveSince: null });
      again.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[ON_C, ON_C, ON_C], [ON_C, ON_C, ON_C]]);
      await ends(t);
    });

    it('the response is aborted: the refetch alone brings every tab to the newest state', async () => {
      const { t, res, refetch } = await setup(0);
      res.abort();
      await settle();
      expect(t.fetches).toHaveLength(0);
      refetch.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      await ends(t);
    });

    it("the view accepted on arrival, the new holder's state applied before the finish: the pair keeps the new holder", async () => {
      const t = twoTabs();
      await livePair(t);
      holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
      const res = fakeRes();
      await send(res, spec());
      expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW], [VIEW]]);
      t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      t.fetches.shift()!.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[VIEW, ON_C], [VIEW, ON_C]]);
      res.finish();
      await settle();
      expect(t.tabs.map(tab => tab.reason)).toEqual(updating);
      const again = t.fetches.shift()!;
      expect(again.have, 'the older answer did not move the pair back').toEqual({ haveVersion: 0, haveSince: null });
      again.done(fromC({ data: ON_C, version: 1 }));
      await settle();
      await ends(t);
    });
  });

  it('an action sent after a fetched state was applied is shown as before', async () => {
    const t = twoTabs();
    await livePair(t);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    t.fetches.shift()!.done(ok({ data: { content: 'Newer' }, version: 2 }));
    await settle();
    holderAnswers({ success: true, data: VIEW, liveSince: 5, liveVersion: 3 });
    const res = fakeRes();
    await send(res, spec());
    expect(t.tabs.map(tab => tab.shown)).toEqual([[{ content: 'Newer' }, VIEW], [{ content: 'Newer' }, VIEW]]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
    expect(t.fetches).toHaveLength(0);
    res.finish();
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 3, haveSince: 5 });
  });

  describe('a state of the same holder applied after the request was sent', () => {
    const NEWER = { content: 'Newer' };

    async function order(s: PanelOpSpec) {
      const t = twoTabs();
      await livePair(t);
      const release = gatedAnswer({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 });
      const res = fakeRes();
      let done = false;
      const run = sendPanelOp(bot(), res, s).finally(() => { done = true; });
      await vi.advanceTimersByTimeAsync(50);
      t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      t.fetches.shift()!.done(ok({ data: NEWER, version: 3 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown)).toEqual([[NEWER], [NEWER]]);
      expect(done).toBe(false);
      release();
      await drive({ run, finished: () => done });
      expect(res.body, 'the requesting tab still gets its answer').toMatchObject({ success: true, panel: VIEW, servedBy: 'BRAVO' });
      expect(t.tabs.map(tab => tab.shown), 'the older view reaches no tab').toEqual([[NEWER], [NEWER]]);
      res.finish();
      await settle();
      expect(t.tabs.map(tab => tab.reason), 'not live until the refetch is applied').toEqual(updating);
      const refetch = t.fetches.shift()!;
      expect(refetch.have, 'the refetch asks for the whole state').toEqual({ haveVersion: 0, haveSince: null });
      expect(t.fetches).toHaveLength(0);
      refetch.done(ok({ data: NEWER, version: 3 }));
      await settle();
      expect(t.tabs.map(tab => tab.shown.at(-1)), 'every tab, the requesting one included, shows the newest state').toEqual([NEWER, NEWER]);
      expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
      expect(t.fetches).toHaveLength(0);
      t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
      await settle();
      expect(t.fetches.shift()!.have).toEqual({ haveVersion: 3, haveSince: 5 });
    }

    it('an action answer is refused and the pair fetched again', async () => {
      await order(spec());
    });

    it('an open answer leaves the opening tab on the newest state once the refetch is applied', async () => {
      await order(spec({ op: 'panel:execute', payload: { panelId: 'p', userId: 'web-ui-owner' } }));
    });
  });
});

describe('R4 (d): the kept answer of a re-claimed action', () => {
  it("leaves the pair's status and version unchanged: no view came with it", async () => {
    const t = twoTabs();
    await livePair(t);
    holderAnswers({ ...keptAnswer({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 }), servedBy: 'BRAVO' });
    const res = fakeRes();
    await send(res, spec());
    res.finish();
    expect(t.tabs.map(tab => tab.shown)).toEqual([[], []]);
    expect(t.tabs.map(tab => tab.live)).toEqual([true, true]);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    expect(t.fetches.shift()!.have).toEqual({ haveVersion: 1, haveSince: 5 });
  });

  it('on a pair marked missed it stays missed, and liveSince null on it says nothing of too many panels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = twoTabs();
    await livePair(t);
    t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    t.fetches.shift()!.done(ok({ since: 9 }));
    await settle();
    const missed = { live: false, reason: LIVE_REASONS.notFetched };
    expect(t.tabs.map(tab => tab.live)).toEqual([false, false]);
    for (const since of [9, null]) {
      holderAnswers({ ...keptAnswer({ success: true, data: VIEW, liveSince: since, liveVersion: 0 }), servedBy: 'BRAVO' });
      const res = fakeRes();
      await send(res, spec());
      res.finish();
    }
    expect(t.w.watch(G, 'p', 'web-ui-owner', 'BRAVO')).toEqual(missed);
  });

  it('actionViewVersion: only a view with a liveSince and a positive liveVersion counts', () => {
    expect(actionViewVersion({ data: VIEW, liveSince: 5, liveVersion: 2 })).toBe(2);
    expect(actionViewVersion(keptAnswer({ success: true, data: VIEW, liveSince: 5, liveVersion: 2 }))).toBe(0);
    expect(actionViewVersion({ data: { modal: {} }, liveSince: 5, liveVersion: 2 })).toBe(0);
    expect(actionViewVersion({ data: VIEW, liveSince: null, liveVersion: 2 })).toBe(0);
    expect(actionViewVersion({ data: VIEW, liveVersion: 2 })).toBe(0);
  });
});

describe('R4 (c): a web UI restart after an owner action', () => {
  it("the new pair's first fetch gets the action's view, never the older state", async () => {
    const since = registerInterest(G, 'p')!;
    _setNotifyDb({ notify: async () => undefined });
    await notifyTick();
    noteLiveChange(G, 'p', { content: 'Before' });
    const version = recordActionView(G, 'p', since, { success: true, data: VIEW });
    expect(version).toBe(2);
    const shown: unknown[] = [];
    const deps: WatchDeps = {
      fetch: async (g, p, _u, have) => ({ status: null, holderProcess: 'p-b', reply: { ...liveAnswer(g, p, registerInterest(g, p), have.haveVersion, have.haveSince), servedBy: 'BRAVO' } }),
      emitUpdate: data => { shown.push(data.response); return 1; },
      emitStatus: () => undefined,
      entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
      makeClient: config => new FakeListen(config) as any,
    };
    const restarted = new PanelLiveWatch(deps);
    restarted.watch(G, 'p', 'web-ui-owner', 'BRAVO');
    await settle();
    await settle();
    expect(shown).toEqual([VIEW]);
    expect(restarted.watch(G, 'p', 'web-ui-owner', 'BRAVO')).toEqual({ live: true, reason: null });
    await settle();
    expect(shown, 'shown once').toEqual([VIEW]);
    restarted.stop();
  });

  it('recordActionView keeps nothing for another interest, a modal, a refusal or an unwatched pair', () => {
    expect(recordActionView(G, 'p', 1, { success: true, data: VIEW })).toBeNull();
    const since = registerInterest(G, 'p')!;
    expect(recordActionView(G, 'p', since + 1, { success: true, data: VIEW })).toBeNull();
    expect(recordActionView(G, 'p', since, { success: true, data: { modal: {} } })).toBeNull();
    expect(recordActionView(G, 'p', since, { success: false, data: VIEW })).toBeNull();
    expect(liveAnswer(G, 'p', since)).toEqual({ success: true, data: null, since, version: 0, notifying: null });
  });
});
