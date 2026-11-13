import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pass: 0,
  left: (_pass: number): any => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 }),
  ws: null as null | {
    heldGuilds: () => Array<{ guildId: string; reason: string | null; code: string | null }>;
    unansweredGuilds: () => { all: string[]; only: string[] };
    resaveGuilds: () => string[];
    takeDropLines: () => string[];
  },
  rowOps: 0,
  filePaths: [] as string[],
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: async () => { h.pass += 1; return h.left(h.pass); },
  unansweredRowOps: () => h.rowOps,
  unsavedRowPaths: () => [],
  resaveTarget: () => 'the main database',
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<any>()),
  getWorkingSet: () => h.ws,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  unsavedFilePaths: () => h.filePaths,
}));

import {
  _resetMaintenance, _setMaintenanceSender, _setMaintenanceTiming, heldForContent, leaveRestartAsked, maintenanceUnfit,
  retireForReshard, startLeave, watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';

const sent: any[] = [];
const logs: string[] = [];

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  logs.length = 0;
  Object.assign(h, { pass: 0, rowOps: 0, filePaths: [], ws: null });
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 5, filePollMs: 600_000, restartResendMs: 60_000, leaveSaveBoundMs: 50, heldAfterPasses: 1 });
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

type Guild = { guildId: string; reason: string | null; code: string | null };
function workingSet(opts: { held?: Guild[]; only?: (pass: number) => string[]; resave?: (pass: number) => string[] } = {}) {
  h.ws = {
    heldGuilds: () => opts.held ?? [],
    unansweredGuilds: () => {
      const only = opts.only?.(h.pass) ?? [];
      return { all: only, only };
    },
    resaveGuilds: () => opts.resave?.(h.pass) ?? [],
    takeDropLines: () => [],
  };
}
const counts = (extra: Record<string, number>) => () => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, ...extra });

const retries = () => logs.filter(l => l.includes('tries again in')).length;
const heldLines = () => logs.filter(l => l.startsWith('[Maintenance] ') && l.includes(' saves in a row left '));
const restartSent = () => sent.some(m => m.type === 'control:restart-bot');

async function leaveFor(passes: number): Promise<void> {
  startLeave('The hook says running');
  await vi.waitFor(() => { if (retries() < passes && !restartSent()) throw new Error('waiting for passes'); }, { timeout: 2000, interval: 2 });
}

async function firstHeld(): Promise<string> {
  await leaveFor(1);
  expect(heldLines().length).toBeGreaterThan(0);
  return heldLines()[0];
}

const backend = (extra: Record<string, unknown> = {}) => ({
  onLoginRefused: () => undefined,
  askDatabase: async () => 'answers' as const,
  refusesByOwnState: () => true,
  ...extra,
});

describe('rk9 the hand-over end asks once and keeps asking with its attempt', () => {
  it('rk9 a second retire is not sent, the process counts as restarting, and the re-send carries the attempt', async () => {
    _setMaintenanceTiming({ restartResendMs: 10 });
    retireForReshard('att-1', 'Resharding to 8 shards');
    expect(sent).toEqual([{ type: 'control:reshard-retire', data: { attempt: 'att-1' } }]);
    expect(maintenanceUnfit()).toBe('restarting');
    expect(leaveRestartAsked()).toBe(true);
    retireForReshard('att-2', 'Resharding again');
    expect(sent).toHaveLength(1);
    expect(logs.filter(l => l.includes('asking the web UI process to stop this bot process'))).toHaveLength(1);
    await vi.waitFor(() => { if (sent.length < 2) throw new Error('no re-send yet'); }, { timeout: 2000, interval: 2 });
    expect(sent[1]).toEqual({ type: 'control:reshard-retire', data: { attempt: 'att-1' } });
  });
});

describe('rk9 heldForContent', () => {
  it('rk9 a shared row op the database did not answer means the held changes are not refused for their content', () => {
    workingSet({ held: [{ guildId: '100', reason: 'value too long', code: '22001' }] });
    expect(heldForContent()).toBe(true);
    h.rowOps = 1;
    expect(heldForContent()).toBe(false);
  });
});

describe('rk9 the held log of the leave step', () => {
  it('rk9 a held guild with no save tried yet is named so', async () => {
    workingSet({ held: [{ guildId: '111', reason: null, code: null }] });
    h.left = counts({ unsavedGuilds: 1 });
    expect(await firstHeld()).toBe('[Maintenance] 1 saves in a row left changes unsaved: guild 111 (no save tried yet); the bot process keeps running and does not restart until they are saved or the operator restarts it, which drops them');
  });

  it('rk9 a backend that names a chosen entry but no confirming words leaves the bot running in the log', async () => {
    watchDataBackend(backend({ chosenEntry: () => 'postgres://bot@db1.example:5432/bot', confirmingWords: () => null }), { retryMs: 600_000 });
    workingSet({ held: [{ guildId: '112', reason: 'connection refused', code: null }] });
    h.left = counts({ unsavedGuilds: 1 });
    const line = await firstHeld();
    expect(line).toBe('[Maintenance] 1 saves in a row left changes unsaved: guild 112 (connection refused); the bot process keeps running and does not restart until they are saved or the operator restarts it, which drops them');
  });

  it('rk9 changes refused for their content do not restart while guilds wait to be re-saved', async () => {
    _setMaintenanceTiming({ heldAfterPasses: 2 });
    watchDataBackend(backend(), { retryMs: 600_000 });
    workingSet({ held: [{ guildId: '222', reason: 'duplicate key', code: '23505' }], resave: () => ['333'] });
    h.left = counts({ unsavedGuilds: 1, resaveGuilds: 1 });
    await leaveFor(3);
    expect(restartSent()).toBe(false);
    expect(logs.some(l => l.includes('which drops these changes'))).toBe(false);
    expect(heldLines()[0]).toContain('1 guild(s) wait to be re-saved on the main database: 333; this process holds their newest state; the database refuses these for their content');
  });

  it('rk9 with no working set no guild is named as waiting for a re-save', async () => {
    h.filePaths = ['global/x.json'];
    h.left = counts({ unsavedFiles: 1 });
    expect(await firstHeld()).toBe('[Maintenance] 1 saves in a row left changes unsaved: file global/x.json; the bot process keeps running and does not restart until they are saved or the operator restarts it, which drops them');
  });

  it('rk9 another set of unanswered-only guilds is logged again, each id apart', async () => {
    workingSet({ only: pass => (pass === 1 ? ['1', '23'] : ['12', '3']) });
    h.left = counts({ unansweredGuilds: 2 });
    await leaveFor(3);
    const lines = heldLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 saves in a row left guild(s) 1, 23 holding only a save the database did not answer, which may have landed; ');
    expect(lines[1]).toContain('2 saves in a row left guild(s) 12, 3 holding only a save the database did not answer, which may have landed; ');
  });

  it('rk9 another set of guilds waiting for a re-save is logged again', async () => {
    workingSet({ resave: pass => (pass === 1 ? ['1', '23'] : ['12', '3']) });
    h.left = counts({ resaveGuilds: 2 });
    await leaveFor(3);
    const lines = heldLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 saves in a row left 2 guild(s) waiting to be re-saved on the main database: 1, 23; ');
    expect(lines[1]).toContain('2 saves in a row left 2 guild(s) waiting to be re-saved on the main database: 12, 3; ');
  });

  it('rk9 a re-save beside unanswered-only guilds reads "wait"', async () => {
    workingSet({ only: () => ['5'], resave: () => ['6'] });
    h.left = counts({ unansweredGuilds: 1, resaveGuilds: 1 });
    expect(await firstHeld()).toContain('[Maintenance] 1 saves in a row left guild(s) 5 holding only a save the database did not answer, which may have landed; 1 guild(s) wait to be re-saved on the main database: 6; this process holds their newest state; ');
  });

  it('rk9 a re-save beside unanswered shared files reads "wait"', async () => {
    workingSet({ resave: () => ['6'] });
    h.left = counts({ resaveGuilds: 1, unansweredFiles: 1 });
    expect(await firstHeld()).toContain('[Maintenance] 1 saves in a row left 1 file(s) holding a save the database did not answer, which may have landed; 1 guild(s) wait to be re-saved on the main database: 6; this process holds their newest state; ');
  });

  it('rk9 unsaved guilds beside unanswered-only guilds name both', async () => {
    workingSet({ held: [{ guildId: '7', reason: 'connection refused', code: null }], only: () => ['8'] });
    h.left = counts({ unsavedGuilds: 1, unansweredGuilds: 1 });
    expect(await firstHeld()).toContain('[Maintenance] 1 saves in a row left changes unsaved: guild 7 (connection refused); guild(s) 8 hold only a save the database did not answer, which may have landed; the bot process keeps running');
  });

  it('rk9 unsaved guilds beside unanswered shared files name the files', async () => {
    workingSet({ held: [{ guildId: '9', reason: 'connection refused', code: null }] });
    h.left = counts({ unsavedGuilds: 1, unansweredFiles: 1 });
    expect(await firstHeld()).toContain('[Maintenance] 1 saves in a row left changes unsaved: guild 9 (connection refused); 1 file(s) hold a save the database did not answer, which may have landed; the bot process keeps running');
  });
});
