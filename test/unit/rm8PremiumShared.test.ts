import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a Postgres bot (NB6 decisions 27, 64, 102, 110; NB13 C7): an event handed outside every op is
// handed again only after a 'changed-elsewhere' refusal, in a console ledger tagged 'premium', and not after the stop;
// a failed re-hand is logged; a walk batch warns only for events of subscriptions premium holds; settled() waits for
// open items and for installs started while it waited; the exit names a landed row op's line as stored and an
// 'unconfirmed' one as can't confirm. The data facade's save, the row outcome, the mirror refresh and the shared lines
// are scripted here; the manager is the real one.

type Gate = { promise: Promise<any>; open: (value?: any) => void };
const h = vi.hoisted(() => ({
  saves: [] as Array<{ file: string; opts: any; data: any; module: string | undefined }>,
  tickets: [] as any[],
  gates: [] as Array<{ promise: Promise<any>; open: (value?: any) => void }>,
  auto: null as any,
  refresh: [] as string[][],
  refreshImpl: null as null | (() => Promise<any>),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file === premium) return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      return real.readRawStrict(file);
    },
    saveDataTracked: (file: string, opts: any, data: unknown) => {
      h.saves.push({ file, opts, data: JSON.parse(JSON.stringify(data)), module: ledger.currentModule() });
      const ticket = { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 };
      h.tickets.push(ticket);
      return { outcome: 'saved', ticket };
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return {
    ...real,
    rowOutcome: () => {
      if (h.auto !== null) return Promise.resolve(h.auto);
      let open!: (value?: any) => void;
      const promise = new Promise<any>(resolve => { open = resolve; });
      h.gates.push({ promise, open });
      return promise;
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    setSharedLinesPassStep: () => undefined,
    refreshShared: (keys: string[]) => {
      h.refresh.push(keys);
      return h.refreshImpl ? h.refreshImpl() : Promise.resolve({ ok: true });
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = () => ({ kind: 'row', key: 'global/premium-tiers.audit.jsonl', op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return { ...real, carryLines: ticket, deleteLines: ticket, appendLine: ticket };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push({ guildId, kind });
    return { delivered: true, via: 'dm' };
  },
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, logged, paidSub, quiet, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let spies: ReturnType<typeof quiet>;
let managers: PremiumManager[] = [];
let pause: Gate;

function gateOf(): Gate {
  let open!: (value?: any) => void;
  const promise = new Promise<any>(resolve => { open = resolve; });
  return { promise, open };
}

function manager(): PremiumManager {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: () => pause.promise,
  } as any);
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const expired = (subId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'fake', providerSubId: subId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return;
    await tick(2);
  }
}

function openRows(outcome: unknown = 'landed'): void {
  h.auto = outcome;
  for (const g of h.gates.splice(0)) g.open(outcome);
}

beforeEach(() => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  setBackendKind('postgres');
  Object.assign(h, { saves: [], tickets: [], gates: [], auto: null, refresh: [], refreshImpl: null });
  notices.sent = [];
  reg.current = null;
  pause = gateOf();
  clearGlobal();
  writePremium({ g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } });
});
afterEach(async () => {
  openRows();
  pause.open();
  await tick(5);
  for (const pm of managers.splice(0)) pm.dispose();
  reg.current = null;
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('an event handed again after a changed-elsewhere refusal', () => {
  it('is handed again in a console ledger tagged premium, at most three times, and the loss is logged', async () => {
    manager();
    h.auto = { refused: { cause: 'changed-elsewhere' } };
    emit(expired('e1', 'g2'));
    await until(() => logged(spies.error).some(l => l.includes('(3 tries)')));
    expect(h.saves).toHaveLength(3);
    expect(h.refresh).toEqual([['global/premium-tiers.json'], ['global/premium-tiers.json']]);
    expect(h.saves.map(s => s.module)).toEqual([undefined, 'premium', 'premium']);
  });

  it('an event raised inside an op is not handed again', async () => {
    manager();
    h.auto = { refused: { cause: 'changed-elsewhere' } };
    await runSealed('console', null, 'premium', async () => {
      emit(expired('e1', 'g2'));
    });
    await tick(30);
    expect(h.saves).toHaveLength(1);
    expect(h.refresh).toEqual([]);
  });

  it('a save refused for another cause is not handed again', async () => {
    manager();
    h.auto = { refused: { cause: 'io' } };
    emit(expired('e1', 'g2'));
    await tick(30);
    expect(h.saves).toHaveLength(1);
    expect(h.refresh).toEqual([]);
  });

  it('a stop that came during the refresh logs the event as lost and saves nothing more', async () => {
    const pm = manager();
    h.auto = { refused: { cause: 'changed-elsewhere' } };
    h.refreshImpl = async () => {
      pm.markStopped('stopping');
      return { ok: true };
    };
    const event = expired('e1', 'g2');
    emit(event);
    const line = `[PremiumManager] A subscription.expired event from fake (subscription e1, guild g2) was not applied: the bot is stopping; it is lost: ${JSON.stringify(event)}`;
    await until(() => logged(spies.error).includes(line));
    expect(logged(spies.error)).toContain(line);
    expect(h.saves).toHaveLength(1);
  });

  it('a refresh that fails is logged with its error', async () => {
    manager();
    h.auto = { refused: { cause: 'changed-elsewhere' } };
    const boom = new Error('mirror broke');
    h.refreshImpl = () => Promise.reject(boom);
    emit(expired('e1', 'g2'));
    const failed = () => spies.error.mock.calls.filter((c: unknown[]) => c[1] === boom);
    await until(() => failed().length > 0);
    expect(failed()).toEqual([['[PremiumManager] A provider event could not be handed again:', boom]]);
  });
});

describe("the Dummy tick's walk batch on a Postgres bot", () => {
  it('warns only for the events of subscriptions premium holds when the sha moved', () => {
    manager();
    getPaymentRegistry().emitWalkBatch({
      premiumSha: 'another-version',
      events: [
        { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'zz', guildId: 'g2', state: state() },
        { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'e1', guildId: 'g2', state: state() },
        { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'yy', guildId: 'g9', state: state() },
      ],
    } as any);
    const warned = logged(spies.warn).filter(l => l.includes('was not applied'));
    expect(warned).toEqual([
      "[PremiumManager] The subscription.renewed event for subscription e1 was not applied: premium-tiers.json changed after the Dummy provider read it; the Dummy provider compares the subscription with the bot's copy again at its next checks",
    ]);
    expect(h.saves).toHaveLength(0);
  });

  it('logs nothing for a batch that names no subscription premium holds', () => {
    manager();
    getPaymentRegistry().emitWalkBatch({
      premiumSha: 'another-version',
      events: [{ type: 'subscription.renewed', providerId: 'fake', providerSubId: 'zz', guildId: 'g2', state: state() }],
    } as any);
    expect(logged(spies.warn).filter(l => l.includes('was not applied'))).toEqual([]);
  });
});

describe('settled() in the bot', () => {
  it('waits for the items of an open op before it resolves', async () => {
    const pm = manager();
    emit(expired('e1', 'g2'));
    expect(h.gates).toHaveLength(1);
    let done = false;
    const waiting = pm.settled(undefined).then(() => { done = true; });
    await tick(30);
    expect(done).toBe(false);
    openRows();
    await waiting;
    expect(done).toBe(true);
    expect(notices.sent).toEqual([{ guildId: 'g2', kind: 'paid.sub.expired' }]);
  });

  it('waits for an install started under its ledger while it waited for items', async () => {
    writePremium({
      g1: { active: paidSub('s1', 'h1', 'high'), paused: [] },
      g2: { active: paidSub('s2', 'e1', 'low'), paused: [] },
    });
    const pm = manager();
    let done = false;
    let waiting: Promise<void> | null = null;
    await runSealed('console', null, 'premium', async ledger => {
      emit(expired('e1', 'g2'));
      expect(h.gates).toHaveLength(1);
      waiting = pm.settled(ledger).then(() => { done = true; });
      await tick(10);
      emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'c1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() });
    });
    await tick(10);
    openRows();
    await until(() => notices.sent.length >= 2);
    await tick(30);
    expect(done).toBe(false);
    pause.open();
    await until(() => done);
    expect(done).toBe(true);
  });
});

describe('the exit lines of an audit line on a row op', () => {
  it('names nothing for a line whose op landed', () => {
    const pm = manager();
    emit(expired('e1', 'g2'));
    h.tickets[0].op.state = 'landed';
    pm.markStopped('stopping');
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('The audit line subscription.expire.paid'))).toEqual([]);
    expect(logged(spies.warn)).toContain('[PremiumManager] The paid.sub.expired notice for guild g2 was not sent: the bot is stopping');
  });

  it("names a line whose op ended unconfirmed as can't confirm", () => {
    const pm = manager();
    emit(expired('e1', 'g2'));
    h.tickets[0].op.state = 'unconfirmed';
    pm.markStopped('stopping');
    pm.logLossesAtExit();
    const lines = logged(spies.error).filter(l => l.includes('The audit line subscription.expire.paid'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("was being written before this stop; can't confirm whether it is stored:");
  });
});
