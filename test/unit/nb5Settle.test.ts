import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleRetires, MainChooser, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { parseAddressList, type ListEntry } from '../../src/utils/databaseAddress';
import { heldClauses } from '../../src/bot/internalSetup/utils/heldWords';
import { loginOfPass } from '../../src/bot/internalSetup/utils/maintenance';

// NB5 decision 12 step (e) as G4 and K1 amend it, decision 9's boot wait, decision 7's mapping and C3's clause.

const W = 'postgresql://u:p@w:5432/bot';

function deps(retires: Array<{ guildId: string; answer: Promise<any> }>) {
  return {
    retiresToSettle: vi.fn(() => retires),
    settled: vi.fn(),
    reached: vi.fn(),
    flagEpoch: vi.fn(),
  };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB5 step (e): the retires sent before the latch', () => {
  it('a retire that moved rows and whose batch the target holds: evicted, the reached line, flags take the epoch', async () => {
    const d = deps([{ guildId: 'R', answer: Promise.resolve({ ok: true, moved: 3, retiredAt: 77 }) }]);
    const backend = { retireReached: vi.fn(async () => true) };
    expect(await settleRetires(backend, 9, W, d)).toBe(true);
    expect(backend.retireReached).toHaveBeenCalledWith('R', 77);
    expect(d.reached).toHaveBeenCalledWith('R');
    expect(d.settled).toHaveBeenCalledWith('R');
    expect(d.flagEpoch).toHaveBeenCalledWith(9);
    expect(logs).toContain('[Data] Guild R: its retire reached w:5432/bot');
  });

  it('the target without the batch: the set stays flagged and the did-not-reach line is logged', async () => {
    const d = deps([{ guildId: 'R', answer: Promise.resolve({ ok: false, reason: 'unknown', moved: 2, retiredAt: 5 }) }]);
    expect(await settleRetires({ retireReached: async () => false }, 9, W, d)).toBe(true);
    expect(d.reached).not.toHaveBeenCalled();
    expect(logs).toContain("[Data] Guild R: its retire did not reach w:5432/bot, so this process re-saves the guild's data there; repeat the retire once the bot runs on w:5432/bot");
  });

  it('moved 0 sends no lookup and logs the moved-no-rows line (K1)', async () => {
    const d = deps([{ guildId: 'R', answer: Promise.resolve({ ok: true, moved: 0, retiredAt: 5 }) }]);
    const backend = { retireReached: vi.fn(async () => true) };
    await settleRetires(backend, 9, W, d);
    expect(backend.retireReached).not.toHaveBeenCalled();
    expect(logs).toContain("[Data] Guild R: its retire moved no rows, so this process re-saves the guild's data on w:5432/bot; repeat the retire once the bot runs on w:5432/bot");
    expect(logs.some(l => l.includes('did not reach') || l.includes('retire reached'))).toBe(false);
  });

  it('an answer that shows nothing moved sends no lookup and logs the did-not-reach line (G4)', async () => {
    const d = deps([{ guildId: 'R', answer: Promise.resolve({ ok: false, reason: 'latched', detail: 'x' }) }]);
    const backend = { retireReached: vi.fn(async () => true) };
    await settleRetires(backend, 9, W, d);
    expect(backend.retireReached).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('its retire did not reach w:5432/bot'))).toBe(true);
  });

  it('awaits a retire whose COMMIT is still held, then reads the target at its retiredAt (G4 row 2)', async () => {
    vi.useFakeTimers();
    let answer!: (v: unknown) => void;
    const d = deps([{ guildId: 'R', answer: new Promise(resolve => { answer = resolve; }) }]);
    const backend = { retireReached: vi.fn(async () => true) };
    const settling = settleRetires(backend, 9, W, d);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(backend.retireReached).not.toHaveBeenCalled();
    answer({ ok: true, moved: 1, retiredAt: 42 });
    expect(await settling).toBe(true);
    expect(backend.retireReached).toHaveBeenCalledWith('R', 42);
  });

  it('a lookup that fails decides nothing: no line of the outcome, no evict, the attempt ends (R6)', async () => {
    const d = deps([{ guildId: 'R', answer: Promise.resolve({ ok: true, moved: 1, retiredAt: 42 }) }]);
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(await settleRetires({ retireReached: async () => { throw error; } }, 9, W, d)).toBe(false);
    expect(d.reached).not.toHaveBeenCalled();
    expect(d.settled).not.toHaveBeenCalled();
    expect(d.flagEpoch).not.toHaveBeenCalled();
    expect(logs).toContain("[Database] Not moving to w:5432/bot yet: can't confirm whether guild R's retire reached it (unreachable (ECONNRESET))");
    expect(logs.some(l => l.includes('did not reach'))).toBe(false);
  });
});

describe('NB5 decision 9: the boot wait', () => {
  function chooser(script: () => ProbeAnswer[], over: Partial<ConstructorParameters<typeof MainChooser>[0]> = {}) {
    const waits: Array<string | null> = [];
    const dms: string[] = [];
    const c = new MainChooser({
      entries: () => parseAddressList(W),
      probe: async (_entries: ListEntry[]) => script(),
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async text => { dms.push(text); return { ok: true }; },
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: reason => { waits.push(reason); },
      ...over,
    });
    return { c, waits, dms };
  }
  const down: ProbeAnswer = { kind: 'failed', address: 'w:5432/bot', entry: W, cause: 'unreachable' };
  const up = (generation = 1): ProbeAnswer => ({
    kind: 'answered', address: 'w:5432/bot', entry: W, inRecovery: false, readOnly: false, generation, machine: 'M',
    since: null, sysid: '1', started: 's', storeId: 'S',
  });

  it('waits with the reason, logs it once, again every 5 minutes, and chooses with the Using line', async () => {
    vi.useFakeTimers();
    let answer: ProbeAnswer = down;
    const { c, waits } = chooser(() => [answer]);
    const choice = c.awaitChoice();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waits.at(-1)).toBe('No database in DATA_BACKEND_URL answers (w:5432/bot: unreachable)');
    expect(logs.filter(l => l.endsWith('; waiting'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(logs.filter(l => l.endsWith('; waiting'))).toHaveLength(2);
    answer = up();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await choice).toBe(W);
    expect(waits.at(-1)).toBeNull();
    expect(logs).toContain('[Database] Using w:5432/bot (generation 1, M): the database that accepts writes with the highest main generation');
    expect(c.lastPassLogin()).toBe('unreachable');
  });

  it('cant-check sends one DM per wait, with the node name and the reason', async () => {
    vi.useFakeTimers();
    const { c, dms } = chooser(() => [up()], { readNotice: async () => ({ kind: 'failed', cause: 'a timeout' }) });
    void c.awaitChoice();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dms).toEqual(["The bot on node-a cannot confirm which database is its main: can't confirm that w:5432/bot (generation 1) is still the main: the switch notices could not be read (a timeout). It stays stopped and checks the databases and the switch notices again every 10 seconds."]);
    c.stop();
  });

  it('answers refused to askDatabase after a pass in which every address refused the login', async () => {
    const refusedAll: ProbeAnswer = { kind: 'refused', address: 'w:5432/bot', entry: W };
    const { c } = chooser(() => [refusedAll]);
    void c.awaitChoice();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(c.lastPassLogin()).toBe('refused');
    c.stop();
  });

  it('never answers refused after a pass in which M took the login and its generation was unreadable, beside a refused B', async () => {
    const cause = 'an unreadable generation (SQLSTATE 42501)';
    const unreadable: ProbeAnswer = { kind: 'failed', address: 'm:5432/bot', entry: 'postgresql://u:p@m:5432/bot', cause, loggedIn: true };
    const refusedB: ProbeAnswer = { kind: 'refused', address: 'w:5432/bot', entry: W };
    const { c, waits } = chooser(() => [unreadable, refusedB]);
    void c.awaitChoice();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(c.lastPassLogin()).toBe('unreachable');
    expect(waits.at(-1)).toBe(`can't confirm which database is the main: m:5432/bot: ${cause}; the bot waits until those rows can be read or the owner switches in the Bot Manager`);
    c.stop();
  });
});

describe('NB5 decision 7: one pass mapped by one rule', () => {
  it('an accepted login, only refusals, only failures', () => {
    expect(loginOfPass([{ kind: 'failed' }, { kind: 'answered' }])).toBe('accepted');
    // A statement after the connect failed (an unreadable generation): the login was accepted.
    expect(loginOfPass([{ kind: 'failed', loggedIn: true }])).toBe('accepted');
    expect(loginOfPass([{ kind: 'refused' }, { kind: 'failed' }])).toBe('refused');
    expect(loginOfPass([{ kind: 'failed' }])).toBe('unreachable');
  });
});

describe('NB5 C3: the re-save clause', () => {
  it('comes second, and a count of flags alone never reads 0 guild(s) and 0 file(s)', () => {
    expect(heldClauses({ unsavedGuilds: 1, unsavedFiles: 0, unansweredGuilds: 2, resaveGuilds: 3 })).toBe(
      "1 guild(s) and 0 file(s) hold changes that could not be saved; 3 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process; 2 guild(s) hold a save the database did not answer, which may have landed");
    expect(heldClauses({ unsavedGuilds: 0, unsavedFiles: 0, resaveGuilds: 40 })).toBe(
      "40 guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process");
  });
});
