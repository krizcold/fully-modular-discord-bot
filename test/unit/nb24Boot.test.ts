import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { MainChooser, type ChooserDeps, type NoticeRead, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetWebuiChoice, _setWebuiChoiceDeps, chooseNow } from '../../src/webui/utils/webuiDataReader';

// NB24 section 8 test 5: the boot wait and the web UI's own choice with a tie in the switch notices.

const A = 'postgresql://u:p@a:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const SECOND = 1_000;
const TIE_AT_3 = "2 machines announced main generation 3 in the switch notices (A and B); can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager";
const BELOW_TIE = "2 machines announced main generation 3 in the switch notices (A and B); a:5432/bot holds generation 4 (A), but no switch notice above generation 3 naming one machine has been read, so the bot stays stopped until one is read. While the Bot Manager records two mains, Keep this machine as the main posts one; once one is posted, the Bot Manager posts it again at its next check of the switch notice if it is no longer among the owner's DMs";

function answered(generation: number): ProbeAnswer {
  return {
    kind: 'answered', address: 'a:5432/bot', entry: A, inRecovery: false, readOnly: false, generation, machine: 'A',
    since: '2026-11-01', sysid: 'sys-a', started: 'start-a', storeId: 'S',
  };
}
const read = (generation: number, machines: string[]): NoticeRead =>
  ({ kind: 'notice', generation, machine: 'A', date: DATE, machines });

interface Boot {
  chooser: MainChooser;
  chosen: string | null | undefined;
  setDb(generation: number): void;
  setNotice(n: NoticeRead | (() => Promise<NoticeRead>)): void;
  reads: ReturnType<typeof vi.fn>;
}

function boot(generation: number, first: NoticeRead | (() => Promise<NoticeRead>), noticeOff = false): Boot {
  let db = answered(generation);
  let notice = first;
  const reads = vi.fn(async () => (typeof notice === 'function' ? notice() : notice));
  const deps: ChooserDeps = {
    entries: () => parseAddressList(A),
    probe: async () => [db],
    readNotice: reads,
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => 'S',
    noticeCheckOff: () => noticeOff,
    nodeName: () => 'A',
    onWait: () => undefined,
  };
  const chooser = new MainChooser(deps);
  const b: Boot = {
    chooser, chosen: undefined, reads,
    setDb: g => { db = answered(g); },
    setNotice: n => { notice = n; },
  };
  void chooser.awaitChoice().then(entry => { b.chosen = entry; });
  return b;
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const waiting = (b: Boot) => ({ state: b.chooser.view().state, reason: b.chooser.view().reason });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _setWebuiChoiceDeps(null);
  _resetWebuiChoice();
});

describe('NB24 test 5: the boot wait with a tie in the notices', () => {
  it('waits tie on a tie read, still waits with the database raised above it, and chooses once a notice above names this machine alone', async () => {
    const b = boot(3, read(3, ['A', 'B']));
    await tick(1);
    expect(b.chosen).toBeUndefined();
    expect(waiting(b)).toEqual({ state: 'tie', reason: TIE_AT_3 });
    b.setDb(4);
    await tick(10 * SECOND);
    expect(b.chosen).toBeUndefined();
    expect(waiting(b)).toEqual({ state: 'tie', reason: BELOW_TIE });
    b.setNotice(read(4, ['A']));
    await tick(60 * SECOND);
    expect(b.chosen).toBe(A);
    b.chooser.stop();
  });

  it("a read that fails after 10 s with DATA_NOTICE_CHECK on waits cant-check", async () => {
    const b = boot(3, () => new Promise<NoticeRead>(resolve => { setTimeout(() => resolve({ kind: 'failed', cause: 'a timeout' }), 10 * SECOND); }));
    await tick(10 * SECOND + 1);
    expect(b.chosen).toBeUndefined();
    expect(b.chooser.view().state).toBe('cant-check');
    b.chooser.stop();
  });

  it('a boot read of 3 naming A and B, then one naming A alone: still tie (the one source)', async () => {
    const b = boot(3, read(3, ['A', 'B']));
    await tick(1);
    b.setNotice(read(3, ['A']));
    await tick(70 * SECOND);
    expect(b.reads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(b.chosen).toBeUndefined();
    expect(waiting(b)).toEqual({ state: 'tie', reason: TIE_AT_3 });
    b.chooser.stop();
  });

  it('after Keep, the database at 4 and the reads holding only the pinned tie at 3 (case 20): tie with the whole below-the-top text', async () => {
    const b = boot(4, read(3, ['A', 'B']));
    await tick(70 * SECOND);
    expect(b.chosen).toBeUndefined();
    expect(waiting(b)).toEqual({ state: 'tie', reason: BELOW_TIE });
    b.chooser.stop();
  });

  it("the web UI's chooseNow with a tie read answers the refusal with the same reason", async () => {
    vi.useRealTimers();
    _resetWebuiChoice();
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(A),
      probe: async () => [answered(3)],
      readNotice: async () => read(3, ['A', 'B']),
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
    });
    const { resolution } = await chooseNow();
    expect(resolution).toEqual({ refusal: TIE_AT_3 });
  });
});
