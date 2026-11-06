import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { setStepLayers } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import {
  _resetMaintenance, _setMaintenanceSender, _setMaintenanceTiming, enterMaintenance, startLeave, watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB5 code review round 1, C4, C5 and C9: the leave and the maintenance hook over the real maintenance.ts, the real
// working set and dataManager's real save, on a store that holds decision 11's latch (or decision 13's confirmation)
// as PostgresBackend answers it: every flush refused by the store's own state, nothing written.

const A = 'postgres://bot@a:5432/bot';
const WHY = 'a:5432/bot was replaced by node-b (generation 2)';
const CLAUSE = (n: number) => `${n} guild(s) are not re-saved yet on the bot's main database; their latest changes may exist only in the bot process`;

class OwnStateStore extends FakeStore {
  epoch = 1;
  latched = true;
  confirming: string | null = null;
  readonly sentBatches: GuildFlushBatch[] = [];
  databaseEpoch(): number { return this.epoch; }
  latchReason(): string | null { return this.latched ? WHY : null; }
  chosenEntry(): string { return A; }
  holdWords(): string | null {
    return this.confirming === null ? null : `the database answers again, but this process can't confirm yet that a:5432/bot is still the main (${this.confirming})`;
  }
  confirmNow(): void {}
  heldUntil(): number | null { return this.confirming === null ? null : Date.now(); }
  // maintenance's WatchedBackend side.
  onLoginRefused(): void {}
  async askDatabase(): Promise<'unreachable'> { return 'unreachable'; }
  refusesByOwnState(): boolean { return this.latched || this.confirming !== null; }
  confirmingWords(): string | null { return this.confirming; }
  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    this.sentBatches.push(batch);
    const own = this.latched ? `${WHY}; this process does not write to it` : this.holdWords();
    if (own !== null) return { ok: false, reason: 'unavailable', detail: own };
    return { ok: false, reason: 'unavailable', detail: 'SQLSTATE 57P03: the database system is starting up' };
  }
}

const sent: any[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot');
const heldReports = () => sent.filter(m => m.type === 'maintenance:mode' && m.data.mode === 'held');
let errors: string[] = [];
let warns: string[] = [];

async function flagged(n: number, store = new OwnStateStore()): Promise<{ store: OwnStateStore; ws: WorkingSetManager; guilds: string[] }> {
  setBackendKind('postgres');
  const ws = initWorkingSet(store);
  setGuildDataBackend(store as never);
  const guilds: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = String(890000000000000000n + BigInt(i + 1));
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    guilds.push(g);
  }
  ws.markForResave('a:5432/bot');
  return { store, ws, guilds };
}

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  errors = [];
  warns = [];
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 20, restartResendMs: 60, leaveSaveBoundMs: 50, heldAfterPasses: 2 });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  setStepLayers({ databaseStopWhy: () => null });
  setGuildDataBackend(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('C test 3 (a) and (d) over the real maintenance.ts', () => {
  it('(a) enterMaintenance with only 40 flags answers saved false with resaveGuilds 40 and logs the re-save clause', async () => {
    await flagged(40);
    const answer = await enterMaintenance('m', { handlerWaitMs: 0, saveBoundMs: 200 });
    expect(answer).toEqual({ saved: false, unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, resaveGuilds: 40 });
    expect(warns).toContain(`[Maintenance] ${CLAUSE(40)}`);
  });

  it('(d) C4: the leave with only flags asks no restart, logs the flags-only held line with the ids, and reports held', async () => {
    const { guilds } = await flagged(40);
    setStepLayers({ databaseStopWhy: () => WHY });
    startLeave('R');
    await vi.waitFor(() => expect(heldReports()).toHaveLength(1), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(restarts()).toEqual([]);
    expect(heldReports()[0].data.held).toEqual({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, resaveGuilds: 40 });
    expect(errors.filter(l => l.startsWith('[Maintenance] 2 saves in a row'))).toEqual([
      `[Maintenance] 2 saves in a row left 40 guild(s) waiting to be re-saved on the main, once one is found: ${guilds.join(', ')}; this process holds their newest state; the bot process stays off Discord (${WHY}) and does not restart until they are saved or the operator restarts it, which drops them`,
    ]);
  });

  it('(d) C4: flags beside a guild the database refuses for its content: no restart on the content path, and the held line names both', async () => {
    const { store, ws, guilds } = await flagged(2);
    store.latched = false;
    store.epoch += 1;
    ws.flagEpoch(store.epoch);
    const content = String(890000000000000099n);
    expect(await ws.hydrate(content, tokenFor())).toBe('ready');
    expect(ws.save(content, 'm', 'bad.json', '"x"')).toBe('accepted');
    store.flushGuild = async (guildId: string, batch: GuildFlushBatch) => {
      store.sentBatches.push(batch);
      return { ok: false, reason: 'unavailable', detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' };
    };
    setStepLayers({ databaseStopWhy: () => WHY });
    startLeave('R');
    await vi.waitFor(() => expect(heldReports().length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(restarts()).toEqual([]);
    const line = errors.find(l => l.startsWith('[Maintenance] 2 saves in a row'))!;
    expect(line.startsWith('[Maintenance] 2 saves in a row left changes unsaved: ')).toBe(true);
    expect(line).toContain(`; 2 guild(s) wait to be re-saved on a:5432/bot: ${guilds.join(', ')}; this process holds their newest state;`);
  });
});

describe('C5: standing() after the step ran', () => {
  it('the move done and a re-save still refused: the held line says the process stays off Discord with the last latch\'s why', async () => {
    const { store, ws } = await flagged(1);
    store.latched = false;
    store.epoch += 1;
    ws.flagEpoch(store.epoch);
    setStepLayers({ databaseStopWhy: () => WHY });
    startLeave('R');
    await vi.waitFor(() => expect(heldReports()).toHaveLength(1), { timeout: 5000 });
    const line = errors.find(l => l.startsWith('[Maintenance] ') && l.includes('re-saved on'))!;
    expect(line).toContain(`the bot process stays off Discord (${WHY}) and does not restart until`);
    expect(line).not.toContain('keeps running');
  });
});

describe("C9: round 3's NB5-R3-HOLD-NO-HELD-REPORT", () => {
  it('with the database unreachable to the watcher, a backend refusing by its own state (confirming) counts the passes: held line with the confirming standing, held report', async () => {
    const store = new OwnStateStore();
    store.latched = false;
    store.confirming = 'HTTP 403 (Missing Access)';
    setBackendKind('postgres');
    const ws = initWorkingSet(store);
    setGuildDataBackend(store as never);
    const g = '890000000000000200';
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    expect(ws.save(g, 'm', 'a.json', '"held"')).toBe('accepted');
    const watcher = watchDataBackend(store as never, { retryMs: 20, probeTimeoutMs: 20 });
    await watcher!.probeNow();
    startLeave('R');
    await vi.waitFor(() => expect(heldReports()).toHaveLength(1), { timeout: 5000 });
    expect(restarts()).toEqual([]);
    const line = errors.find(l => l.startsWith('[Maintenance] 2 saves in a row'))!;
    expect(line).toContain("the bot process keeps its changes unsaved until it can confirm that a:5432/bot is still the main (HTTP 403 (Missing Access))");
    expect(heldReports()[0].data.held).toMatchObject({ unsavedGuilds: 1, unsavedFiles: 0 });
  });
});
