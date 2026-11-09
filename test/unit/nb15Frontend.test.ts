import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount, settle, type El } from '../helpers/jsxRig';

// NB15 test 9 (jsxRig): the front end of a server another machine runs. PanelsPanel's served-by line, its watch call
// at show and every 60 s until the panel closes, 'panel:updated' with servedBy, the out-of-date line from the shown
// pair's 'panel:live_status', a note in place of a panel, the list's guildId; GuildPanelsPanel's note; guildFetch's
// redirect only for 'guild-webui-disabled'; GuildSelector's notice.

const PUBLIC = path.resolve(__dirname, '../../src/webui/public');
const TEST_GUILD = '111111111111111111';
const MAIN_GUILD = '222222222222222222';

interface Call { method: 'GET' | 'POST'; url: string; body?: any }

function fakeWs() {
  const subs = new Map<string, Set<(data: any) => void>>();
  return {
    on(event: string, fn: (data: any) => void) {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event)!.add(fn);
      return () => { subs.get(event)!.delete(fn); };
    },
    emit(event: string, data: any) { for (const fn of [...(subs.get(event) ?? [])]) fn(data); },
    count: (event: string) => subs.get(event)?.size ?? 0,
  };
}

function panelsRig(answers: Partial<Record<string, (body?: any) => any>> = {}) {
  const calls: Call[] = [];
  const viewer: { props: any } = { props: null };
  const answer = (method: 'GET' | 'POST', url: string, body?: any) => {
    calls.push({ method, url, body });
    const route = url.split('?')[0];
    const scripted = answers[route];
    if (scripted) return Promise.resolve(scripted(body));
    if (route === '/setup/status') return Promise.resolve({ success: true, guildIds: { GUILD_ID: TEST_GUILD, MAIN_GUILD_ID: MAIN_GUILD } });
    if (route === '/panels/list') return Promise.resolve({ success: true, panels: [{ id: 'p', name: 'Panel P', scope: 'guild' }] });
    if (route === '/panels/execute') return Promise.resolve({ success: true, panel: { embeds: [{ title: 'first' }] }, servedBy: 'BRAVO' });
    if (route === '/panels/watch') return Promise.resolve({ success: true, live: true, reason: null });
    return Promise.resolve({ success: true });
  };
  const api = { get: (url: string) => answer('GET', url), post: (url: string, body?: any) => answer('POST', url, body) };
  const ws = fakeWs();
  const PanelViewer = (props: any) => {
    viewer.props = props;
    return { type: 'panel-viewer', props: {}, children: [] };
  };
  const m = mount(path.join(PUBLIC, 'components/PanelsPanel.jsx'), 'PanelsPanel', {}, { api, wsClient: ws, PanelViewer });
  const text = () => (m.tree ? m.text(m.tree) : '');
  const watchCalls = () => calls.filter(c => c.url === '/panels/watch');
  const outOfDate = () => m.all((el: El) => el.props.className === 'panel-out-of-date').map(el => m.text(el));
  return { m, calls, api, ws, viewer, text, watchCalls, outOfDate };
}

async function chooseContext(r: ReturnType<typeof panelsRig>, value: string) {
  const select = r.m.selects()[0];
  select.props.onChange({ target: { value } });
  await settle();
}

async function openPanel(r: ReturnType<typeof panelsRig>) {
  await settle();
  await chooseContext(r, 'test');
  const button = r.m.all((el: El) => el.type === 'button' && r.m.text(el).includes('Panel P'))[0];
  expect(button, 'the guild panel button').toBeDefined();
  button.props.onClick();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PanelsPanel', () => {
  it('sends the context\'s guildId with the list, and reloads the list on a context change', async () => {
    const r = panelsRig();
    await settle();
    const lists = () => r.calls.filter(c => c.url.startsWith('/panels/list')).map(c => c.url);
    expect(lists()[lists().length - 1]).toBe('/panels/list');
    await chooseContext(r, 'test');
    expect(lists()[lists().length - 1]).toBe(`/panels/list?guildId=${TEST_GUILD}`);
    await chooseContext(r, 'main');
    expect(lists()[lists().length - 1]).toBe(`/panels/list?guildId=${MAIN_GUILD}`);
  });

  it('shows the served-by line and sends the watch call when it shows such a panel, then every 60 s', async () => {
    const r = panelsRig();
    await openPanel(r);
    expect(r.viewer.props.panelData).toEqual({ embeds: [{ title: 'first' }] });
    expect(r.text()).toContain('This server runs on BRAVO.');
    expect(r.watchCalls()).toHaveLength(1);
    expect(r.watchCalls()[0].body).toMatchObject({ guildId: TEST_GUILD, panelId: 'p' });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.watchCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.watchCalls()).toHaveLength(3);
  });

  it('sends no watch call for a panel this machine runs (no servedBy)', async () => {
    const r = panelsRig({ '/panels/execute': () => ({ success: true, panel: { embeds: [] } }) });
    await openPanel(r);
    expect(r.text()).not.toContain('This server runs on');
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(r.watchCalls()).toHaveLength(0);
  });

  it('stops the watch calls when the panel closes, and when the page leaves', async () => {
    const r = panelsRig();
    await openPanel(r);
    r.viewer.props.onBack();
    await settle();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(r.watchCalls()).toHaveLength(1);

    const s = panelsRig();
    await openPanel(s);
    s.m.unmount();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(s.watchCalls()).toHaveLength(1);
    expect(s.ws.count('panel:live_status')).toBe(0);
  });

  it('applies a panel:updated event that carries servedBy', async () => {
    const r = panelsRig();
    await openPanel(r);
    r.ws.emit('panel:updated', { panelId: 'p', guildId: TEST_GUILD, panel: { embeds: [{ title: 'second' }] }, servedBy: 'CHARLIE' });
    await settle();
    expect(r.viewer.props.panelData).toEqual({ embeds: [{ title: 'second' }] });
    expect(r.text()).toContain('This server runs on CHARLIE.');
  });

  it('shows the out-of-date line on the shown pair\'s live_status false with its reason, removes it on true, and ignores another pair', async () => {
    const r = panelsRig();
    await openPanel(r);
    expect(r.outOfDate()).toEqual([]);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'other', live: false, reason: 'x' });
    r.ws.emit('panel:live_status', { guildId: MAIN_GUILD, panelId: 'p', live: false, reason: 'x' });
    await settle();
    expect(r.outOfDate()).toEqual([]);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'p', live: false, reason: 'BRAVO cannot announce its changes right now' });
    await settle();
    expect(r.outOfDate()).toEqual(['This panel may be out of date: changes made on BRAVO are not shown here by themselves right now (BRAVO cannot announce its changes right now). It updates when you use it.']);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'p', live: true, reason: null });
    await settle();
    expect(r.outOfDate()).toEqual([]);
  });

  it('shows the watch answer\'s reason when the first watch call answers live false', async () => {
    const r = panelsRig({ '/panels/watch': () => ({ success: true, live: false, reason: 'too many panels from other machines are open' }) });
    await openPanel(r);
    expect(r.outOfDate()).toEqual(['This panel may be out of date: changes made on BRAVO are not shown here by themselves right now (too many panels from other machines are open). It updates when you use it.']);
  });

  it('R11: the watch answer\'s checking and a live_status checking show the checking line in place of the out-of-date line', async () => {
    const CHECKING = 'Checking whether changes made on BRAVO are shown here by themselves.';
    const r = panelsRig({ '/panels/watch': () => ({ success: true, live: false, reason: null, checking: true }) });
    const checking = () => r.m.all((el: El) => el.props.className === 'panel-live-checking').map(el => r.m.text(el));
    await openPanel(r);
    expect(checking()).toEqual([CHECKING]);
    expect(r.outOfDate()).toEqual([]);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'p', live: false, reason: 'BRAVO cannot announce its changes right now' });
    await settle();
    expect(checking()).toEqual([]);
    expect(r.outOfDate()).toHaveLength(1);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'p', live: false, reason: null, checking: true });
    await settle();
    expect(checking()).toEqual([CHECKING]);
    expect(r.outOfDate(), 'the checking line replaces the out-of-date line').toEqual([]);
    r.ws.emit('panel:live_status', { guildId: TEST_GUILD, panelId: 'p', live: true, reason: null });
    await settle();
    expect(checking()).toEqual([]);
    expect(r.outOfDate()).toEqual([]);
  });

  it('shows a note in place of a panel: null answer', async () => {
    const note = 'On BRAVO: the panel action ran and its changes were saved; the panel it returned is 300 KiB, too large to show here. Open the panel from the web panel on BRAVO.';
    const r = panelsRig({ '/panels/execute': () => ({ success: true, panel: null, note, servedBy: 'BRAVO' }) });
    await openPanel(r);
    const notes = r.m.all((el: El) => el.props.className === 'panel-note').map(el => r.m.text(el));
    expect(notes).toEqual([note]);
    expect(r.viewer.props).toBeNull();
  });
});

describe('GuildPanelsPanel', () => {
  it('shows a note in place of a panel', async () => {
    const note = 'The panel action ran and its changes were saved, but its result cannot be shown here. Do not run it again; check the result in Discord.';
    const guildApi = {
      getPanelList: async () => ({ success: true, panels: [{ id: 'p', name: 'Panel P', scope: 'guild' }] }),
      getChannels: async () => ({ success: true, channels: [] }),
      executePanel: async () => ({ success: true, panel: null, note }),
    };
    const PanelViewer = () => ({ type: 'panel-viewer', props: {}, children: [] });
    const list: { props: any } = { props: null };
    const PanelList = (props: any) => { list.props = props; return { type: 'panel-list', props: {}, children: [] }; };
    const m = mount(path.join(PUBLIC, 'assets/components/guild/GuildPanelsPanel.jsx'), 'GuildPanelsPanel', { guild: { id: TEST_GUILD, name: 'G' }, user: { id: '1' }, onBack: () => undefined }, { guildApi, PanelViewer, PanelList });
    await settle();
    expect(list.props?.panels).toEqual([{ id: 'p', name: 'Panel P', scope: 'guild' }]);
    list.props.onSelectPanel('p');
    await settle();
    const shown = m.all((el: El) => el.props.className === 'panel-note')[0];
    expect(shown, 'the note block').toBeDefined();
    expect(m.all((el: El) => el.type === 'p', shown).map(el => m.text(el))).toEqual([note]);
  });
});

describe('guildFetch', () => {
  function loadGuildApi(status: number, body: unknown) {
    const source = fs.readFileSync(path.join(PUBLIC, 'assets/utils/guildApi.js'), 'utf-8');
    const window = { location: { href: '/guild/panels' } };
    const response = { status, ok: status < 400, json: async () => body, clone: () => response };
    const fetch = vi.fn(async () => response);
    const out = new Function('fetch', 'window', `${source}\nreturn { guildFetch, guildApi };`)(fetch, window);
    return { ...out, window, fetch };
  }

  it('redirects for a 503 with code guild-webui-disabled', async () => {
    const g = loadGuildApi(503, { success: false, code: 'guild-webui-disabled', error: 'off' });
    await expect(g.guildFetch('/guild/api/panels/list')).rejects.toThrow('Guild Web-UI is disabled');
    expect(g.window.location.href).toBe('/guild');
  });

  it('shows the text of any other 503 and does not redirect', async () => {
    const error = "This server's bot is restarting or not running right now; nothing was run. Try again in a moment.";
    const g = loadGuildApi(503, { success: false, code: 'no-holder', error });
    const result = await g.guildApi.getGuilds();
    expect(result).toEqual({ success: false, code: 'no-holder', error });
    expect(g.window.location.href).toBe('/guild/panels');
  });

  it('a 503 whose body is not JSON does not redirect either', async () => {
    const g = loadGuildApi(503, null);
    const response = { status: 503, ok: false, json: async () => { throw new Error('not json'); }, clone: () => response };
    g.fetch.mockResolvedValueOnce(response as any);
    await expect(g.guildFetch('/guild/api/panels/guilds')).resolves.toBe(response);
    expect(g.window.location.href).toBe('/guild/panels');
  });
});

describe('GuildSelector', () => {
  function selector(result: any) {
    const guildApi = { getGuilds: async () => result, logout: async () => ({ success: true }) };
    const window = { location: { pathname: '/guild', search: '', reload: () => undefined } };
    const m = mount(path.join(PUBLIC, 'assets/components/guild/GuildSelector.jsx'), 'GuildSelector', { user: { id: '1', username: 'u' }, onGuildSelected: () => undefined, onLogout: () => undefined }, { guildApi, window });
    return m;
  }
  const notices = (m: ReturnType<typeof mount>) => m.all((el: El) => el.props.className === 'guild-selector-notice').map(el => m.text(el));

  it.each([
    'Some servers may be missing: a bot that runs them did not answer; reload to try again.',
    'This machine\'s bot is starting; its servers are listed once it is ready.',
  ])('shows the notice %s beside the list', async notice => {
    const m = selector({ success: true, guilds: [{ id: TEST_GUILD, name: 'G', icon: null }], notice });
    await settle();
    expect(notices(m)).toEqual([notice]);
  });

  it('shows the notice on the empty list too, and none when the answer has none', async () => {
    const m = selector({ success: true, guilds: [], notice: 'Some servers may be missing.' });
    await settle();
    expect(notices(m)).toEqual(['Some servers may be missing.']);
    const n = selector({ success: true, guilds: [{ id: TEST_GUILD, name: 'G', icon: null }] });
    await settle();
    expect(notices(n)).toEqual([]);
  });
});
