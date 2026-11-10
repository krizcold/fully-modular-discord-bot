import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAddressList, type ListEntry } from '../../src/utils/databaseAddress';
import {
  MainChooser, setMainChooser, stopMainWatch, type ChooserDeps, type NoticeRead, type ProbeAnswer,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { latchWords } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB24 section 8 test 4: the watch and seekMain with a tie in the switch notices, over the chooser fakes of
// nb5Watch.test.ts and a fake backend that keeps each latch cause.

const A = 'postgresql://u:p@a:5432/bot';
const B = 'postgresql://u:p@b:5432/bot';
const shown = (entry: string) => parseAddressList(entry)[0].shown;
const DATE = '2026-11-05T12:00:00.000Z';
const SECOND = 1_000;

function answered(entry: string, generation: number, machine: string): ProbeAnswer {
  return {
    kind: 'answered', address: shown(entry), entry, inRecovery: false, readOnly: false, generation, machine,
    since: '2026-11-01', sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'S',
  };
}
const tieRead = (generation: number, machines: string[]): NoticeRead =>
  ({ kind: 'notice', generation, machine: machines[0], date: DATE, machines });

class FakeBackend {
  epoch = 1;
  latchWhy: string | null = null;
  state: 'ready' | 'confirming' = 'ready';
  calls: string[] = [];
  causes: any[] = [];
  useDatabase = vi.fn(async (entry: string) => {
    this.entry = entry;
    this.latchWhy = null;
    this.epoch += 1;
    return true;
  });
  constructor(public entry: string) {}
  databaseEpoch() { return this.epoch; }
  chosenEntry() { return this.entry; }
  latchReason() { return this.latchWhy; }
  isMoving() { return false; }
  connectionState() { return { state: this.latchWhy ? 'latched' : this.state }; }
  holdWords() { return this.state === 'confirming' ? 'held' : null; }
  noteObservation() { this.calls.push('obs'); }
  noteEntryAnswered() { this.calls.push('answered'); }
  noteConfirmingCause(cause: string) { this.calls.push(`cause:${cause}`); }
  confirmHold() { this.state = 'ready'; this.calls.push('confirmed'); }
  latch(cause: any) { this.epoch += 1; this.latchWhy = latchWords(cause, shown(this.entry)); this.causes.push(cause); this.calls.push(`latch:${cause.kind}`); }
}

interface Rig {
  chooser: MainChooser;
  backend: FakeBackend;
  leave: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  readStarts: number[];
  readEnds: number[];
  setDb(generation: number): void;
  setNotice(n: NoticeRead | (() => Promise<NoticeRead>)): void;
}

async function rig(entry: string, generation: number, machine: string): Promise<Rig> {
  let db = answered(entry, generation, machine);
  let notice: NoticeRead | (() => Promise<NoticeRead>) = { kind: 'none' };
  const readStarts: number[] = [];
  const readEnds: number[] = [];
  const read = vi.fn(async () => {
    readStarts.push(Date.now());
    const answer = typeof notice === 'function' ? await notice() : notice;
    readEnds.push(Date.now());
    return answer;
  });
  const deps: ChooserDeps = {
    entries: () => parseAddressList(entry),
    probe: async (entries: ListEntry[]) => entries.map(() => db),
    readNotice: read,
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => 'S',
    noticeCheckOff: () => false,
    nodeName: () => machine,
    onWait: () => undefined,
  };
  const chooser = new MainChooser(deps);
  const chosen = await chooser.awaitChoice();
  const backend = new FakeBackend(chosen!);
  const leave = vi.fn();
  chooser.attach(backend as any, { stopServing: vi.fn(), report: vi.fn(), markForResave: vi.fn(), startLeave: leave });
  setMainChooser(chooser);
  return {
    chooser, backend, leave, read, readStarts, readEnds,
    setDb: g => { db = answered(entry, g, machine); },
    setNotice: n => { notice = n; },
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  stopMainWatch();
  setMainChooser(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB24 test 4: the watch with a tie in the notices', () => {
  it("(a) serving at 3 as A, a read of 3 naming A and B: the step with the tie cause and the watch's reason", async () => {
    const r = await rig(A, 3, 'A');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(60 * SECOND);
    expect(r.backend.causes).toEqual([{ kind: 'tie', generation: 3, machines: ['A', 'B'] }]);
    expect(r.leave).toHaveBeenCalledWith("2 machines announced main generation 3 in the switch notices (A and B), the generation of this bot process's database a:5432/bot; can't confirm which is the main");
  });

  it('(b) a read of 3 naming A, then one of 3 naming B (the chosen row A): the step at the second (the union)', async () => {
    const r = await rig(A, 3, 'A');
    r.setNotice(tieRead(3, ['A']));
    await tick(60 * SECOND);
    expect(r.backend.causes).toEqual([]);
    r.setNotice(tieRead(3, ['B']));
    await tick(60 * SECOND);
    expect(r.backend.causes).toEqual([{ kind: 'tie', generation: 3, machines: ['A', 'B'] }]);
  });

  it('(b2) after the tie step, a latched read of 3 naming A alone joins the set: no move', async () => {
    const r = await rig(A, 3, 'A');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(60 * SECOND);
    expect(r.backend.calls).toContain('latch:tie');
    r.setNotice(tieRead(3, ['A']));
    await tick(120 * SECOND);
    expect(r.read.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(r.backend.useDatabase).not.toHaveBeenCalled();
  });

  it('(c) a confirming hold with a tie read: no confirmHold, the step runs', async () => {
    const r = await rig(A, 3, 'A');
    r.backend.state = 'confirming';
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(30 * SECOND);
    expect(r.backend.calls).not.toContain('confirmed');
    expect(r.backend.calls).toContain('latch:tie');
  });

  it('(d) latched at 3: no move at 3, none at 4 before a notice at 4 is read, and the move once 4 naming A is read', async () => {
    const r = await rig(A, 3, 'A');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(60 * SECOND);
    expect(r.backend.calls).toContain('latch:tie');
    await tick(40 * SECOND);
    expect(r.backend.useDatabase).not.toHaveBeenCalled();
    r.setDb(4);
    await tick(10 * SECOND);
    expect(r.backend.useDatabase).not.toHaveBeenCalled();
    r.setNotice(tieRead(4, ['A']));
    await tick(15 * SECOND);
    expect(r.backend.useDatabase).toHaveBeenCalledTimes(1);
  });

  it('(e) two latched choosers A and B, both databases at 4 and the reads naming A and B at 4: neither moves', async () => {
    const a = await rig(A, 3, 'A');
    const b = await rig(B, 3, 'B');
    a.setNotice(tieRead(3, ['A', 'B']));
    b.setNotice({ kind: 'notice', generation: 3, machine: 'B', date: DATE, machines: ['A', 'B'] });
    await tick(60 * SECOND);
    for (const r of [a, b]) {
      expect(r.backend.calls).toContain('latch:tie');
      r.setDb(4);
    }
    a.setNotice(tieRead(4, ['A', 'B']));
    b.setNotice({ kind: 'notice', generation: 4, machine: 'B', date: DATE, machines: ['A', 'B'] });
    await tick(70 * SECOND);
    expect(a.read.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(a.backend.useDatabase).not.toHaveBeenCalled();
    expect(b.backend.useDatabase).not.toHaveBeenCalled();
    a.chooser.stop();
    b.chooser.stop();
  });

  it('(f) serving at 4 as B, a read of 3 naming A and B: the step with the below-the-top reason, the tie cause and its latch words', async () => {
    const r = await rig(B, 4, 'B');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(60 * SECOND);
    const cause = { kind: 'tie', generation: 3, machines: ['A', 'B'] };
    expect(r.backend.causes).toEqual([cause]);
    expect(r.leave).toHaveBeenCalledWith("2 machines announced main generation 3 in the switch notices (A and B); b:5432/bot holds generation 4 (B), but no switch notice above generation 3 naming one machine has been read, so the bot stays stopped until one is read. While the Bot Manager records two mains, Keep this machine as the main posts one; once one is posted, the Bot Manager posts it again at its next check of the switch notice if it is no longer among the owner's DMs");
    expect(latchWords(cause as any, 'b:5432/bot')).toBe("can't confirm that b:5432/bot is still the main (2 machines announced generation 3: A and B)");
  });

  it("(g) serving at 2, a read of 3 naming A and B: the behind-notice step carries both machines, with the tie form's reason", async () => {
    const r = await rig(A, 2, 'A');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(60 * SECOND);
    expect(r.backend.causes).toEqual([{ kind: 'behind-notice', machine: 'A', generation: 3, machines: ['A', 'B'] }]);
    expect(r.leave).toHaveBeenCalledWith("can't confirm that a:5432/bot is the main: it holds generation 2 (A), but 2 machines announced generation 3 in the switch notices (A and B), and no database in DATA_BACKEND_URL holds it. The bot stays stopped until the owner chooses one in the Bot Manager");
  });

  it('(h) latched on a tie at 3, the database at 4, reads that fail after 10 s: no move, the next read 5 s after the last ended', async () => {
    const r = await rig(A, 3, 'A');
    r.setNotice(tieRead(3, ['A', 'B']));
    await tick(61 * SECOND);
    expect(r.backend.calls).toContain('latch:tie');
    r.setDb(4);
    r.setNotice(() => new Promise<NoticeRead>(resolve => { setTimeout(() => resolve({ kind: 'failed', cause: 'a timeout' }), 10 * SECOND); }));
    const before = r.readStarts.length;
    await tick(120 * SECOND);
    expect(r.backend.useDatabase).not.toHaveBeenCalled();
    const starts = r.readStarts.slice(before);
    const ends = r.readEnds.slice(before);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - ends[i - 1];
      expect(gap).toBeGreaterThanOrEqual(5 * SECOND);
      expect(gap).toBeLessThan(10 * SECOND);
    }
  });
});
