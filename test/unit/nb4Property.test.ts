import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ autoConfig: '', installedModules: null as null | (() => void) }));

vi.mock('../../src/utils/dataRoot', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    dataPath: (...segments: string[]) => (segments.join('/') === 'global/appstore/config.json' ? h.autoConfig : real.dataPath(...segments)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({ getInstalledModules: () => { h.installedModules?.(); return []; } }),
}));

import {
  CLOCK_GAP_CAP_MS,
  claimTimings,
  fenceAdmits,
  uPrime,
  type Pair,
} from '../../src/bot/internalSetup/fleet/claimRules';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setStoppedServingHook, stoppedServing } from '../../src/bot/internalSetup/utils/servingGate';
import { admitGuildAction, dispatchGated, runAsAdmitted } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { maintenanceIpcRefusal } from '../../src/bot/internalSetup/utils/maintenance';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeStore } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';
import { stopSteps } from '../helpers/stopRig';

// NB4 invariants 1, 2, 3 and 3b, sheet unit 9 (R2-T10): two to four processes on one claims store (the fake store, over
// the same pure rules the claims SQL matches) and one database clock. Each process has a real working set whose
// backend applies the fence to one shared store of guild documents; it serves a pair only until D after the send of
// the renewal (or the take) that last returned it. Ticks, takes, Discord logins, a 28000 between a boot take and its
// login (through that process's own real maintenance module), reservations, cut-offs, outages, maintenance, crashes,
// stops, writes, buffered events, held interactions, web UI requests, auto-updater ticks, failing flushes and frozen
// processes come in any order; each process has a web UI or not. Queued items run through the real gates, and a process
// with no web UI ends through the real leave, requestRestart and stop handler. The model computes each pair's expiry by
// decision 4 on its own, to judge the store. Each run ends with every process healed, where property (f) is judged.

const T = claimTimings(30);
const TAKEOVER_MS = 30_000;
const COUNT = 3;
const RUNS = Number(process.env.SMDB_NB4_PROPERTY_RUNS) || 200;
const guildOf = (shardId: number) => String(BigInt(shardId) << 22n);

type QueuedKind = 'event' | 'hold' | 'webui' | 'auto';

interface Proc {
  id: string;
  node: string;
  capacity: number;
  webUi: boolean;
  /** Each pair as this process knows it, with the expiry decision 4 gives its last write (the model's own count). */
  held: Map<number, { claim: number; at: number; expiry: number; extended: boolean }>;
  /** Reservations: written released, renewed with the held pairs, served by no one until the restart takes them. */
  reserved: Map<number, { claim: number }>;
  cut: boolean;
  /** The process ran its stop-serving step: once one pair passed D, it serves no shard again. */
  stopped: boolean;
  /** A process with no web UI whose leave or stop ended: set only once the real stop handler called process.exit. */
  exited: boolean;
  /** A process with no web UI whose leave or stop ended, handed to the real maintenance and stop handler modules. */
  ended: boolean;
  /** The codes the real stop handler passed to process.exit for this process. */
  exitCodes: number[];
  /** Maintenance ended while this process lived: its gate stays closed and NB2's leave runs (P9, P9b). */
  leaving: boolean;
  /** A process with no web UI that lived when maintenance ended: its leave must end in the stop and exit. */
  mustExit: boolean;
  /** Its next take is a boot take (decision 10), until one answers without waiting for a predecessor. */
  booting: boolean;
  /** A take answered for this process; with no web UI it takes only once, as it starts. */
  tookOnce: boolean;
  ws: WorkingSetManager;
  /** Buffered events, held interactions, web UI requests and auto-updater ticks, each to run its write later. */
  queued: Array<{ kind: QueuedKind; shardId: number; admission?: Awaited<ReturnType<typeof admitGuildAction>>; interaction?: object }>;
  /** Writes the working set accepted, by sequence. */
  accepted: Array<{ guildId: string; seq: number }>;
  /** Writes a flush sent and the fence refused. */
  dropped: Array<{ guildId: string; seq: number }>;
  dropLines: string[];
  restarts: number;
  /** Restarts after a leave or a stop (not after a crash): a process with no web UI has none. */
  leaveRestarts: number;
  /** The class of its latest renewal attempt, as ShardClaims keeps it: null after one that completed. */
  lastFailure: 'unreachable' | 'refused' | null;
  lastAttemptAt: number;
  /** Its boot take answered and its Discord login has not come yet: no event, interaction or request reaches it. */
  loggingIn: boolean;
  /** A 28000 reached it in that phase: its own fresh maintenance, gate, serving-gate and dataManager modules. */
  real: RealMods | null;
}

interface RealMods {
  m: typeof import('../../src/bot/internalSetup/utils/maintenance');
  gate: typeof import('../../src/bot/internalSetup/utils/maintenanceGate');
  dm: typeof import('../../src/bot/internalSetup/utils/dataManager');
  sent: Array<{ type: string }>;
  stoppedAtRefusal: boolean;
  /** Every renewal attempt since the 28000 was refused. */
  onlyRefused: boolean;
}

interface World {
  now: number;
  store: MemClaimStore;
  db: FakeStore;
  stamps: Map<string, number>;
  procs: Proc[];
  allAway: boolean;
  /**
   * Maintenance for every process (decision 22). 'refused': the bot role's login is refused, no renewal completes and D
   * is held off. 'hook': the gate is closed while the login works; renewals go on, the clock runs, D counts other
   * failures, and no process is fit to take or reserve.
   */
  maint: null | 'hook' | 'refused';
  /** One flush of this process id and guild fails before it reaches the database. */
  failNext: Set<string>;
  writes: number;
  /** Takes that replaced another process's pair before the expiry the model computed for it (property (e)). */
  early: string[];
  /** Writes a ws.save accepted from a process past its D, also from a queued event, hold or request (property (g)). */
  lateAccepts: string[];
  /** Saves the store took under a pair its row did not hold (property (b)). */
  foreignSaves: string[];
}

type Cmd =
  | { kind: 'advance'; ms: number }
  | { kind: 'tick'; p: number }
  | { kind: 'take'; p: number }
  | { kind: 'reserve'; p: number }
  | { kind: 'cut'; p: number }
  | { kind: 'heal'; p: number }
  | { kind: 'away' }
  | { kind: 'back' }
  | { kind: 'maintOn'; cause: 'hook' | 'refused' }
  | { kind: 'maintOff' }
  | { kind: 'crash'; p: number }
  | { kind: 'stop'; p: number }
  | { kind: 'write'; p: number; shard: number }
  | { kind: 'queue'; p: number; shard: number; what: QueuedKind; admitNow: boolean }
  | { kind: 'failFlush'; p: number; shard: number }
  | { kind: 'flush'; p: number }
  | { kind: 'frozen'; p: number; ms: number }
  | { kind: 'cutoff'; p: number; rounds: number }
  | { kind: 'login'; p: number }
  | { kind: 'refuseDuringBoot'; p: number };

const reaches = (w: World, p: Proc) => !p.exited && !p.cut && !w.allAway && w.maint !== 'refused';
const gateClosed = (w: World, p: Proc) => (p.real ? p.real.gate.isMaintenanceGateClosed() : w.maint !== null) || p.leaving;
const pastD = (w: World, p: Proc) => [...p.held.values()].some(h => w.now - h.at >= T.deadlineMs);
const serving = (w: World, p: Proc, shardId: number) => {
  const h = p.held.get(shardId);
  return !p.exited && !p.stopped && !!h && w.now - h.at < T.deadlineMs;
};
const rowOf = (w: World, shardId: number) => w.store.rows.get(`${COUNT}:${shardId}`);
const meOf = (p: Proc) => ({ processId: p.id, nodeId: p.node, nodeName: p.node });

const fenceKey = (t: FenceToken) => ({ shardCount: t.shardCount, shardId: t.shardId, claim: t.claim as number, processId: t.processId as string });

function backendFor(w: World, p: Proc): FakeStore {
  const b = Object.create(w.db) as any;
  b.hydrateGuild = async (guildId: string, token: FenceToken) => {
    if (!reaches(w, p)) return { ok: false, reason: 'unavailable' };
    if (!fenceAdmits(rowOf(w, token.shardId), fenceKey(token), w.stamps.get(guildId))) return { ok: false, reason: 'deposed' };
    w.stamps.set(guildId, token.claim!);
    return FakeStore.prototype.hydrateGuild.call(w.db, guildId);
  };
  b.flushGuild = async (guildId: string, batch: GuildFlushBatch, token: FenceToken) => {
    if (!reaches(w, p)) return { ok: false, reason: 'unavailable', detail: 'connect ECONNREFUSED' };
    if (w.failNext.delete(`${p.id}:${guildId}`)) return { ok: false, reason: 'unavailable', detail: 'Connection terminated' };
    if (!fenceAdmits(rowOf(w, token.shardId), fenceKey(token), w.stamps.get(guildId))) {
      for (const u of batch.upserts) p.dropped.push({ guildId, seq: Number(u.doc) });
      return { ok: false, reason: 'deposed' };
    }
    w.stamps.set(guildId, token.claim!);
    const row = rowOf(w, token.shardId);
    if (!row || row.claim !== token.claim || row.holderProcess !== token.processId || row.released) w.foreignSaves.push(`${p.id} saved ${guildId} under claim ${token.claim}`);
    return FakeStore.prototype.flushGuild.call(w.db, guildId, batch, token);
  };
  return b as FakeStore;
}

function world(n: number, capacities: number[], webUi: boolean[] = [true, true, true, true]): World {
  const w = {} as World;
  Object.assign(w, {
    now: 1_000_000, db: new FakeStore(), stamps: new Map(), allAway: false, maint: null, failNext: new Set(), writes: 0,
    early: [], lateAccepts: [], foreignSaves: [], procs: [],
  });
  w.store = new MemClaimStore(() => w.now);
  for (let i = 0; i < n; i++) {
    const p = {
      id: `p${i}`, node: `n${i}`, capacity: capacities[i], webUi: webUi[i], held: new Map(), reserved: new Map(), cut: false,
      stopped: false, exited: false, ended: false, exitCodes: [], leaving: false, mustExit: false, booting: false, tookOnce: false, queued: [], accepted: [], dropped: [], dropLines: [], restarts: 0, leaveRestarts: 0,
      lastFailure: null, lastAttemptAt: w.now, loggingIn: false, real: null,
    } as unknown as Proc;
    p.ws = new WorkingSetManager(backendFor(w, p));
    w.procs.push(p);
  }
  return w;
}

const pairsOf = (p: Proc): Pair[] => [
  ...[...p.held].map(([shardId, h]) => ({ shardCount: COUNT, shardId, claim: h.claim })),
  ...[...p.reserved].map(([shardId, r]) => ({ shardCount: COUNT, shardId, claim: r.claim })),
];

/** A new process on p's node, with a boot take: after a crash, or after a leave or a stop of a process with a web UI. */
function restartOrExit(w: World, p: Proc, crashed: boolean): void {
  dropReal(p);
  p.lastFailure = null;
  p.lastAttemptAt = w.now;
  p.loggingIn = false;
  p.held = new Map();
  p.reserved = new Map();
  p.queued = [];
  p.stopped = false;
  p.leaving = false;
  p.mustExit = false;
  p.restarts += 1;
  if (!crashed) p.leaveRestarts += 1;
  p.id = `${p.node}-r${p.restarts}`;
  p.booting = true;
  p.tookOnce = false;
  p.ws = new WorkingSetManager(backendFor(w, p));
}

/** The stop handler's claim steps after its drain: one release of what the process still holds, listing its reservations. */
async function release(w: World, p: Proc): Promise<void> {
  if (!reaches(w, p)) return;
  await w.store.release({ me: meOf(p), reserved: [...p.reserved].map(([shardId, r]) => ({ shardCount: COUNT, shardId, claim: r.claim })), handOvers: [], ttlMs: T.ttlMs });
}

let exitTarget: Proc | null = null;
let maintLeaves = 0;
const strayExits: unknown[] = [];

/**
 * The end of a leave or a stop. A process with a web UI releases and restarts. One with no web UI goes through fresh
 * real maintenance and dataManager modules with no IPC channel: the leave's end asks requestRestart, which finds nothing
 * to restart it and runs the stop handler; a stop runs the handler at once. It counts as exited only once that handler
 * called process.exit.
 */
async function endProcess(w: World, p: Proc, how: 'leave' | 'stop'): Promise<void> {
  if (p.leaving && how === 'leave') maintLeaves += 1;
  if (p.webUi) {
    await release(w, p);
    restartOrExit(w, p, false);
    return;
  }
  p.ended = true;
  vi.resetModules();
  const m = await import('../../src/bot/internalSetup/utils/maintenance');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const realSend = process.send;
  (process as { send?: unknown }).send = undefined;
  exitTarget = p;
  try {
    const handler = stopSteps(dm, {
      claims: () => ({ beginStop: () => undefined, finishStop: () => release(w, p) }),
      drain: async () => {
        if (!reaches(w, p)) return;
        await p.ws.flushAllDirty();
        p.dropLines.push(...p.ws.takeDropLines());
      },
    });
    if (how === 'leave') m.startLeave(p.leaving ? 'Maintenance ended' : 'The claims lapsed');
    else await handler();
    await vi.waitFor(() => expect(p.exitCodes.length).toBeGreaterThan(0), { timeout: 5_000, interval: 1 });
  } finally {
    (process as { send?: unknown }).send = realSend;
    exitTarget = null;
    m._resetMaintenance();
  }
  p.held = new Map();
  p.reserved = new Map();
  p.queued = [];
  p.leaving = false;
  p.exited = true;
}

function dropReal(p: Proc): void {
  p.real?.m._resetMaintenance();
  p.real = null;
}

const bootRefusals = { logins: 0, exits: 0 };

/**
 * The maintenance command refuses the login while q is between its boot take and its Discord login: the 28000 reaches
 * q's own fresh maintenance module through watchDataBackend's onLoginRefused, before markDiscordStarted. The gate
 * closes at once and the leave starts; with nothing held it asks the web UI for the restart, or, with no web UI,
 * ends in the real stop handler's release and exit.
 */
async function refuseAtBoot(w: World, q: Proc): Promise<void> {
  expect(q.ws.dirtyGuildIds()).toEqual([]);
  vi.resetModules();
  const m = await import('../../src/bot/internalSetup/utils/maintenance');
  const gate = await import('../../src/bot/internalSetup/utils/maintenanceGate');
  const sg = await import('../../src/bot/internalSetup/utils/servingGate');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const real: RealMods = { m, gate, dm, sent: [], stoppedAtRefusal: q.stopped, onlyRefused: true };
  q.real = real;
  sg.setStoppedServingHook(() => servingStopped(w, q));
  if (q.webUi) m._setMaintenanceSender(message => { real.sent.push(message as { type: string }); });
  const realSend = process.send;
  (process as { send?: unknown }).send = undefined;
  exitTarget = q;
  try {
    let fire: () => void = () => undefined;
    m.watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => 'refused' }, { retryMs: 3_600_000 });
    if (!q.webUi) {
      stopSteps(dm, {
        claims: () => ({ beginStop: () => undefined, finishStop: () => release(w, q) }),
        drain: async () => { await q.ws.flushAllDirty(); },
      });
    }
    fire();
    q.lastFailure = 'refused';
    q.lastAttemptAt = w.now;
    expect([gate.isMaintenanceGateClosed(), gate.maintenanceCause()]).toEqual([true, 'login-refused']);
    if (q.webUi) {
      await vi.waitFor(() => expect(real.sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1), { timeout: 5_000, interval: 1 });
      return;
    }
    await vi.waitFor(() => expect(q.exitCodes.length).toBeGreaterThan(0), { timeout: 5_000, interval: 1 });
  } finally {
    (process as { send?: unknown }).send = realSend;
    exitTarget = null;
  }
  bootRefusals.exits += 1;
  dropReal(q);
  q.ended = true;
  q.held = new Map();
  q.reserved = new Map();
  q.queued = [];
  q.loggingIn = false;
  q.leaving = false;
  q.exited = true;
}

/**
 * q's Discord login after the 28000 of its boot: an interaction gets only the maintenance text (or nothing once q
 * stopped serving), a guild write through dataManager and the model's save are refused, and D has not lapsed while
 * every renewal was refused. Then the web UI carries out the restart the leave asked for.
 */
async function loginAfterRefusal(w: World, q: Proc): Promise<void> {
  const real = q.real!;
  real.m.markDiscordStarted();
  expect(real.gate.isMaintenanceGateClosed()).toBe(true);
  const client = Object.assign(new EventEmitter(), { options: { ws: {} } }) as any;
  real.m.installMaintenanceGate(client);
  const handler = vi.fn();
  client.on('interactionCreate', handler);
  const reply = vi.fn(async () => undefined);
  const [shardId] = q.held.keys();
  const guildId = guildOf(shardId ?? 0);
  client.emit('interactionCreate', { guildId, isRepliable: () => true, replied: false, deferred: false, reply });
  await Promise.resolve();
  expect(handler).not.toHaveBeenCalled();
  if (lapse(w, q)) expect(reply).not.toHaveBeenCalled();
  else expect(reply.mock.calls.map(c => (c as any[])[0].content)).toEqual([real.gate.maintenanceText()]);
  let refusal: any = null;
  try { real.dm.saveData('d.json', { guildId, category: 'm' }, { v: 1 }); } catch (error) { refusal = error; }
  expect(refusal?.causeKey).toBe('maintenance');
  const accepted = q.accepted.length;
  saveNow(w, q, guildId);
  expect(q.accepted).toHaveLength(accepted);
  if (!real.stoppedAtRefusal && real.onlyRefused) expect(q.stopped).toBe(false);
  expect(real.sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1);
  bootRefusals.logins += 1;
  await release(w, q);
  restartOrExit(w, q, false);
}

async function tick(w: World, p: Proc): Promise<void> {
  const prevUp = w.store.clock.upMs;
  const answer = await w.store.renew({
    me: meOf(p), pairs: pairsOf(p), ttlMs: T.ttlMs,
    heartbeat: { capacity: p.capacity, takeoverSeconds: TAKEOVER_MS / 1000, fit: !p.stopped && !gateClosed(w, p), restartable: p.webUi, returns: true, startedAt: 0 },
  });
  p.lastFailure = null;
  p.lastAttemptAt = w.now;
  if (p.real) p.real.onlyRefused = false;
  const clock = w.store.clock;
  const mine = new Set(answer.rows.filter(r => r.mine && !r.released).map(r => r.shardId));
  const mineReserved = new Set(answer.rows.filter(r => r.mine && r.released).map(r => `${r.shardId}:${r.claim}`));
  for (const q of w.procs) {
    if (q === p) continue;
    for (const h of q.held.values()) {
      if (clock.lastGapMs > CLOCK_GAP_CAP_MS && h.expiry > prevUp && !h.extended) {
        h.expiry = Math.max(h.expiry, clock.upMs + T.ttlMs);
        h.extended = true;
      }
    }
  }
  for (const [shardId, h] of p.held) {
    if (mine.has(shardId)) Object.assign(h, { at: w.now, expiry: clock.upMs + T.ttlMs, extended: false });
    else p.held.delete(shardId);
  }
  for (const [shardId, r] of p.reserved) if (!mineReserved.has(`${shardId}:${r.claim}`)) p.reserved.delete(shardId);
}

async function take(w: World, p: Proc, reserve: boolean): Promise<void> {
  // A reservation is asked only by a process that can be restarted to take it; one with no web UI takes only as it starts.
  if (!reaches(w, p) || p.stopped || gateClosed(w, p) || (reserve && (p.booting || !p.webUi)) || (!p.webUi && p.tookOnce)) return;
  const before = new Map([...w.store.rows].map(([k, r]) => [k, { ...r }]));
  const u = uPrime(w.store.clock, w.now);
  const got = await w.store.take({ me: meOf(p), capacity: p.capacity, ttlMs: T.ttlMs, boot: p.booting, known: pairsOf(p), localCount: COUNT, reserve });
  if (got.kind !== 'done' || got.plan.wait) return;
  if (p.booting) p.loggingIn = true;
  p.booting = false;
  p.tookOnce = true;
  for (const t of got.taken) {
    const prior = before.get(`${COUNT}:${t.pair.shardId}`);
    if (prior && !prior.released && prior.holderProcess !== p.id) {
      const q = w.procs.find(x => x.id === prior.holderProcess);
      const h = q?.held.get(t.pair.shardId);
      if (h && h.claim === prior.claim && w.store.clock.upMs < h.expiry) w.early.push(`${p.id} took shard ${t.pair.shardId} at ${w.store.clock.upMs} before ${h.expiry}`);
    }
    // The store's take writes its expiry from u', the model's own count (R6-TEST-2).
    expect(rowOf(w, t.pair.shardId)!.expiresUpMs).toBe(u + T.ttlMs);
    expect(rowOf(w, t.pair.shardId)!.released).toBe(reserve);
    if (reserve) p.reserved.set(t.pair.shardId, { claim: t.pair.claim });
    else p.held.set(t.pair.shardId, { claim: t.pair.claim, at: w.now, expiry: u + T.ttlMs, extended: false });
  }
}

/**
 * What a renewal attempt of p finds now: a cut process or a database no process reaches is unreachable whatever the
 * login does; a reachable server under a refused login refuses it.
 */
const failureOf = (w: World, p: Proc): 'unreachable' | 'refused' | null => (p.cut || w.allAway ? 'unreachable' : w.maint === 'refused' ? 'refused' : null);
let refusedLapses = 0;

function attempt(w: World, p: Proc): void {
  p.lastFailure = failureOf(w, p);
  p.lastAttemptAt = w.now;
  if (p.real && p.lastFailure !== 'refused') p.real.onlyRefused = false;
}

/**
 * Decision 6 as ShardClaims.pastDeadline runs it: past D, a lapse unless the latest renewal failure is a refused login
 * under a closed gate; one-way. The class is the latest attempt's; the real renewal runs every R, so a class older than
 * R is replaced by what an attempt finds now (one that would complete renews nothing here, which only lapses earlier).
 */
function lapse(w: World, p: Proc): boolean {
  if (!p.stopped && !p.exited && pastD(w, p)) {
    if (w.now - p.lastAttemptAt >= T.renewMs) attempt(w, p);
    if (!(p.lastFailure === 'refused' && gateClosed(w, p))) {
      p.stopped = true;
      if (w.maint === 'refused' && p.lastFailure === 'unreachable') refusedLapses += 1;
    }
  }
  return p.stopped;
}

const servingStopped = (w: World, p: Proc) => lapse(w, p);

let hookDepth = 0;
async function asProcess<T>(w: World, p: Proc, fn: () => T | Promise<T>): Promise<T> {
  if (hookDepth++ === 0) setStoppedServingHook(() => servingStopped(w, p));
  try {
    return await fn();
  } finally {
    if (--hookDepth === 0) setStoppedServingHook(null);
  }
}

let autoTick: (() => void) | null = null;
const queuedRuns = { handlers: { event: 0, hold: 0, webui: 0, auto: 0 } as Record<QueuedKind, number>, afterD: 0 };

/**
 * Each queued item through its real entry point: a buffered event's replay through dispatchGated, a held interaction
 * through admitGuildAction (at its queueing or now) and runAsAdmitted, a web UI panel action through the IPC refusal
 * and runPanelAction, and the auto-updater's interval callback. The handler is module code: any call of it while the
 * process stopped serving breaks (g).
 */
async function runQueued(w: World, p: Proc): Promise<void> {
  for (const item of p.queued.splice(0)) {
    const guildId = guildOf(item.shardId);
    if (servingStopped(w, p)) queuedRuns.afterD += 1;
    const handler = () => {
      queuedRuns.handlers[item.kind] += 1;
      if (servingStopped(w, p)) w.lateAccepts.push(`${p.id} ran a ${item.kind} handler for ${guildId} after its D`);
      if (p.ws.stateOf(guildId) === 'ready') saveNow(w, p, guildId);
    };
    await asProcess(w, p, async () => {
      switch (item.kind) {
        case 'event':
          await dispatchGated('messageCreate', [{ guildId, content: 'x' }], async () => handler());
          return;
        case 'hold': {
          const held = item.admission ?? await admitGuildAction(guildId, performance.now());
          if (held.cause === 'admit') runAsAdmitted([item.interaction ?? {}], handler);
          return;
        }
        case 'webui': {
          if (maintenanceIpcRefusal('panel:execute')) return;
          await runPanelAction('panel:execute', { guildId, panelId: 'nb4-panel', userId: 'u-1' }, {
            getPanel: () => undefined,
            getWebUIPanelList: () => [],
            executePanelForWebUI: async () => { handler(); return { success: true }; },
          });
          return;
        }
        case 'auto': {
          h.installedModules = handler;
          try {
            autoTick!();
          } finally {
            h.installedModules = null;
          }
        }
      }
    });
  }
}

/** Each process's deadline timer fires while the state before and after a command holds, so every live process is judged at both. */
async function step(w: World, cmd: Cmd): Promise<void> {
  for (const q of w.procs) lapse(w, q);
  await runCmd(w, cmd);
  for (const q of w.procs) lapse(w, q);
}

async function runCmd(w: World, cmd: Cmd): Promise<void> {
  const p = 'p' in cmd ? w.procs[cmd.p % w.procs.length] : null;
  if (p?.exited) return;
  if (p && (p.stopped || p.leaving) && cmd.kind === 'tick' && reaches(w, p)) {
    if (!(await leave(w, p))) return;
    if (p.exited) return;
  }
  switch (cmd.kind) {
    case 'advance': w.now += cmd.ms; return;
    case 'cut': p!.cut = true; return;
    case 'heal': p!.cut = false; return;
    case 'away': w.allAway = true; return;
    case 'back': w.allAway = false; return;
    case 'maintOn': if (!w.maint) w.maint = cmd.cause; return;
    case 'maintOff': {
      if (!w.maint) return;
      const cause = w.maint;
      w.maint = null;
      // The gate stays closed and every live process starts NB2's leave; after a refused login its first renewal decides.
      for (const q of w.procs) {
        if (q.exited) continue;
        q.leaving = true;
        if (!q.webUi) q.mustExit = true;
      }
      for (const q of w.procs) {
        if (!reaches(w, q)) continue;
        if (cause === 'refused') await tick(w, q);
        await leave(w, q);
      }
      return;
    }
    case 'crash': restartOrExit(w, p!, true); return;
    case 'stop': {
      if (p!.webUi && reaches(w, p!)) {
        await p!.ws.flushAllDirty();
        p!.dropLines.push(...p!.ws.takeDropLines());
      }
      await endProcess(w, p!, 'stop');
      return;
    }
    case 'tick': {
      if (!reaches(w, p!)) {
        attempt(w, p!);
        return;
      }
      await tick(w, p!);
      return;
    }
    case 'login': {
      if (!p!.loggingIn) return;
      if (p!.real) {
        await loginAfterRefusal(w, p!);
        return;
      }
      p!.loggingIn = false;
      return;
    }
    case 'refuseDuringBoot': {
      if (w.maint) return;
      const booting = w.procs.filter(q => q.loggingIn && !q.exited && !q.cut && !w.allAway);
      const q = booting.includes(p!) ? p! : booting[0];
      if (!q) return;
      w.maint = 'refused';
      await refuseAtBoot(w, q);
      return;
    }
    case 'take': await take(w, p!, false); return;
    case 'reserve': await take(w, p!, true); return;
    case 'write': {
      if (gateClosed(w, p!) || p!.loggingIn) return;
      const shardId = cmd.shard % COUNT;
      const h = p!.held.get(shardId);
      if (!h || !serving(w, p!, shardId)) return;
      const guildId = guildOf(shardId);
      const token: FenceToken = { nodeId: p!.node, claim: h.claim, processId: p!.id, shardId, shardCount: COUNT };
      const fence = (p!.ws as any).sets?.get(guildId)?.fence as FenceToken | undefined;
      if (p!.ws.stateOf(guildId) !== 'ready' || fence?.claim !== h.claim) {
        if (p!.ws.has(guildId) && p!.ws.dirtyGuildIds().includes(guildId)) return;
        p!.ws.evict(guildId);
        if ((await p!.ws.hydrate(guildId, token)) !== 'ready') return;
      }
      await save(w, p!, guildId);
      return;
    }
    case 'queue': {
      if (gateClosed(w, p!) || p!.loggingIn || !serving(w, p!, cmd.shard % COUNT)) return;
      const item: Proc['queued'][number] = { kind: cmd.what, shardId: cmd.shard % COUNT };
      if (cmd.what === 'hold' && cmd.admitNow) {
        item.interaction = {};
        item.admission = await asProcess(w, p!, () => admitGuildAction(guildOf(item.shardId), performance.now()));
      }
      p!.queued.push(item);
      return;
    }
    case 'failFlush': w.failNext.add(`${p!.id}:${guildOf(cmd.shard % COUNT)}`); return;
    case 'frozen': {
      // p's clocks jump past D while it sleeps; then its queued writes, buffered events, held interactions, web UI
      // requests and auto-updater ticks run before any timer.
      w.now += T.deadlineMs + cmd.ms;
      await runQueued(w, p!);
      for (const guildId of p!.ws.readyGuilds()) await save(w, p!, guildId);
      return;
    }
    case 'cutoff': {
      // p is cut off while the others tick and take every R, then heals.
      p!.cut = true;
      for (let i = 0; i < cmd.rounds; i++) {
        w.now += T.renewMs;
        for (const q of w.procs) {
          if (q === p) continue;
          await step(w, { kind: 'tick', p: w.procs.indexOf(q) });
          await step(w, { kind: 'take', p: w.procs.indexOf(q) });
        }
      }
      p!.cut = false;
      return;
    }
    case 'flush': {
      await runQueued(w, p!);
      if (!reaches(w, p!)) return;
      await p!.ws.flushAllDirty();
      p!.dropLines.push(...p!.ws.takeDropLines());
    }
  }
}

/** NB2's leave: save what the process holds; once nothing is dirty, its stop handler releases, then it restarts or exits. */
async function leave(w: World, p: Proc): Promise<boolean> {
  await p.ws.flushAllDirty();
  p.dropLines.push(...p.ws.takeDropLines());
  if (p.ws.dirtyGuildIds().length > 0) return false;
  await endProcess(w, p, 'leave');
  return true;
}

async function save(w: World, p: Proc, guildId: string): Promise<void> {
  saveNow(w, p, guildId);
}

function saveNow(w: World, p: Proc, guildId: string): void {
  if (gateClosed(w, p)) return;
  lapse(w, p);
  if (hookDepth++ === 0) setStoppedServingHook(() => servingStopped(w, p));
  try {
    const seq = ++w.writes;
    const answer = p.ws.save(guildId, 'm', 'd.json', String(seq));
    if (answer === 'accepted') {
      if (p.stopped || p.exited) w.lateAccepts.push(`${p.id} wrote ${guildId} after its D`);
      p.accepted.push({ guildId, seq });
    } else if (p.stopped) {
      expect(answer).toBe('frozen-window');
    }
  } finally {
    if (--hookDepth === 0) setStoppedServingHook(null);
  }
}

const cmdArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 9_000 }).map(ms => ({ kind: 'advance', ms }) as Cmd) },
  { weight: 6, arbitrary: fc.nat(3).map(p => ({ kind: 'tick', p }) as Cmd) },
  { weight: 3, arbitrary: fc.nat(3).map(p => ({ kind: 'take', p }) as Cmd) },
  { weight: 1, arbitrary: fc.nat(3).map(p => ({ kind: 'reserve', p }) as Cmd) },
  { weight: 1, arbitrary: fc.nat(3).map(p => ({ kind: 'cut', p }) as Cmd) },
  { weight: 1, arbitrary: fc.nat(3).map(p => ({ kind: 'heal', p }) as Cmd) },
  { weight: 1, arbitrary: fc.constant({ kind: 'away' } as Cmd) },
  { weight: 1, arbitrary: fc.constant({ kind: 'back' } as Cmd) },
  { weight: 1, arbitrary: fc.constantFrom<'hook' | 'refused'>('hook', 'refused').map(cause => ({ kind: 'maintOn', cause }) as Cmd) },
  { weight: 1, arbitrary: fc.constant({ kind: 'maintOff' } as Cmd) },
  { weight: 1, arbitrary: fc.nat(3).map(p => ({ kind: 'crash', p }) as Cmd) },
  { weight: 1, arbitrary: fc.nat(3).map(p => ({ kind: 'stop', p }) as Cmd) },
  { weight: 5, arbitrary: fc.tuple(fc.nat(3), fc.nat(COUNT - 1)).map(([p, shard]) => ({ kind: 'write', p, shard }) as Cmd) },
  {
    weight: 3,
    arbitrary: fc.tuple(fc.nat(3), fc.nat(COUNT - 1), fc.constantFrom<QueuedKind>('event', 'hold', 'webui', 'auto'), fc.boolean())
      .map(([p, shard, what, admitNow]) => ({ kind: 'queue', p, shard, what, admitNow }) as Cmd),
  },
  { weight: 1, arbitrary: fc.tuple(fc.nat(3), fc.nat(COUNT - 1)).map(([p, shard]) => ({ kind: 'failFlush', p, shard }) as Cmd) },
  { weight: 4, arbitrary: fc.nat(3).map(p => ({ kind: 'flush', p }) as Cmd) },
  { weight: 1, arbitrary: fc.tuple(fc.nat(3), fc.integer({ min: 0, max: 60_000 })).map(([p, ms]) => ({ kind: 'frozen', p, ms }) as Cmd) },
  { weight: 2, arbitrary: fc.tuple(fc.nat(3), fc.integer({ min: 1, max: 12 })).map(([p, rounds]) => ({ kind: 'cutoff', p, rounds }) as Cmd) },
  { weight: 3, arbitrary: fc.nat(3).map(p => ({ kind: 'login', p }) as Cmd) },
  { weight: 2, arbitrary: fc.nat(3).map(p => ({ kind: 'refuseDuringBoot', p }) as Cmd) },
);

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-nb4-prop-'));
  h.autoConfig = path.join(dir, 'config.json');
  fs.writeFileSync(h.autoConfig, JSON.stringify({ autoUpdate: true }));
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementationOnce(((fn: () => void) => { autoTick = fn; return {}; }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  startModuleAutoUpdater({} as any);
  interval.mockRestore();
  vi.restoreAllMocks();
  expect(autoTick).not.toBeNull();
  return () => stopModuleAutoUpdater();
});

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if (exitTarget) exitTarget.exitCodes.push(code ?? 0);
    else strayExits.push(code);
  }) as unknown as typeof process.exit);
});

afterEach(() => {
  hookDepth = 0;
  setStoppedServingHook(null);
  setBackendKind(null);
  vi.restoreAllMocks();
  expect(strayExits.splice(0)).toEqual([]);
});

/** (a) no two processes serve one shard at one instant; (b) every save the fence takes comes from the pair the row holds. */
function checkInstant(w: World): void {
  for (let shardId = 0; shardId < COUNT; shardId++) {
    expect(w.procs.filter(p => serving(w, p, shardId)).length).toBeLessThanOrEqual(1);
    const row = rowOf(w, shardId);
    const admitted = w.procs.filter(p => {
      const h = p.held.get(shardId);
      return !p.exited && !!h && fenceAdmits(row, { shardCount: COUNT, shardId, claim: h.claim, processId: p.id }, undefined);
    });
    expect(admitted.length).toBeLessThanOrEqual(1);
    for (const p of admitted) {
      expect(row!.claim).toBe(p.held.get(shardId)!.claim);
      expect(row!.holderProcess).toBe(p.id);
      expect(row!.released).toBe(false);
    }
  }
  for (const p of w.procs) if (p.exited) expect([p.held.size, p.reserved.size, p.queued.length]).toEqual([0, 0, 0]);
}

/**
 * (f): every process heals, the database answers, and each live process ticks and takes every R. While a process with a
 * web UI runs, every shard is served within 2 x TTL + the takeover delay + 2R; a process with no web UI whose leave or
 * stop ended has exited and serves nothing, and no process was left alive past its own leave.
 */
async function settle(w: World): Promise<{ servedAfterMs: number | null }> {
  w.allAway = false;
  for (const p of w.procs) p.cut = false;
  w.failNext.clear();
  await step(w, { kind: 'maintOff' });
  const t0 = w.now;
  const bound = 2 * T.ttlMs + TAKEOVER_MS + 2 * T.renewMs;
  let servedAfterMs: number | null = null;
  while (w.now - t0 <= bound + 4 * T.renewMs) {
    w.now += T.renewMs;
    for (let i = 0; i < w.procs.length; i++) {
      await step(w, { kind: 'tick', p: i });
      // A process holding a reservation asks its restart while fit (decision 15); the restart takes it.
      if (w.procs[i].reserved.size > 0 && !w.procs[i].stopped) await step(w, { kind: 'stop', p: i });
      await step(w, { kind: 'take', p: i });
      await step(w, { kind: 'login', p: i });
      await step(w, { kind: 'flush', p: i });
    }
    checkInstant(w);
    let all = true;
    for (let shardId = 0; shardId < COUNT; shardId++) all &&= w.procs.some(p => serving(w, p, shardId));
    if (all) {
      servedAfterMs = w.now - t0;
      break;
    }
  }
  if (w.procs.some(p => p.webUi)) {
    expect(servedAfterMs).not.toBeNull();
    expect(servedAfterMs!).toBeLessThanOrEqual(bound);
  }
  for (const p of w.procs) {
    if (p.exited) {
      expect(p.webUi).toBe(false);
      for (let shardId = 0; shardId < COUNT; shardId++) expect(serving(w, p, shardId)).toBe(false);
    }
    // A process with no web UI whose leave or stop ended was exited by the real stop handler, once, with 0.
    expect(p.exitCodes).toEqual(p.ended ? [0] : []);
    expect(p.exited).toBe(p.ended);
    if (!p.webUi) expect(p.leaveRestarts).toBe(0);
    // Every leave maintenance started has ended, and one with no web UI in the real stop handler's exit.
    expect(p.leaving).toBe(false);
    if (p.mustExit) expect([p.ended, p.exitCodes]).toEqual([true, [0]]);
  }
  return { servedAfterMs };
}

function checkEnd(w: World): void {
  const final = new Map<string, number>();
  for (let shardId = 0; shardId < COUNT; shardId++) {
    const doc = w.db.doc(guildOf(shardId), 'd.json');
    if (doc !== undefined) final.set(guildOf(shardId), Number(doc));
  }
  // (c) every write a flush landed is in the store, or a later landed write replaced it.
  for (const commit of w.db.commits) {
    for (const u of commit.batch.upserts) {
      const guildId = guildOf(commit.token.shardId);
      expect(final.get(guildId)).toBeGreaterThanOrEqual(Number(u.doc));
    }
  }
  // (d) every write the fence refused is in a drop line with its guild.
  for (const p of w.procs) {
    for (const drop of p.dropped) expect(p.dropLines.some(l => l.includes(drop.guildId))).toBe(true);
  }
  // (e) no take before the expiry decision 4 gives; (g) no write accepted after D.
  expect(w.early).toEqual([]);
  expect(w.lateAccepts).toEqual([]);
  expect(w.foreignSaves).toEqual([]);
}

// A drawn run reaches a refused flush only when a write, a cut-off past the expiry and a flush line up, which some seeds
// never draw; this run always does, so (d) is judged on every seed. Likewise a queued item reaches its handler only on a
// hydrated guild, which some seeds never draw for one kind; the second run queues each kind there, and one after D.
const dropExample: [number, number[], boolean[], Cmd[]] = [2, [3, 3, 0, 0], [true, true, true, true], [
  { kind: 'tick', p: 0 }, { kind: 'tick', p: 1 }, { kind: 'take', p: 0 }, { kind: 'write', p: 0, shard: 0 }, { kind: 'flush', p: 0 },
  { kind: 'write', p: 0, shard: 1 }, { kind: 'cutoff', p: 0, rounds: 12 }, { kind: 'flush', p: 0 },
]];
const queuedExample: [number, number[], boolean[], Cmd[]] = [2, [3, 0, 0, 0], [true, true, true, true], [
  { kind: 'tick', p: 0 }, { kind: 'tick', p: 1 }, { kind: 'take', p: 0 }, { kind: 'write', p: 0, shard: 0 },
  ...(['event', 'hold', 'webui', 'auto'] as const).map(what => ({ kind: 'queue', p: 0, shard: 0, what, admitNow: false }) as Cmd),
  { kind: 'queue', p: 0, shard: 0, what: 'hold', admitNow: true }, { kind: 'flush', p: 0 },
  { kind: 'queue', p: 0, shard: 0, what: 'event', admitNow: false }, { kind: 'frozen', p: 0, ms: 0 },
]];

describe('claims and saves under any order of commands', () => {
  it('(a) and (b) at every step; (c), (d), (e), (f) and (g) at the end', async () => {
    setBackendKind('postgres');
    const stats = { commits: 0, drops: 0, reservations: 0, crashes: 0, exits: 0, hook: 0, refused: 0, settled: 0, lateQueued: 0 };
    maintLeaves = 0;
    refusedLapses = 0;
    bootRefusals.logins = 0;
    bootRefusals.exits = 0;
    queuedRuns.handlers = { event: 0, hold: 0, webui: 0, auto: 0 };
    queuedRuns.afterD = 0;
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 4 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 4, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      fc.array(cmdArb, { minLength: 60, maxLength: 160 }),
      async (n, capacities, webUi, cmds) => {
        const w = world(n, capacities, webUi);
        for (const cmd of cmds) {
          if (cmd.kind === 'reserve') stats.reservations += 1;
          if (cmd.kind === 'crash') stats.crashes += 1;
          if (cmd.kind === 'maintOn' && !w.maint) stats[cmd.cause] += 1;
          if (cmd.kind === 'frozen') stats.lateQueued += w.procs[cmd.p % n].queued.length;
          await step(w, cmd);
          checkInstant(w);
        }
        const { servedAfterMs } = await settle(w);
        if (servedAfterMs !== null) stats.settled += 1;
        for (const p of w.procs) {
          if (reaches(w, p)) {
            await p.ws.flushAllDirty();
            p.dropLines.push(...p.ws.takeDropLines());
          }
        }
        checkEnd(w);
        expect(w.procs.filter(p => p.real !== null)).toEqual([]);
        stats.commits += w.db.commits.length;
        stats.drops += w.procs.reduce((k, p) => k + p.dropped.length, 0);
        stats.exits += w.procs.filter(p => p.exited).length;
      }), { numRuns: RUNS, examples: [dropExample, queuedExample] });
    // The runs reach both outcomes of a flush, and the new commands are drawn and reach their paths.
    expect(stats.commits).toBeGreaterThan(0);
    expect(stats.drops).toBeGreaterThan(0);
    expect(stats.settled).toBeGreaterThan(0);
    expect(stats.exits).toBeGreaterThan(0);
    expect(Math.min(stats.reservations, stats.crashes, stats.hook, stats.refused, stats.lateQueued)).toBeGreaterThan(0);
    // Leaves that ended after maintenance, so (f)'s "after maintenance" clause is judged.
    expect(maintLeaves).toBeGreaterThan(0);
    // Processes cut off under a refused login lapse at D, so the hold-off is judged against its unreachable case.
    expect(refusedLapses).toBeGreaterThan(0);
    // A 28000 reaches a process between its boot take and its login, through its real maintenance module: one with a
    // web UI then logs in behind the closed gate, one with none ends in its stop handler's exit.
    expect(Math.min(bootRefusals.logins, bootRefusals.exits)).toBeGreaterThan(0);
    // Queued items reach their handlers while serving, and some run after their process's D, through the real gates.
    expect(Math.min(...Object.values(queuedRuns.handlers), queuedRuns.afterD)).toBeGreaterThan(0);
  }, 300_000);
});

describe('the fixed examples', () => {
  it("p is cut off; q stays unfit until p's row expired; every process loses the database and heals; q's gap tick does not extend the row; q takes it and p's kept write is dropped and logged, which (e) judges legal", async () => {
    setBackendKind('postgres');
    const w = world(2, [3, 3]);
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 0 });
    expect(w.procs[0].held.size).toBe(COUNT);
    await step(w, { kind: 'write', p: 0, shard: 1 });
    expect(w.procs[0].accepted).toHaveLength(1);
    await step(w, { kind: 'cut', p: 0 });
    const expiry = w.procs[0].held.get(1)!.expiry;
    while (w.store.clock.upMs < expiry) {
      await step(w, { kind: 'advance', ms: T.renewMs });
      await step(w, { kind: 'tick', p: 1 });
    }
    await step(w, { kind: 'away' });
    await step(w, { kind: 'advance', ms: 60_000 });
    await step(w, { kind: 'back' });
    await step(w, { kind: 'tick', p: 1 });
    expect(w.store.clock.lastGapMs).toBeGreaterThan(CLOCK_GAP_CAP_MS);
    expect(rowOf(w, 1)!.extended).toBe(false);
    expect(rowOf(w, 1)!.expiresUpMs).toBe(expiry);
    await step(w, { kind: 'take', p: 1 });
    expect(w.procs[1].held.has(1)).toBe(true);
    await step(w, { kind: 'heal', p: 0 });
    await step(w, { kind: 'flush', p: 0 });
    expect(w.procs[0].dropped.map(d => d.guildId)).toEqual([guildOf(1)]);
    expect(w.procs[0].dropLines.some(l => l.includes(guildOf(1)))).toBe(true);
    expect(w.db.doc(guildOf(1), 'd.json')).toBeUndefined();
    expect(w.early).toEqual([]);
  });

  it("p takes with its BEGIN at stored clock 50000 and u' 54000: the store writes 84000, and q cannot take before 84000 and can at it", async () => {
    const w = world(2, [3, 3]);
    await step(w, { kind: 'tick', p: 1 });
    w.store.clock = { upMs: 50_000, tickedAt: w.now - 4_000, lastGapMs: 0 };
    await step(w, { kind: 'take', p: 0 });
    expect(rowOf(w, 1)!.expiresUpMs).toBe(84_000);
    const qTakes = async (upMs: number) => {
      w.store.clock = { upMs, tickedAt: w.now, lastGapMs: 0 };
      const got = await w.store.take({
        me: { processId: 'p1', nodeId: 'n1', nodeName: 'n1' }, capacity: 3, ttlMs: T.ttlMs, boot: false, known: [], localCount: COUNT, reserve: false,
      });
      return got.kind === 'done' ? got.taken.map(t => t.pair.shardId) : [];
    };
    expect(await qTakes(80_000)).toEqual([]);
    expect(await qTakes(83_999)).toEqual([]);
    expect((await qTakes(84_000)).sort()).toEqual([0, 1, 2]);
  });

  it('(3b) a database no process reached for any time expires no claim live before it, and the first tick after gives every holder its TTL', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3_600_000 }), fc.integer({ min: 0, max: T.renewMs }), async (away, lateBy) => {
      const w = world(2, [3, 3]);
      await step(w, { kind: 'tick', p: 0 });
      await step(w, { kind: 'take', p: 0 });
      await step(w, { kind: 'tick', p: 0 });
      await step(w, { kind: 'away' });
      await step(w, { kind: 'advance', ms: away });
      await step(w, { kind: 'back' });
      await step(w, { kind: 'tick', p: 1 });
      await step(w, { kind: 'take', p: 1 });
      expect(w.procs[1].held.size).toBe(0);
      await step(w, { kind: 'advance', ms: T.ttlMs - T.renewMs - lateBy });
      await step(w, { kind: 'tick', p: 1 });
      await step(w, { kind: 'take', p: 1 });
      expect(w.procs[1].held.size).toBe(0);
    }), { numRuns: 200 });
  });

  it("a refused login for every process holds D off: no process stops and the clock does not move; the login's return renews every pair, the gate stays closed and each leave saves, releases and restarts", async () => {
    setBackendKind('postgres');
    const w = world(2, [2, 2]);
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'take', p: 1 });
    const held = w.procs.map(p => [...p.held.keys()].sort());
    const g = guildOf(held[0][0]);
    await step(w, { kind: 'write', p: 0, shard: held[0][0] });
    expect(w.procs[0].accepted).toHaveLength(1);
    const seq = w.procs[0].accepted[0].seq;
    await step(w, { kind: 'failFlush', p: 0, shard: held[0][0] });
    const up = w.store.clock.upMs;
    await step(w, { kind: 'maintOn', cause: 'refused' });
    for (let i = 0; i < 20; i++) {
      await step(w, { kind: 'advance', ms: T.renewMs });
      await step(w, { kind: 'tick', p: i % 2 });
      await step(w, { kind: 'take', p: (i + 1) % 2 });
      await step(w, { kind: 'write', p: i % 2, shard: i % COUNT });
    }
    expect(w.store.clock.upMs).toBe(up);
    expect(w.procs.every(p => !p.stopped)).toBe(true);
    expect(w.procs.map(p => p.accepted.length)).toEqual([1, 0]);
    const renewed = w.store.renewals.length;
    const released = w.store.releases.length;
    await step(w, { kind: 'maintOff' });
    expect(w.store.renewals.slice(renewed).map(r => [r.me.processId, r.pairs.map(q => q.shardId).sort()])).toEqual([['p0', held[0]], ['p1', held[1]]]);
    // p1 had nothing to save: its leave released its rows for its node and it restarted.
    expect(w.procs[1].id).toBe('n1-r1');
    for (const shardId of held[1]) expect(rowOf(w, shardId)).toMatchObject({ released: true, holderNode: 'n1' });
    // p0's save failed: its leave waits on it with the gate closed, so a write is not accepted before its restart.
    expect([w.procs[0].id, w.procs[0].leaving]).toEqual(['p0', true]);
    expect(w.db.doc(g, 'd.json')).toBeUndefined();
    await step(w, { kind: 'write', p: 0, shard: held[0][0] });
    expect(w.procs[0].accepted).toHaveLength(1);
    await step(w, { kind: 'tick', p: 0 });
    expect(w.db.doc(g, 'd.json')).toBe(String(seq));
    expect(w.procs[0].id).toBe('n0-r1');
    for (const shardId of held[0]) expect(rowOf(w, shardId)).toMatchObject({ released: true, holderNode: 'n0' });
    expect(w.store.releases.slice(released).map(r => r.me.processId)).toEqual(['p1', 'p0']);
  });

  it('hook maintenance: renewals go on and the clock runs, no process takes or writes, D still counts a cut; when the hook says running, a process with no web UI leaves through the stop handler and exits, one with a web UI restarts', async () => {
    setBackendKind('postgres');
    const w = world(3, [3, 0, 0], [false, true, true]);
    for (const i of [0, 1, 2]) await step(w, { kind: 'tick', p: i });
    await step(w, { kind: 'take', p: 0 });
    expect(w.procs[0].held.size).toBe(COUNT);
    const up = w.store.clock.upMs;
    await step(w, { kind: 'maintOn', cause: 'hook' });
    await step(w, { kind: 'cut', p: 2 });
    for (let i = 0; i < 8; i++) {
      await step(w, { kind: 'advance', ms: T.renewMs });
      for (const p of [0, 1, 2]) await step(w, { kind: 'tick', p });
      await step(w, { kind: 'take', p: 1 });
      await step(w, { kind: 'reserve', p: 1 });
      await step(w, { kind: 'write', p: 0, shard: i % COUNT });
    }
    expect(w.store.clock.upMs).toBeGreaterThan(up);
    expect(w.store.renewals.at(-1)!.heartbeat.fit).toBe(false);
    expect([w.procs[1].held.size, w.procs[1].reserved.size, w.procs[0].accepted.length]).toEqual([0, 0, 0]);
    for (const h of w.procs[0].held.values()) expect(w.now - h.at).toBe(0);
    expect(w.procs[0].stopped).toBe(false);
    await step(w, { kind: 'heal', p: 2 });
    await step(w, { kind: 'maintOff' });
    expect(w.procs[0]).toMatchObject({ exited: true, ended: true, exitCodes: [0], leaving: false });
    expect([...w.store.rows.values()].every(r => r.released && r.holderNode === 'n0')).toBe(true);
    expect([w.procs[1].id, w.procs[2].id]).toEqual(['n1-r1', 'n2-r1']);
    const { servedAfterMs } = await settle(w);
    expect(servedAfterMs).not.toBeNull();
  });

  it('under maintenance a renewal that cannot reach the database counts toward D: a cut process stops serving at D under hook maintenance and under a refused login', async () => {
    setBackendKind('postgres');
    for (const cause of ['hook', 'refused'] as const) {
      const w = world(1, [3]);
      const p = w.procs[0];
      await step(w, { kind: 'tick', p: 0 });
      await step(w, { kind: 'take', p: 0 });
      await step(w, { kind: 'maintOn', cause });
      await step(w, { kind: 'cut', p: 0 });
      await step(w, { kind: 'advance', ms: T.deadlineMs - 1 });
      expect([cause, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual([cause, false, false]);
      await step(w, { kind: 'advance', ms: 1 });
      expect([cause, p.lastFailure, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual([cause, 'unreachable', true, true]);
      await step(w, { kind: 'heal', p: 0 });
      expect([cause, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual([cause, true, true]);
    }
  });

  it('a refused login holds D off for a process that reaches the server, and every gate sees it serving; refused followed by unreachable lapses at the next renewal attempt, not at the cut', async () => {
    setBackendKind('postgres');
    refusedLapses = 0;
    const w = world(1, [3]);
    const p = w.procs[0];
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'maintOn', cause: 'refused' });
    await step(w, { kind: 'advance', ms: T.deadlineMs + T.renewMs });
    await step(w, { kind: 'tick', p: 0 });
    expect(pastD(w, p)).toBe(true);
    expect([p.lastFailure, p.stopped, servingStopped(w, p), await asProcess(w, p, () => stoppedServing())]).toEqual(['refused', false, false, false]);
    await step(w, { kind: 'cut', p: 0 });
    expect([p.lastFailure, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual(['refused', false, false]);
    await step(w, { kind: 'advance', ms: T.renewMs - 1 });
    expect([p.lastFailure, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual(['refused', false, false]);
    expect(refusedLapses).toBe(0);
    await step(w, { kind: 'tick', p: 0 });
    expect([p.lastFailure, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual(['unreachable', true, true]);
    expect(refusedLapses).toBe(1);
    await step(w, { kind: 'heal', p: 0 });
    expect([p.lastFailure, p.stopped, await asProcess(w, p, () => stoppedServing())]).toEqual(['unreachable', true, true]);
  });

  it('with no tick command, the renewal every R still finds the cut: refused then cut lapses R after the last attempt, and maintOff\'s first tick clears the class', async () => {
    setBackendKind('postgres');
    const w = world(1, [3]);
    const p = w.procs[0];
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'maintOn', cause: 'refused' });
    await step(w, { kind: 'advance', ms: T.deadlineMs });
    await step(w, { kind: 'tick', p: 0 });
    expect([p.lastFailure, p.stopped]).toEqual(['refused', false]);
    await step(w, { kind: 'cut', p: 0 });
    await step(w, { kind: 'advance', ms: T.renewMs - 1 });
    expect(p.stopped).toBe(false);
    await step(w, { kind: 'advance', ms: 1 });
    expect([p.lastFailure, p.stopped]).toEqual(['unreachable', true]);

    const v = world(1, [3]);
    const q = v.procs[0];
    await step(v, { kind: 'tick', p: 0 });
    await step(v, { kind: 'take', p: 0 });
    await step(v, { kind: 'write', p: 0, shard: 0 });
    expect(q.accepted).toHaveLength(1);
    await step(v, { kind: 'failFlush', p: 0, shard: 0 });
    await step(v, { kind: 'maintOn', cause: 'refused' });
    await step(v, { kind: 'tick', p: 0 });
    expect(q.lastFailure).toBe('refused');
    await step(v, { kind: 'maintOff' });
    expect([q.id, q.leaving, q.lastFailure, q.stopped]).toEqual(['p0', true, null, false]);
  });

  it('a 28000 between a boot take and the Discord login closes the real gate before the login: the login answers with the maintenance text, a write is refused, D does not lapse while renewals are refused, and the restart follows', async () => {
    setBackendKind('postgres');
    bootRefusals.logins = 0;
    bootRefusals.exits = 0;
    const w = world(2, [2, 1]);
    const [, q] = w.procs;
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'crash', p: 1 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 1 });
    expect([q.id, q.loggingIn, [...q.held.keys()]]).toEqual(['n1-r1', true, [2]]);
    await step(w, { kind: 'write', p: 1, shard: 2 });
    expect(q.accepted).toEqual([]);
    await step(w, { kind: 'refuseDuringBoot', p: 1 });
    expect(w.maint).toBe('refused');
    expect(q.real!.gate.isMaintenanceGateClosed()).toBe(true);
    expect(q.real!.sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      await step(w, { kind: 'advance', ms: T.renewMs });
      await step(w, { kind: 'tick', p: 1 });
    }
    expect(pastD(w, q)).toBe(true);
    expect([q.lastFailure, q.stopped]).toEqual(['refused', false]);
    expect(w.procs[0].stopped).toBe(false);
    await step(w, { kind: 'login', p: 1 });
    expect(bootRefusals.logins).toBe(1);
    expect([q.id, q.real, q.loggingIn, q.booting, q.accepted]).toEqual(['n1-r2', null, false, true, []]);
    expect(rowOf(w, 2)).toMatchObject({ holderProcess: 'n1-r1', released: false });
    const { servedAfterMs } = await settle(w);
    expect(servedAfterMs).not.toBeNull();
  });

  it('a 28000 between a boot take and the login of a process with no web UI ends in its stop handler and one exit, and it is not restarted', async () => {
    setBackendKind('postgres');
    bootRefusals.exits = 0;
    const w = world(3, [2, 1, 1], [true, false, true]);
    const [, q] = w.procs;
    for (const i of [0, 1, 2]) await step(w, { kind: 'tick', p: i });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'crash', p: 1 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 1 });
    expect(q.loggingIn).toBe(true);
    await step(w, { kind: 'refuseDuringBoot', p: 1 });
    expect(bootRefusals.exits).toBe(1);
    expect(q).toMatchObject({ exited: true, ended: true, exitCodes: [0], real: null, held: new Map(), leaveRestarts: 0 });
    await step(w, { kind: 'login', p: 1 });
    expect(q.exitCodes).toEqual([0]);
    const { servedAfterMs } = await settle(w);
    expect(servedAfterMs).not.toBeNull();
    expect([...w.procs[2].held.keys()]).toEqual([2]);
  });

  it('a process with no web UI whose leave after maintenance could not reach the database, and that a 28000 then reaches before its login, exits once and is no longer leaving', async () => {
    setBackendKind('postgres');
    const w = world(2, [0, 0], [false, false]);
    const [, q] = w.procs;
    await step(w, { kind: 'crash', p: 1 });
    await step(w, { kind: 'take', p: 1 });
    expect(q.loggingIn).toBe(true);
    await step(w, { kind: 'away' });
    await step(w, { kind: 'maintOn', cause: 'hook' });
    await step(w, { kind: 'maintOff' });
    expect([q.leaving, q.mustExit, q.exited]).toEqual([true, true, false]);
    await step(w, { kind: 'back' });
    await step(w, { kind: 'refuseDuringBoot', p: 1 });
    expect(q).toMatchObject({ exited: true, ended: true, exitCodes: [0], leaving: false, real: null });
    await settle(w);
    expect(q.exitCodes).toEqual([0]);
  });

  it('a reservation is served by no one, renewed with the held pairs, kept at the stop and taken at once by the restarted process of its node', async () => {
    setBackendKind('postgres');
    const w = world(2, [2, 1]);
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 0 });
    await step(w, { kind: 'take', p: 1 });
    expect([...w.procs[0].held.keys()].sort()).toEqual([0, 1]);
    expect([...w.procs[1].held.keys()]).toEqual([2]);
    await step(w, { kind: 'crash', p: 1 });
    while (w.store.clock.upMs < rowOf(w, 2)!.expiresUpMs || w.now - w.store.nodes.get('n1')!.seenAt < 30_000) {
      await step(w, { kind: 'advance', ms: T.renewMs });
      await step(w, { kind: 'tick', p: 0 });
    }
    await step(w, { kind: 'reserve', p: 0 });
    expect(w.procs[0].reserved.has(2)).toBe(true);
    expect(rowOf(w, 2)).toMatchObject({ holderProcess: 'p0', released: true, reserved: true });
    expect(w.procs.some(p => serving(w, p, 2))).toBe(false);
    await step(w, { kind: 'advance', ms: T.renewMs });
    await step(w, { kind: 'tick', p: 0 });
    expect(w.procs[0].reserved.has(2)).toBe(true);
    expect(w.store.renewals.at(-1)!.pairs.map(q => q.shardId).sort()).toEqual([0, 1, 2]);
    await step(w, { kind: 'stop', p: 0 });
    expect(w.procs[0].id).toBe('n0-r1');
    expect(w.store.releases.at(-1)!.reserved.map(q => q.shardId)).toEqual([2]);
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'take', p: 0 });
    expect([...w.procs[0].held.keys()].sort()).toEqual([0, 1, 2]);
    expect(w.early).toEqual([]);
  });

  it('a process with no web UI exits at its stop and is not restarted; a web UI process takes its shards at their expiry within the (f) bound', async () => {
    setBackendKind('postgres');
    const w = world(2, [3, 0], [false, true]);
    await step(w, { kind: 'tick', p: 0 });
    await step(w, { kind: 'tick', p: 1 });
    await step(w, { kind: 'take', p: 0 });
    expect(w.procs[0].held.size).toBe(COUNT);
    await step(w, { kind: 'stop', p: 0 });
    expect(w.procs[0].exited).toBe(true);
    expect(w.procs[0].exitCodes).toEqual([0]);
    expect([...w.store.rows.values()].every(r => r.released && r.holderNode === 'n0')).toBe(true);
    const { servedAfterMs } = await settle(w);
    expect(servedAfterMs).not.toBeNull();
    expect([...w.procs[1].held.keys()].sort()).toEqual([0, 1, 2]);
  });
});
