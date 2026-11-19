import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { mount, settle } from '../helpers/jsxRig';
import { restoreNoAnswerEnding } from '../../src/bot/internalSetup/utils/dataManager';

// NB14 decision 18 (wip-redesign/sheets/NB14.md, the panel part, with C2's toast): the Config tab's "Deleted data"
// list of a guild, its restore and the second confirm that replaces, restoreNextStep, and api.js's status and body on
// the Error it throws.

const require = createRequire(import.meta.url);
const PUBLIC = (rel: string) => fileURLToPath(new URL(`../../src/webui/public/${rel}`, import.meta.url));
const PANEL = PUBLIC('components/ConfigPanel.jsx');
const G1 = '111111111111111111';
const G2 = '222222222222222222';
const FILES = [{ id: 'x.json', name: 'X', category: 'data', moduleName: 'mod', exists: true }];
const WARNING = "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the restore. Check the disk, then restart the machine.";
const local = (ms: number) => new Date(ms).toLocaleString();

const graveyardRestore = () => require(PUBLIC('utils/graveyardRestore.js')) as {
  restoreNextStep: (status: unknown, body: unknown) => string;
  restoreDoneText: (deletedAt: number, body: any) => string;
  restoreNoAnswerEnding?: (guildId: string, x: number | undefined, n: number | undefined, replace: boolean) => string;
  restoreNoAnswerText?: (guildId: string, x: number, n: number | undefined, replace: boolean, message: string) => string;
};

/** api.js as index.html loads it, with fetch stubbed. */
function loadApi(fetchStub: (url: string, init?: any) => Promise<Response>): any {
  return new Function('fetch', `${fs.readFileSync(PUBLIC('utils/api.js'), 'utf-8')}\nreturn api;`)(fetchStub);
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('restoreNextStep', () => {
  it.each([
    ['200', 200, { success: true, retiredAt: 5 }, 'done'],
    ['409 live data', 409, { success: false, refusal: 'live-data', retiredAt: 5, error: 'x' }, 'confirm-replace'],
    ['409 without the fields', 409, { success: false, error: 'x' }, 'error'],
    ['409 with refusal and no number', 409, { success: false, refusal: 'live-data', retiredAt: '5', error: 'x' }, 'error'],
    ['503', 503, { success: false, error: 'x' }, 'error'],
    ['500', 500, { success: false, error: 'x' }, 'error'],
  ] as const)('%s answers %s', (_name, status, body, step) => {
    expect(graveyardRestore().restoreNextStep(status, body)).toBe(step);
  });
});

describe('api.js', () => {
  it('a 409 throws an Error with status and body, and restoreNextStep reads them', async () => {
    const body = { success: false, refusal: 'live-data', retiredAt: 5, error: 'server has data' };
    const api = loadApi(async () => jsonResponse(409, body));
    const err = await api.post('/data/graveyard/restore', { guildId: G1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('server has data');
    expect(err.status).toBe(409);
    expect(err.body.refusal).toBe('live-data');
    expect(graveyardRestore().restoreNextStep(err.status, err.body)).toBe('confirm-replace');
  });

  it.each(['get', 'put', 'delete'] as const)('%s attaches status and body too', async method => {
    const api = loadApi(async () => jsonResponse(503, { success: false, error: 'down' }));
    const err = await api[method]('/x', {}).catch((e: unknown) => e);
    expect(err.message).toBe('down');
    expect(err.status).toBe(503);
    expect(err.body).toEqual({ success: false, error: 'down' });
  });
});

describe('index.html', () => {
  it('loads graveyardRestore.js after api.js', () => {
    const html = fs.readFileSync(PUBLIC('index.html'), 'utf-8');
    const api = html.indexOf('<script src="/utils/api.js"></script>');
    const restore = html.indexOf('<script src="/utils/graveyardRestore.js"></script>');
    expect(api).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(api);
  });
});

describe('the done text', () => {
  const KEPT = 1_700_000_000_000;
  it('names the local date of keptUntil twice and the replaced entry', () => {
    const text = graveyardRestore().restoreDoneText(5000, { success: true, retiredAt: 5000, keptUntil: KEPT, replaced: { retiredAt: 9000, reason: 'replaced-by-restore-5000' } });
    expect(text).toBe(`Restored the data deleted on ${local(5000)}; that entry stays in this list until ${local(KEPT)}. The data it replaced is the entry of ${local(9000)} in this list. A module that kept the server's data in memory may save it again over the restored data; if that happens, restore this entry again with Replace before ${local(KEPT)}.`);
    expect(text.split(local(KEPT)).length - 1).toBe(2);
  });

  it('adds the no-reason clause when replaced has no reason', () => {
    const text = graveyardRestore().restoreDoneText(5000, { success: true, retiredAt: 5000, keptUntil: KEPT, replaced: { retiredAt: 9000 } });
    expect(text).toContain(`The data it replaced is the entry of ${local(9000)} in this list (listed without a reason: its note could not be written).`);
  });

  it('names no replaced entry for a plain restore or a replace of a server with no data', () => {
    for (const replaced of [undefined, null]) {
      const text = graveyardRestore().restoreDoneText(5000, { success: true, retiredAt: 5000, keptUntil: KEPT, ...(replaced === undefined ? {} : { replaced }) });
      expect(text).toBe(`Restored the data deleted on ${local(5000)}; that entry stays in this list until ${local(KEPT)}. A module that kept the server's data in memory may save it again over the restored data; if that happens, restore this entry again with Replace before ${local(KEPT)}.`);
    }
  });
});

interface Held { method: string; url: string; body?: any; done: boolean; answer: (v: any) => void; reject: (e: unknown) => void }

/** The api held until the test answers or rejects each call. */
function held() {
  const calls: Held[] = [];
  const make = (method: string) => (url: string, body?: any) => new Promise<any>((resolve, reject) => {
    const c: Held = { method, url, body, done: false, answer: v => { c.done = true; resolve(v); }, reject: e => { c.done = true; reject(e); } };
    calls.push(c);
  });
  return { calls, api: { get: make('GET'), post: make('POST'), put: make('PUT') } };
}

async function openDataView(confirms: boolean[]) {
  const { calls, api } = held();
  const toasts: Array<{ message: string; type: string; opts?: any }> = [];
  const asked: string[] = [];
  const { restoreNextStep, restoreDoneText, restoreNoAnswerText } = graveyardRestore();
  const panel = mount(PANEL, 'ConfigPanel', {}, {
    api,
    showToast: (message: string, type: string, opts?: any) => toasts.push({ message, type, ...(opts ? { opts } : {}) }),
    confirm: (q: string) => { asked.push(q); return confirms.shift() ?? false; },
    restoreNextStep,
    restoreDoneText,
    restoreNoAnswerText,
    FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
    disabledButtonStyle: () => ({}),
  });
  const pending = (re: RegExp) => calls.find(c => !c.done && re.test(c.url));
  const reply = async (re: RegExp, value: any) => {
    await settle();
    const c = pending(re);
    if (!c) throw new Error(`no call waits for ${re}; made: ${calls.map(x => `${x.method} ${x.url}${x.done ? ' (answered)' : ''}`).join(', ')}`);
    c.answer(value);
    await settle();
    return c;
  };
  const rejectWith = async (re: RegExp, error: unknown) => {
    await settle();
    const c = pending(re)!;
    c.reject(error);
    await settle();
    return c;
  };
  await reply(/^\/setup\/status$/, { success: true, guildIds: { GUILD_ID: G1, MAIN_GUILD_ID: G2 } });
  await reply(/^\/config\/list$/, { success: true, files: [] });
  const select = panel.selects()[0];
  const option = select.children.find((o: any) => panel.text(o).includes(G1)) as any;
  select.props.onChange({ target: { value: option.props.value } });
  await reply(new RegExp(`^/config/list\\?guildId=${G1}$`), { success: true, files: FILES });
  panel.button(/^Data Files$/)!.props.onClick();
  await reply(/^\/config\/data\/get\?/, { success: true, data: { v: 1 }, exists: true, sha: 'a'.repeat(64) });
  await reply(/^\/config\/backups\?/, { success: true, backups: [] });
  return { calls, panel, toasts, asked, reply, rejectWith };
}

const ENTRY = { guildId: G1, retiredAt: 5000, reason: 'webui-operator-delete', backend: 'file' };
const KEPT = 1_700_000_000_000;

describe('the Deleted data list', () => {
  it('reads the guild\'s entries from GET /data/graveyard?guildId= and lists each with its date and reason', async () => {
    const { panel, reply } = await openDataView([]);
    await reply(new RegExp(`^/data/graveyard\\?guildId=${G1}$`), { success: true, entries: [ENTRY, { ...ENTRY, retiredAt: 4000, reason: 'r2', rows: 3, backend: 'postgres' }] });
    const text = panel.text(panel.tree!);
    expect(text).toContain('Deleted data');
    expect(text).toContain(local(5000));
    expect(text).toContain('webui-operator-delete');
    expect(text).toContain(local(4000));
    expect(text).toContain('3 row(s)');
  });

  it('a restore of a guild with data asks again, replaces, and shows the done text; the lists reload', async () => {
    const { calls, panel, toasts, asked, reply, rejectWith } = await openDataView([true, true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY] });
    panel.button(/^Restore$/)!.props.onClick();
    await settle();
    expect(asked[0]).toBe(`Restore the data of guild ${G1} deleted on ${local(5000)}?`);
    const first = await rejectWith(/^\/data\/graveyard\/restore$/, Object.assign(new Error('server has data'), { status: 409, body: { success: false, refusal: 'live-data', retiredAt: 5000, error: 'server has data' } }));
    expect(first.body).toEqual({ guildId: G1, retiredAt: 5000 });
    expect(asked[1]).toBe(`Guild ${G1} has data saved since that delete. Replace it with the data deleted on ${local(5000)}? The current data moves to this list as a new entry, kept for the graveyard's keep time (14 days by default); nothing is merged.`);
    const listsBefore = calls.filter(c => /^\/data\/graveyard\?/.test(c.url) || /^\/config\/list\?/.test(c.url)).length;
    const second = await reply(/^\/data\/graveyard\/restore$/, { success: true, retiredAt: 5000, reason: 'webui-operator-delete', keptUntil: KEPT, replaced: { retiredAt: 9000, reason: 'replaced-by-restore-5000' } });
    expect(second.body).toEqual({ guildId: G1, retiredAt: 5000, replace: true });
    expect(toasts).toContainEqual({ message: graveyardRestore().restoreDoneText(5000, { keptUntil: KEPT, replaced: { retiredAt: 9000, reason: 'replaced-by-restore-5000' } }), type: 'success' });
    expect(calls.filter(c => /^\/data\/graveyard\?/.test(c.url) || /^\/config\/list\?/.test(c.url)).length).toBeGreaterThanOrEqual(listsBefore + 2);
  });

  it('the second confirm cancelled shows that nothing was restored', async () => {
    const { calls, toasts, panel, reply, rejectWith } = await openDataView([true, false]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY] });
    panel.button(/^Restore$/)!.props.onClick();
    await rejectWith(/^\/data\/graveyard\/restore$/, Object.assign(new Error('x'), { status: 409, body: { success: false, refusal: 'live-data', retiredAt: 5000, error: 'x' } }));
    expect(toasts).toContainEqual({ message: 'Nothing was restored', type: 'info' });
    expect(calls.filter(c => c.url === '/data/graveyard/restore')).toHaveLength(1);
  });

  it('an ok with a warning shows the done text and the warning in one sticky warning toast', async () => {
    const { toasts, panel, reply } = await openDataView([true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY] });
    panel.button(/^Restore$/)!.props.onClick();
    const body = { success: true, retiredAt: 5000, reason: 'webui-operator-delete', keptUntil: KEPT, warning: WARNING };
    await reply(/^\/data\/graveyard\/restore$/, body);
    expect(toasts).toContainEqual({ message: `${graveyardRestore().restoreDoneText(5000, body)} ${WARNING}`, type: 'warning', opts: { sticky: true } });
  });

  it('an error shows the route\'s text', async () => {
    const { toasts, panel, reply, rejectWith } = await openDataView([true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY] });
    panel.button(/^Restore$/)!.props.onClick();
    await rejectWith(/^\/data\/graveyard\/restore$/, Object.assign(new Error('no graveyard entry for this guild'), { status: 409, body: { success: false, error: 'no graveyard entry for this guild' } }));
    expect(toasts).toContainEqual({ message: 'no graveyard entry for this guild', type: 'error' });
  });

  it('the delete\'s confirm and note name the graveyard\'s keep time', async () => {
    const { panel, asked } = await openDataView([false]);
    expect(panel.text(panel.tree!)).toContain("Deleted data stays restorable for the graveyard's keep time (14 days by default).");
    panel.button(/Delete all data for this guild/)!.props.onClick();
    await settle();
    expect(asked[0]).toBe(`Delete ALL data for guild ${G1}? This removes every data file stored for this guild. Deleted data is kept restorable for the graveyard's keep time (14 days by default) before it is permanently removed.`);
  });
});

describe('a delete of all data', () => {
  it('reloads the Deleted data list, so a guild that had no entries shows its new one', async () => {
    const { calls, panel, reply } = await openDataView([true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [] });
    expect(panel.button(/^Restore$/)).toBeUndefined();
    panel.button(/Delete all data for this guild/)!.props.onClick();
    await reply(/^\/config\/data\/delete-guild$/, { success: true });
    await reply(new RegExp(`^/data/graveyard\\?guildId=${G1}$`), { success: true, entries: [ENTRY] });
    expect(calls.filter(c => c.url === `/data/graveyard?guildId=${G1}`)).toHaveLength(2);
    expect(panel.button(/^Restore$/)).toBeDefined();
    expect(panel.text(panel.tree!)).toContain(local(5000));
  });
});

describe('a restore with no answer', () => {
  const dropped = () => new TypeError('Failed to fetch');
  const gateway = () => new Error('Server returned non-JSON response (504): <html>Gateway Timeout</html>');

  it.each([
    ['fetch rejected', dropped],
    ['a gateway\'s non-JSON 504', gateway],
  ] as const)('a plain restore whose answer never came says it can\'t confirm, with the ending, and reloads the list (%s)', async (_name, failure) => {
    const { calls, toasts, panel, reply, rejectWith } = await openDataView([true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY, { ...ENTRY, retiredAt: 4000 }] });
    panel.button(/^Restore$/)!.props.onClick();
    const err = failure();
    await rejectWith(/^\/data\/graveyard\/restore$/, err);
    const text = `can't confirm whether server ${G1} was restored: the web panel got no answer (${err.message}). ${restoreNoAnswerEnding(G1, 5000, 5000, false)}`;
    expect(toasts.map(t => t.message)).toContain(text);
    expect(toasts.filter(t => t.type === 'error')).toEqual([]);
    expect(calls.filter(c => c.url === `/data/graveyard?guildId=${G1}`)).toHaveLength(2);
  });

  it('a replace whose answer never came names entries newer than the newest one the list showed', async () => {
    const { calls, toasts, panel, reply, rejectWith } = await openDataView([true, true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY, { ...ENTRY, retiredAt: 7000 }] });
    panel.button(/^Restore$/)!.props.onClick();
    await rejectWith(/^\/data\/graveyard\/restore$/, Object.assign(new Error('x'), { status: 409, body: { success: false, refusal: 'live-data', retiredAt: 5000, error: 'x' } }));
    await rejectWith(/^\/data\/graveyard\/restore$/, dropped());
    const text = `can't confirm whether server ${G1} was restored: the web panel got no answer (Failed to fetch). ${restoreNoAnswerEnding(G1, 5000, 7000, true)}`;
    expect(text).toContain('newer than 7000 whose reason is replaced-by-restore-5000 or empty');
    expect(toasts.map(t => t.message)).toContain(text);
    expect(calls.filter(c => c.url === `/data/graveyard?guildId=${G1}`)).toHaveLength(2);
  });

  it('an answer with a status is not a no-answer', async () => {
    const { toasts, panel, reply, rejectWith } = await openDataView([true]);
    await reply(/^\/data\/graveyard\?guildId=/, { success: true, entries: [ENTRY] });
    panel.button(/^Restore$/)!.props.onClick();
    await rejectWith(/^\/data\/graveyard\/restore$/, Object.assign(new Error('the bot is restarting'), { status: 503, body: { success: false, error: 'the bot is restarting' } }));
    expect(toasts).toEqual([{ message: 'the bot is restarting', type: 'error' }]);
  });

  it('api.js throws a non-JSON answer with no status, and restoreNextStep reads it as no answer', async () => {
    const api = loadApi(async () => new Response('<html>Gateway Timeout</html>', { status: 504, headers: { 'Content-Type': 'text/html' } }));
    const err = await api.post('/data/graveyard/restore', { guildId: G1 }).catch((e: unknown) => e);
    expect(typeof err.status).not.toBe('number');
    expect(graveyardRestore().restoreNextStep(err.status, err.body)).toBe('no-answer');
  });

  it('the panel\'s ending is restoreNoAnswerEnding\'s for every X, N and replace', () => {
    const { restoreNoAnswerEnding: panelEnding } = graveyardRestore();
    expect(typeof panelEnding).toBe('function');
    for (const x of [undefined, 100, 5000]) {
      for (const n of [undefined, 200, 5000]) {
        for (const replace of [true, false]) expect(panelEnding!(G1, x, n, replace)).toBe(restoreNoAnswerEnding(G1, x, n, replace));
      }
    }
  });
});
