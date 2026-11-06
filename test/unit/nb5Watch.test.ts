import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAddressList, type ListEntry } from '../../src/utils/databaseAddress';
import {
  MainChooser, setMainChooser, stopMainWatch, noteShardReconnect, type ChooserDeps, type NoticeRead, type ProbeAnswer, type StepHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { isSilence } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { readNewestNotice } from '../../src/utils/ownerMessages';
import { FakeOwnerRest, rateLimitError } from '../helpers/fakeOwnerRest';

// NB5 section 8 test 5 (the watch) and the watch's side of decision 13's confirmation, over a fake prober, a fake
// notice reader and a fake backend that records what the watch tells it.

const A = 'postgresql://u:p@a:5432/bot';
const B = 'postgresql://u:p@b:5432/bot';
const C = 'postgresql://u:p@c:5432/bot';
const shown = (entry: string) => parseAddressList(entry)[0].shown;

function answered(entry: string, over: Partial<Extract<ProbeAnswer, { kind: 'answered' }>> = {}): ProbeAnswer {
  return {
    kind: 'answered', address: shown(entry), entry, inRecovery: false, readOnly: false, generation: 1, machine: 'M',
    since: '2026-11-01', sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'S', ...over,
  };
}
const failed = (entry: string, error?: unknown, cause = 'unreachable'): ProbeAnswer =>
  ({ kind: 'failed', address: shown(entry), entry, cause, ...(error !== undefined ? { error } : {}) });
const refused = (entry: string): ProbeAnswer =>
  ({ kind: 'refused', address: shown(entry), entry, error: Object.assign(new Error('refused'), { code: '28000', severity: 'FATAL' }) });
const silent = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

class FakeBackend {
  epoch = 1;
  latchWhy: string | null = null;
  state: 'connecting' | 'ready' | 'outage' | 'confirming' = 'ready';
  calls: string[] = [];
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
  connectionState() { return { state: this.latchWhy ? 'latched' : this.state }; }
  holdWords() { return this.state === 'outage' || this.state === 'confirming' ? 'held' : null; }
  noteObservation(error: any, epoch: number, atLogin = false) {
    this.calls.push(`obs:${error?.code ?? error?.message}`);
    const loginOnly = atLogin && typeof error?.severity === 'string' && !/^(08|57P0[123]|28000)/.test(error?.code ?? '');
    if (epoch === this.epoch && !this.latchWhy && !loginOnly && isSilence(error)) this.state = 'outage';
  }
  noteEntryAnswered() { if (this.state === 'outage') this.state = 'confirming'; this.calls.push('answered'); }
  noteConfirmingCause(cause: string) { this.calls.push(`cause:${cause}`); }
  confirmHold() { this.state = 'ready'; this.calls.push('confirmed'); }
  latch(cause: { kind: string }) { this.epoch += 1; this.latchWhy = cause.kind; this.calls.push(`latch:${cause.kind}`); }
}

interface Rig {
  chooser: MainChooser;
  backend: FakeBackend;
  hooks: { [K in keyof StepHooks]: ReturnType<typeof vi.fn> };
  probe: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  answers: Map<string, ProbeAnswer>;
  setNotice(n: NoticeRead): void;
  list: string[];
  warn: ReturnType<typeof vi.spyOn>;
}

async function rig(opts: { list?: string[]; generation?: number; notice?: NoticeRead; noticeOff?: boolean } = {}): Promise<Rig> {
  const list = opts.list ?? [A];
  const answers = new Map<string, ProbeAnswer>([[list[0], answered(list[0], { generation: opts.generation ?? 1 })]]);
  let notice: NoticeRead = opts.notice ?? { kind: 'none' };
  const probe = vi.fn(async (entries: ListEntry[]) => entries.map(e => answers.get(e.raw) ?? failed(e.raw)));
  const read = vi.fn(async () => notice);
  const r = { list } as Rig;
  const deps: ChooserDeps = {
    entries: () => parseAddressList(r.list.join(',')),
    probe,
    readNotice: read,
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => 'S',
    noticeCheckOff: () => !!opts.noticeOff,
    nodeName: () => 'node-a',
    onWait: () => undefined,
  };
  const chooser = new MainChooser(deps);
  const entry = await chooser.awaitChoice();
  const backend = new FakeBackend(entry!);
  const hooks = { stopServing: vi.fn(), report: vi.fn(), markForResave: vi.fn(), startLeave: vi.fn() };
  chooser.attach(backend as any, hooks);
  setMainChooser(chooser);
  probe.mockClear();
  read.mockClear();
  return Object.assign(r, { chooser, backend, hooks, probe, read, answers, setNotice: (n: NoticeRead) => { notice = n; }, warn: vi.spyOn(console, 'warn') });
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  stopMainWatch();
  setMainChooser(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB5 decision 10: the watch', () => {
  it('passes every 30 s while the chosen answers and every 5 s after a failed probe of it', async () => {
    const r = await rig();
    await tick(29_999);
    expect(r.probe).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(r.probe).toHaveBeenCalledTimes(1);
    r.answers.set(A, failed(A, silent));
    await tick(30_000);
    expect(r.probe).toHaveBeenCalledTimes(2);
    await tick(5_000);
    expect(r.probe).toHaveBeenCalledTimes(3);
  });

  it('reads the notice every 60 s at generation 1, and never at generation 0', async () => {
    const r = await rig();
    await tick(120_000);
    expect(r.read).toHaveBeenCalledTimes(2);
    const zero = await rig({ generation: 0 });
    zero.read.mockClear();
    await tick(120_000);
    expect(zero.read).toHaveBeenCalledTimes(0);
  });

  it('a higher generation on another database of the store runs the step once; one of another store never', async () => {
    const r = await rig({ list: [A, B] });
    r.answers.set(B, answered(B, { generation: 5, machine: 'N', storeId: 'OTHER' }));
    await tick(60_000);
    expect(r.backend.calls.filter(c => c.startsWith('latch'))).toEqual([]);
    r.answers.set(B, answered(B, { generation: 2, machine: 'N', since: '2026-11-05' }));
    await tick(30_000);
    expect(r.backend.calls.filter(c => c.startsWith('latch'))).toEqual(['latch:replaced']);
    expect(r.hooks.startLeave).toHaveBeenCalledWith("This bot process's database a:5432/bot (generation 1) was replaced by N on 2026-11-05 (generation 2)");
    await tick(10_000);
    expect(r.hooks.startLeave).toHaveBeenCalledTimes(1);
  });

  it('runs the step hooks in one synchronous call, in order', async () => {
    const r = await rig({ list: [A, B] });
    const order: string[] = [];
    for (const [name, fn] of Object.entries(r.hooks)) fn.mockImplementation(() => { order.push(name); });
    r.answers.set(B, answered(B, { generation: 2, machine: 'N' }));
    await tick(30_000);
    expect(order).toEqual(['stopServing', 'report', 'markForResave', 'startLeave']);
    expect(r.hooks.report.mock.calls[0][0]).toMatchObject({ url: null, choosing: true });
  });

  it('a notice above the chosen re-probes it and does nothing when it now shows the notice generation', async () => {
    const r = await rig();
    r.setNotice({ kind: 'notice', generation: 2, machine: 'M', date: '2026-11-05' });
    let n = 0;
    r.probe.mockImplementation(async (entries: ListEntry[]) => {
      n += 1;
      return entries.map(e => answered(e.raw, { generation: n >= 2 ? 2 : 1 }));
    });
    await tick(60_000);
    expect(r.backend.calls.filter(c => c.startsWith('latch'))).toEqual([]);
  });

  it('a notice at 2 with the chosen silent runs the step without a target (behind-notice)', async () => {
    const r = await rig();
    r.setNotice({ kind: 'notice', generation: 2, machine: 'N', date: '2026-11-05' });
    r.answers.set(A, failed(A, silent));
    await tick(60_000);
    expect(r.backend.calls).toContain('latch:behind-notice');
  });

  it('a second writable server at the chosen generation: nothing after one pass, the tie step after two', async () => {
    const r = await rig({ list: [A, B] });
    r.answers.set(B, answered(B, { generation: 1, machine: 'N' }));
    await tick(30_000);
    expect(r.backend.calls).not.toContain('latch:tie');
    await tick(30_000);
    expect(r.backend.calls).toContain('latch:tie');
    expect(r.hooks.startLeave).toHaveBeenCalledWith("Two databases accept writes at main generation 1 (a:5432/bot, b:5432/bot); can't confirm which is the main");
  });

  it('a restart of the chosen server (a new started) with no other writable server is no tie', async () => {
    const r = await rig();
    r.answers.set(A, answered(A, { started: 'restarted' }));
    await tick(90_000);
    expect(r.backend.calls).toEqual([]);
  });

  it('a failed notice read changes nothing and is logged once per cause', async () => {
    const r = await rig();
    r.setNotice({ kind: 'failed', cause: 'HTTP 403 (Missing Access)', status: 403 });
    await tick(120_000);
    expect(r.backend.calls).toEqual([]);
    const lines = r.warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('switch notices could not be read'));
    expect(lines).toHaveLength(1);
  });

  it('a 28000 from an address other than the chosen entry reaches no backend observation', async () => {
    const r = await rig({ list: [A, B] });
    r.answers.set(B, refused(B));
    await tick(30_000);
    expect(r.backend.calls).toEqual([]);
    r.answers.set(A, refused(A));
    await tick(30_000);
    expect(r.backend.calls).toEqual(['obs:28000']);
  });

  it('probes the chosen entry after the list in use leaves it out', async () => {
    const r = await rig();
    r.list = [B];
    r.answers.set(B, answered(B));
    await tick(30_000);
    const asked = (r.probe.mock.calls[0][0] as ListEntry[]).map(e => e.raw);
    expect(asked).toEqual([B, A]);
  });

  it('stops at stopMainWatch, and a shard reconnect after it starts no read', async () => {
    const r = await rig();
    r.setNotice({ kind: 'failed', cause: 'a timeout' });
    await tick(150_000);
    stopMainWatch();
    const reads = r.read.mock.calls.length;
    const probes = r.probe.mock.calls.length;
    noteShardReconnect();
    await tick(120_000);
    expect(r.read.mock.calls.length).toBe(reads);
    expect(r.probe.mock.calls.length).toBe(probes);
  });

  it('notice reads that keep failing are tried every 5 s, and a shard reconnect after 60 s of failures reads at once', async () => {
    const r = await rig();
    r.setNotice({ kind: 'failed', cause: 'a timeout' });
    r.answers.set(A, failed(A, silent));
    await tick(30_000);
    const first = r.read.mock.calls.length;
    await tick(180_000);
    expect(r.read.mock.calls.length - first).toBeGreaterThanOrEqual(30);
    r.answers.set(A, answered(A));
    r.backend.state = 'ready';
    await tick(30_000);
    const before = r.read.mock.calls.length;
    await tick(1);
    noteShardReconnect();
    await tick(0);
    expect(r.read.mock.calls.length).toBe(before + 1);
  });

  it('while latched, a pass that finds one main moves to it; once the exit drain began, none does', async () => {
    const r = await rig({ list: [A, B] });
    r.answers.set(B, answered(B, { generation: 2, machine: 'N' }));
    r.answers.set(A, answered(A, { generation: 1, readOnly: true }));
    await tick(30_000);
    expect(r.backend.calls).toContain('latch:replaced');
    await tick(5_000);
    expect(r.backend.useDatabase).toHaveBeenCalledWith(B);
    const other = await rig({ list: [A, B] });
    other.answers.set(B, answered(B, { generation: 2, machine: 'N' }));
    other.answers.set(A, answered(A, { generation: 1, readOnly: true }));
    await tick(30_000);
    other.chooser.noteExitDrain();
    await tick(20_000);
    expect(other.backend.useDatabase).not.toHaveBeenCalled();
  });
});

describe("NB5 decision 9 in the watch: a 429's retry_after", () => {
  it("D1: a real RateLimitError of 30 s keeps the next notice read 30 s away, not the failed read's 5 s", async () => {
    const r = await rig();
    const rest = new FakeOwnerRest();
    rest.fail('get', /^\/applications\/@me$/, rateLimitError(30_000, '/applications/@me'));
    r.read.mockImplementation(() => readNewestNotice());
    r.answers.set(A, failed(A));
    const lookups = () => rest.calls.filter(c => c.route === '/applications/@me').length;
    // The boot's read makes the next one due at 60 s; the failed probe of A gives passes every 5 s from 30 s on.
    await tick(59_999);
    expect(lookups()).toBe(0);
    await tick(1);
    expect(lookups()).toBe(1);
    expect(await r.read.mock.results[0].value).toEqual({
      kind: 'failed', cause: 'HTTP 429 (rate limited, retry after 30 s)', status: 429, retryAfterMs: 30_000,
    });
    await tick(29_999);
    expect(r.probe.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(lookups()).toBe(1);
    await tick(1);
    expect(lookups()).toBe(2);
  });
});

describe('NB5 decision 13: the watch confirms the hold', () => {
  it('a FATAL 57P01 hold, the chosen back with a new started: confirmed after the confirming pass and one read', async () => {
    const r = await rig();
    r.backend.state = 'outage';
    r.chooser.holdStarted(r.backend as any);
    r.answers.set(A, answered(A, { started: 'restarted' }));
    await tick(5_000);
    expect(r.backend.calls).toEqual(['answered', 'confirmed']);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  it('at generation 0 the hold ends after the confirming pass with no read', async () => {
    const r = await rig({ generation: 0 });
    r.backend.state = 'outage';
    r.chooser.holdStarted(r.backend as any);
    await tick(5_000);
    expect(r.backend.calls).toEqual(['answered', 'confirmed']);
    expect(r.read).toHaveBeenCalledTimes(0);
  });

  it('with failing reads the hold stays confirming, worded by the read cause, until DATA_NOTICE_CHECK=off', async () => {
    const r = await rig();
    r.setNotice({ kind: 'failed', cause: 'HTTP 403 (Missing Access)', status: 403 });
    r.backend.state = 'outage';
    r.chooser.holdStarted(r.backend as any);
    await tick(5_000);
    expect(r.backend.calls).toEqual(['answered', 'cause:HTTP 403 (Missing Access)']);
    const off = await rig({ noticeOff: true });
    off.setNotice({ kind: 'failed', cause: 'HTTP 403 (Missing Access)', status: 403 });
    off.backend.state = 'outage';
    off.chooser.holdStarted(off.backend as any);
    await tick(5_000);
    expect(off.backend.calls).toEqual(['answered', 'confirmed']);
  });

  it('one tied confirming pass is worded exactly and latches nothing; two tied passes run the step', async () => {
    const r = await rig({ list: [A, B] });
    r.backend.state = 'confirming';
    r.answers.set(B, answered(B, { generation: 1 }));
    r.chooser.holdStarted(r.backend as any);
    await tick(0);
    expect(r.backend.calls).toEqual(['cause:two addresses answered as different servers at generation 1 in one check: a:5432/bot and b:5432/bot; checking again']);
    r.answers.set(B, failed(B));
    await tick(5_000);
    expect(r.backend.calls.at(-1)).toBe('confirmed');
    const t = await rig({ list: [A, B] });
    t.backend.state = 'confirming';
    t.answers.set(B, answered(B, { generation: 1 }));
    t.chooser.holdStarted(t.backend as any);
    await tick(10_000);
    expect(t.backend.calls).toContain('latch:tie');
  });

  it('words a read-only chosen entry, a 28P01 and an unusable entry, and an unusable entry keeps confirming', async () => {
    const r = await rig();
    r.backend.state = 'confirming';
    r.answers.set(A, answered(A, { readOnly: true }));
    r.chooser.holdStarted(r.backend as any);
    await tick(0);
    r.answers.set(A, { ...failed(A, Object.assign(new Error('password'), { code: '28P01', severity: 'FATAL' }), 'a wrong password (28P01)'), atLogin: true });
    await tick(5_000);
    r.answers.set(A, failed(A, undefined, 'its certificate file /x.pem cannot be read (ENOENT)'));
    await tick(5_000);
    expect(r.backend.calls).toEqual([
      'cause:a:5432/bot answers but does not accept writes (read-only); checking again',
      'obs:28P01',
      'cause:a:5432/bot answered, but a wrong password (28P01); checking again',
      'cause:a:5432/bot could not be checked (its certificate file /x.pem cannot be read (ENOENT)); checking again',
    ]);
    expect(r.backend.state).toBe('confirming');
  });

  it('while held the watch runs every 5 s even when the chosen entry answered its last probe', async () => {
    const r = await rig();
    r.backend.state = 'confirming';
    r.setNotice({ kind: 'failed', cause: 'a timeout' });
    await tick(30_000);
    const at = r.probe.mock.calls.length;
    await tick(5_000);
    expect(r.probe.mock.calls.length).toBe(at + 1);
  });
});
