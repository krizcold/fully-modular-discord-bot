import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHOOSING_REFUSAL, _resetWebuiChoice, _setWebuiChoiceDeps, chooseNow, noteWebuiChild, ownChoiceLast,
  resolveWebuiDatabase, setWebuiDataStoreUrl, webuiChildCase,
} from '../../src/webui/utils/webuiDataReader';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { NoticeRead, ProbeAnswer, StoreReport } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

const A = 'postgres://bot:pw@a.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';

function answered(generation: number, machine: string | null): ProbeAnswer {
  const [e] = parseAddressList(A);
  return {
    kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: 'sys-a', started: 'start-a', storeId: 'store-1', ownerChannel: { kind: 'none' },
  } as ProbeAnswer;
}

const fake = {
  probes: 0,
  reads: 0,
  answers: [] as ProbeAnswer[],
  probe: null as null | (() => Promise<ProbeAnswer[]>),
  notice: null as null | (() => Promise<NoticeRead>),
};

function reported(): StoreReport {
  const c = webuiChildCase();
  if (c.kind !== 'reported') throw new Error(`case ${c.kind}`);
  return c.report;
}

async function settled(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  Object.assign(fake, { probes: 0, reads: 0, answers: [answered(1, 'M')], probe: null, notice: null });
  _resetWebuiChoice();
  setWebuiDataStoreUrl(null);
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(A),
    probe: async () => {
      fake.probes++;
      return fake.probe ? fake.probe() : fake.answers;
    },
    readNotice: async () => {
      fake.reads++;
      return fake.notice ? fake.notice() : { kind: 'none' };
    },
    markerStoreId: () => 'store-1',
    noticeCheckOff: () => false,
  });
});
afterEach(() => {
  _setWebuiChoiceDeps(null);
  setWebuiDataStoreUrl(null);
  vi.restoreAllMocks();
});

describe('ra77: the report of the bot process as the web UI keeps it', () => {
  it('a url of blanks is no url: the web UI answers choosing, not an empty entry', () => {
    setWebuiDataStoreUrl({ url: '   ' });
    expect(reported()).toStrictEqual({ url: null, choosing: true });
    expect(resolveWebuiDatabase()).toEqual({ refusal: CHOOSING_REFUSAL });
  });

  it('a url with blanks around it is kept trimmed', () => {
    setWebuiDataStoreUrl({ url: `  ${A}  `, tag: '1:M' });
    expect(reported()).toStrictEqual({ url: A, tag: '1:M' });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '1:M' });
  });

  it('a report with a url is not choosing; a report without one is', () => {
    setWebuiDataStoreUrl({ url: A });
    expect(reported()).toStrictEqual({ url: A });
    setWebuiDataStoreUrl({ url: null });
    expect(reported()).toStrictEqual({ url: null, choosing: true });
  });

  it('held and tag without a url are dropped; the reason is kept', () => {
    setWebuiDataStoreUrl({ url: null, held: true, tag: '1:M', reason: 'waiting for the main' });
    expect(reported()).toStrictEqual({ url: null, choosing: true, reason: 'waiting for the main' });
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'waiting for the main' });
  });

  it('a reason that is not a string is dropped: the refusal is the choosing words', () => {
    setWebuiDataStoreUrl({ url: null, reason: 5 } as unknown as StoreReport);
    expect(reported()).toStrictEqual({ url: null, choosing: true });
    expect(resolveWebuiDatabase()).toEqual({ refusal: CHOOSING_REFUSAL });
  });

  it('a tag that is not a string is dropped: the answer has a null tag', () => {
    setWebuiDataStoreUrl({ url: A, tag: 7 } as unknown as StoreReport);
    expect(reported()).toStrictEqual({ url: A });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: null });
  });

  it('a held report with a url answers held', () => {
    setWebuiDataStoreUrl({ url: A, held: true, reason: 'confirming', tag: '1:M' });
    expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '1:M', held: { reason: 'confirming' } });
  });
});

describe("ra77: the web UI's own choice", () => {
  it('at generation 0 no switch notice is read: a failing notice read does not refuse the choice', async () => {
    fake.answers = [answered(0, 'M')];
    fake.notice = async () => { throw new Error('discord down'); };
    const { resolution } = await chooseNow();
    expect(resolution).toEqual({ entry: A, tag: '0' });
    expect(fake.reads).toBe(0);
  });

  it('a choice that throws leaves its error as the refusal', async () => {
    fake.probe = async () => { throw new Error('probe broke'); };
    expect(resolveWebuiDatabase()).toEqual({ refusal: CHOOSING_REFUSAL });
    await settled(() => 'refusal' in ownChoiceLast() && (ownChoiceLast() as { refusal: string }).refusal !== CHOOSING_REFUSAL);
    expect(ownChoiceLast()).toEqual({ refusal: 'probe broke' });
  });

  it('a choice that throws after a change of case leaves no refusal from before it', async () => {
    let fail!: (error: Error) => void;
    fake.probe = () => new Promise<ProbeAnswer[]>((_, reject) => { fail = reject; });
    resolveWebuiDatabase();
    expect(fake.probes).toBe(1);
    noteWebuiChild('gone');
    fail(new Error('stale failure'));
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    expect(ownChoiceLast()).toEqual({ refusal: CHOOSING_REFUSAL });
  });

  it('a new choice starts exactly 10 s after the last one started', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    resolveWebuiDatabase();
    await settled(() => 'entry' in ownChoiceLast());
    expect(ownChoiceLast()).toEqual({ entry: A, tag: '1:M' });
    expect(fake.probes).toBe(1);
    now += 9_999;
    resolveWebuiDatabase();
    expect(fake.probes).toBe(1);
    now += 1;
    resolveWebuiDatabase();
    expect(fake.probes).toBe(2);
  });

  it('a finished choice lets the next one start, with its new answer', async () => {
    let now = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    resolveWebuiDatabase();
    await settled(() => 'entry' in ownChoiceLast());
    fake.answers = [answered(2, 'N')];
    now += 60_000;
    resolveWebuiDatabase();
    expect(fake.probes).toBe(2);
    await settled(() => (ownChoiceLast() as { tag?: string }).tag === '2:N');
    expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '2:N' });
  });
});
