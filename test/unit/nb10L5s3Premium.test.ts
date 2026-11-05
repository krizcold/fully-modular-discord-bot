import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 decisions 12, 13, 20 and 23 in premiumManager.ts: the bot's save retry and its back-off, the deposition and
// the final stop step, the exit drain's replay lines, the exit handler's loss lines, the journal delete's log, the
// journal read of the replay and the replay's drop.

const inject = vi.hoisted(() => ({
  refuse: new Map<string, string>(),
  closedLost: false,
  del: null as null | Record<string, unknown>,
  enqueueThrows: false,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const guard = (filename: string) => {
    const cause = inject.refuse.get(filename);
    if (cause) throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f); return real.appendDataTracked(f, o, l); },
    deleteDataTracked: (f: string, o: any) => (inject.del ? inject.del : real.deleteDataTracked(f, o)),
    sharedWritesClosedLost: () => inject.closedLost || real.sharedWritesClosedLost(),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    enqueueAppend: (p: string, l: string) => {
      if (inject.enqueueThrows) throw Object.assign(new Error('disk gone'), { code: 'EIO' });
      return real.enqueueAppend(p, l);
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, JOURNAL, linesOf, logged, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const AUDIT_FILE = 'premium-tiers.audit.jsonl';
const PREMIUM_FILE = 'premium-tiers.json';
const TS = '2026-10-01T00:00:00.000Z';

const landedTicket = (): any => ({ kind: 'file', path: 'x', seq: 1, record: { landed: 1 } });
const openTicket = (): any => ({ kind: 'file', path: 'x', seq: 2, record: { landed: 0 } });

function pending(action = 'tier.update', guildId?: string): any {
  const entry: any = { timestamp: TS, actor: 'admin', action, ...(guildId ? { guildId } : {}) };
  return { line: JSON.stringify(entry) + '\n', entry };
}

function install(state: string, extra: Record<string, unknown> = {}): any {
  const entry: any = { timestamp: TS, actor: 'admin', action: 'subscription.install.paid', subscriptionId: 'sub1' };
  return { state, webhook: false, line: JSON.stringify(entry) + '\n', entry, providerSubId: 'ps1', ...extra };
}

const event = (n = 1): any => ({
  type: 'subscription.expired', providerId: 'discord', providerSubId: `d${n}`, guildId: 'g1',
  state: { status: 'expired', startDate: TS, endDate: TS, autoRenew: false },
});

let spies: ReturnType<typeof quiet>;
let pm: any;

beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  inject.refuse.clear();
  inject.closedLost = false;
  inject.del = null;
  inject.enqueueThrows = false;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
  process.env.BOT_PROCESS_ROLE = 'bot';
  pm = getPremiumManager();
});
afterEach(async () => {
  inject.refuse.clear();
  inject.closedLost = false;
  inject.del = null;
  inject.enqueueThrows = false;
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the retry pass and its back-off', () => {
  it('a pass that leaves nothing held resets the delay to the first step and arms no timer', () => {
    pm.retryDelay = 4000;
    pm.retryPass();
    expect(pm.retryDelay).toBe(1000);
    expect(pm.retryTimer).toBeNull();
  });

  it('a save refused again doubles the delay and arms the next retry', () => {
    inject.refuse.set(PREMIUM_FILE, 'storage-failing');
    pm.saveHeld = true;
    pm.retryPass();
    expect(pm.saveHeld).toBe(true);
    expect(pm.retryDelay).toBe(2000);
    expect(pm.retryTimer).not.toBeNull();
  });

  it('a held audit line refused again doubles the delay and arms the next retry', () => {
    inject.refuse.set(AUDIT_FILE, 'storage-failing');
    pm.heldLines = [pending()];
    pm.retryPass();
    expect(pm.heldLines).toHaveLength(1);
    expect(pm.retryDelay).toBe(2000);
    expect(pm.retryTimer).not.toBeNull();
  });
});

describe('one pass: the held save, then the held lines', () => {
  it('a held save that lands lets the held lines be appended in the same pass', async () => {
    pm.saveHeld = true;
    pm.heldLines = [pending('tier.update', 'g1')];
    pm.runPass();
    expect(pm.saveHeld).toBe(false);
    expect(pm.heldLines).toEqual([]);
    await settleQueue();
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['tier.update']);
  });

  it('a held save refused again keeps the held lines behind it, unwritten', async () => {
    inject.refuse.set(PREMIUM_FILE, 'storage-failing');
    pm.saveHeld = true;
    pm.heldLines = [pending('tier.update', 'g1')];
    pm.runPass();
    expect(pm.heldLines).toHaveLength(1);
    await settleQueue();
    expect(fs.existsSync(AUDIT)).toBe(false);
  });

  it('a line refused by the storage records that cause for the lines held behind it', () => {
    inject.refuse.set(AUDIT_FILE, 'storage-failing');
    pm.heldCause = 'io';
    pm.heldLines = [pending()];
    pm.runPass();
    expect(pm.heldCause).toBe('storage-failing');
  });

  it("a line refused by the stop keeps the earlier storage cause", () => {
    inject.refuse.set(AUDIT_FILE, 'node-stopping');
    pm.heldCause = 'storage-failing';
    pm.heldLines = [pending()];
    pm.runPass();
    expect(pm.heldCause).toBe('storage-failing');
  });

  it('a line refused by a deposition keeps the earlier storage cause', () => {
    inject.refuse.set(AUDIT_FILE, 'writer-lost');
    pm.heldCause = 'storage-failing';
    pm.heldLines = [pending()];
    pm.runPass();
    expect(pm.heldCause).toBe('storage-failing');
  });
});

describe('the deposition and the final stop step', () => {
  it('a second stop keeps the first kind, so the final stop words the losses for the deposition', () => {
    inject.refuse.set(PREMIUM_FILE, 'storage-failing');
    pm.saveHeld = true;
    pm.markStopped('deposed');
    pm.markStopped('stopping');
    expect(pm.stopped).toBe('deposed');
    pm.finalStop();
    expect(logged(spies.error)).toContain('[PremiumManager] premium-tiers.json holds changes the disk refused; they are lost: another process took the data files');
  });

  it('a deposition clears the armed retry', () => {
    pm.armRetry();
    expect(pm.retryTimer).not.toBeNull();
    pm.markStopped('deposed');
    expect(pm.retryTimer).toBeNull();
  });

  it('a disposed manager logs nothing at the final stop and stays unstopped', () => {
    pm.saveHeld = true;
    pm.heldLines = [pending()];
    pm.dispose();
    pm.finalStop();
    expect(logged(spies.error)).toEqual([]);
    expect(pm.stopped).toBeNull();
  });

  it('the final stop runs one last pass: a held save that now lands is not logged as lost', async () => {
    pm.saveHeld = true;
    pm.finalStop();
    expect(pm.saveHeld).toBe(false);
    expect(logged(spies.error).filter(l => l.includes('holds changes the disk refused'))).toEqual([]);
  });

  it("a held line with no guild is logged with guild none", () => {
    inject.refuse.set(AUDIT_FILE, 'storage-failing');
    pm.heldLines = [pending('tier.update')];
    pm.finalStop();
    expect(logged(spies.error)).toContain(`[PremiumManager] The audit line tier.update (guild none, ${TS}) was refused by the disk and is lost with this stop`);
  });

  it('a held install line with no guild is logged with guild none', () => {
    inject.refuse.set(AUDIT_FILE, 'storage-failing');
    const held = install('held');
    pm.heldLines = [{ line: held.line, entry: held.entry, install: held }];
    pm.finalStop();
    expect(logged(spies.error)).toContain(`[PremiumManager] The audit line subscription.install.paid (guild none, subscription ps1) was refused by the disk before this stop and is lost: ${held.line.trimEnd()}`);
  });
});

describe('after the exit drain', () => {
  function ready(): void {
    pm.marksTicket = landedTicket();
    pm.replayBuffer = [pending('tier.update', 'g1')];
  }

  it('an empty buffer queues nothing and answers false', () => {
    pm.marksTicket = landedTicket();
    pm.replayBuffer = [];
    expect(pm.afterDrain()).toBe(false);
    expect(pm.afterDrainLines).toEqual([]);
  });

  it('a dropped replay queues nothing and answers false', async () => {
    ready();
    pm.replayDropped = true;
    expect(pm.afterDrain()).toBe(false);
    expect(pm.replayBuffer).toHaveLength(1);
    await settleQueue();
    expect(fs.existsSync(AUDIT)).toBe(false);
  });

  it('a disposed manager queues nothing and answers false', () => {
    ready();
    pm.disposed = true;
    expect(pm.afterDrain()).toBe(false);
    expect(pm.replayBuffer).toHaveLength(1);
  });

  it('shared writes closed by a loss queue nothing and answer false', async () => {
    ready();
    inject.closedLost = true;
    expect(pm.afterDrain()).toBe(false);
    expect(pm.replayBuffer).toHaveLength(1);
    await settleQueue();
    expect(fs.existsSync(AUDIT)).toBe(false);
  });

  it('a queue that throws keeps the lines, logs the errno and answers false', () => {
    ready();
    inject.enqueueThrows = true;
    expect(pm.afterDrain()).toBe(false);
    expect(pm.replayBuffer).toHaveLength(1);
    expect(logged(spies.error)).toEqual(["[PremiumManager] The replay's audit lines could not be queued after the exit drain (EIO)"]);
  });

  it('a queued plain line is tracked, and the exit logs it as lost while it has not landed', () => {
    ready();
    expect(pm.afterDrain()).toBe(true);
    expect(pm.afterDrainLines).toHaveLength(1);
    pm.logLossesAtExit();
    const line = JSON.stringify(pending('tier.update', 'g1').entry);
    expect(logged(spies.error)).toEqual([`[PremiumManager] The audit line tier.update (guild g1, ${TS}) did not reach the disk before this stop and is lost: ${line}`]);
  });
});

describe('the exit handler', () => {
  const lostLine = (n: number) => `[PremiumManager] A subscription.expired event from discord (subscription d${n}, guild g1) was received while premium-tiers.json could not be read and is lost with this stop: ${JSON.stringify(event(n))}`;

  it('events at or under the landed marks are covered; one above them is logged', () => {
    pm.marksTicket = landedTicket();
    pm.raisedMarks = { w: 2 };
    pm.journal = [1, 2, 3].map(n => ({ writer: 'w', n, event: event(n), file: 'premium-tiers.json' }));
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([lostLine(3)]);
  });

  it('marks that have not landed cover nothing', () => {
    pm.marksTicket = openTicket();
    pm.raisedMarks = { w: 5 };
    pm.journal = [{ writer: 'w', n: 1, event: event(1), file: 'premium-tiers.json' }];
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([lostLine(1)]);
  });

  it('a replay stopped before handing any event says nothing about notices going out twice', () => {
    pm.replayStarted = true;
    pm.replayHanded = 0;
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual(['[PremiumManager] The stop came before the kept provider events were saved; they stay in premium-tiers.events.jsonl, and the next normal start of the bot applies them']);
  });

  it('an install line that is not queued is not logged even with an open ticket', () => {
    pm.installLines.set('sub1', install('landed', { ticket: openTicket() }));
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  });

  it('a buffered replay line that never reached the disk is logged with guild none and its JSON', () => {
    pm.marksTicket = landedTicket();
    const p = pending('tier.update');
    pm.replayBuffer = [p];
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([`[PremiumManager] The audit line tier.update (guild none, ${TS}) did not reach the disk before this stop and is lost: ${p.line.trimEnd()}`]);
  });

  it('a queued plain line whose ticket landed is not logged', () => {
    pm.marksTicket = landedTicket();
    pm.afterDrainLines = [{ ...pending('tier.update', 'g1'), ticket: landedTicket() }];
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  });

  it('a buffered install line is logged once, as an install line', () => {
    pm.marksTicket = landedTicket();
    const b = install('buffered');
    pm.replayBuffer = [{ line: b.line, entry: b.entry, install: b }];
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([`[PremiumManager] The audit line subscription.install.paid (guild none, subscription ps1) did not reach the disk before this stop and is lost: ${b.line.trimEnd()}`]);
  });

  it('an install line in the buffer that is already queued is not logged there', () => {
    pm.marksTicket = landedTicket();
    const q = install('queued', { ticket: openTicket() });
    pm.replayBuffer = [{ line: q.line, entry: q.entry, install: q }];
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  });
});

describe('the journal delete after a replay', () => {
  it('a frozen delete is logged with its cause', () => {
    inject.del = { outcome: 'frozen' };
    pm.queueJournalDelete();
    expect(logged(spies.error)).toEqual(['[PremiumManager] premium-tiers.events.jsonl could not be deleted (frozen); eventsApplied covers its lines, and the next start deletes it']);
  });

  it('an accepted delete logs nothing', () => {
    inject.del = { outcome: 'deleted', ticket: landedTicket() };
    pm.queueJournalDelete();
    expect(logged(spies.error)).toEqual([]);
  });
});

describe('the journal read of the replay', () => {
  it("skips this process's own lines and a repeated line of another writer", async () => {
    pm.journalEvent(event(9));
    const own = pm.journal[0].writer;
    await settleQueue();
    const lines = [
      { writer: own, n: 1, event: event(9) },
      { writer: 'other', n: 1, event: event(1) },
      { writer: 'other', n: 1, event: event(1) },
      { writer: 'other', n: 2, event: event(2) },
    ];
    fs.writeFileSync(JOURNAL, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    expect(pm.journalFromDisk()).toEqual([lines[1], lines[3]]);
  });
});

describe('the replay drop', () => {
  it('drops the buffer and its install lines, and later replay lines are not buffered', async () => {
    const b = install('buffered');
    pm.installLines.set('sub1', b);
    pm.replayBuffer = [{ line: b.line, entry: b.entry, install: b }];
    pm.dropReplay();
    expect(pm.replayDropped).toBe(true);
    expect(pm.replayBuffer).toEqual([]);
    expect(pm.installLines.has('sub1')).toBe(false);
    await runSealed('console', null, 'premium', async ledger => {
      pm.replayLedgers.add(ledger);
      pm.writeAudit(pending('tier.update', 'g1').entry);
    });
    expect(pm.replayBuffer).toEqual([]);
  });
});
