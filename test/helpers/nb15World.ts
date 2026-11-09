import { AsyncLocalStorage } from 'async_hooks';
import { expect, vi } from 'vitest';

import { answerPanelMessage, _resetPanelHandler } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { answerInvokeMessage } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { maintenanceIpcRefusal } from '../../src/bot/internalSetup/utils/maintenance';
import { DEFAULT_MAINTENANCE_MESSAGE, setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { NOT_HELD } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { servedElsewhere } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import type { LeaseSnapshot } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { readinessRig, stopDrivers } from './readinessRig';
import { tokenFor } from './fakeStore';
import { stubs } from './nb15Stubs';
import { GuildRequestSweep, RequestsStoppedError, type PanelHooks, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  POLL_SET_SQL,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
  SETTLE_INSERT_SQL,
  changeDeadlineMs,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { isReadOp, type PanelRequestOp } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { _resetPanelLive, _setNotifyDb, noteLiveChange, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { ranTruthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { _resetGuildRequests, _setGuildRequestDeps, endGuildRequests, planGuildRequest, runGuildRequest, type Audience } from '../../src/webui/utils/guildRequests';
import { PanelLiveWatch, type ListenClient } from '../../src/webui/utils/panelLiveWatch';
import { PANEL_CHANNEL } from '../../src/bot/internalSetup/fleet/panelLive';
import { ModelDb, type Bites, type Fate, type Row } from './nb7Model';
import { BOT_DOWN, GUILD, heldRow } from './nb7Rig';
import { setBackendKind } from './backendKind';
import { flush } from './nb7World';

// NB15 tests 6 and 7: the real sender (planGuildRequest, runGuildRequest, endGuildRequests), the real holder's sweep
// with its start checks, the real start of an action (answerPanelMessage and answerInvokeMessage with 'request': the
// maintenance gate, the latch's stopped-serving refusal, the lease check over a real readiness driver, the rate
// limit, admitGuildAction, runPanelAction and handleInvoke with the real dispatcher), and the real live layer on both
// sides (panelLive, PanelLiveWatch), over NB7's model store grown by NB15's statements: the claim with its three picks
// that empties the body, the read answers in groups, the body-emptying cleanup and the delete. Only Discord and the
// module are faked: the panel manager's handlers and the command callbacks count each start with the process that ran
// it and whether that process served the guild then; the test finishes it. The test files mock panelManager,
// getLocalCommands and premiumManager to nb15Stubs.

export type Finish = 'ok' | 'pending' | 'refused' | 'oversize' | 'unserializable' | 'throws';

export interface Bites15 extends Bites {
  /** The lease check sees the shard still leased after the world lost it (decision 6's not-held removed). */
  noLeaseCheck?: boolean;
  /** Decision 3's rule removed: the start checks see no panel scope. */
  noScopeRule?: boolean;
  /** The read pick counts against the action places. */
  sharedPlaces?: boolean;
  /** The claim leaves the body in the row. */
  claimKeepsBody?: boolean;
  /** The live state is a map of the 64 latest changes of the process, not an interest per pair. */
  latestMap?: boolean;
  /** Decision 22's join rule removed: the sender's poll set takes a request's id when its insert is sent. */
  joinAtSend?: boolean;
}

/** The sender's poll sets as it stores them, seen only while a world runs the joinAtSend bite. */
const pollSetsSeen = new Set<{ join(id: string): void }>();
let seeingPollSets: { mockRestore(): void } | null = null;

function seePollSets(): void {
  if (seeingPollSets) return;
  const set = WeakMap.prototype.set;
  seeingPollSets = vi.spyOn(WeakMap.prototype, 'set').mockImplementation(function (this: WeakMap<WeakKey, unknown>, key: WeakKey, value: unknown) {
    if ((value as { constructor?: { name?: string } } | null)?.constructor?.name === 'PollSet') pollSetsSeen.add(value as { join(id: string): void });
    return set.call(this, key, value);
  });
}

function unseePollSets(): void {
  seeingPollSets?.mockRestore();
  seeingPollSets = null;
  pollSetsSeen.clear();
}

export interface Row15 extends Row {
  body?: string;
  guildId?: string;
  createdAt?: number;
}

/** NB7's model store with NB15's statements, on the database's own clock. */
export class Model15 extends ModelDb {
  /** Ids whose insert the sender saw answered, or whose insert-form settle answered. */
  readonly joinable = new Set<string>();
  /** Polls that carried an id whose insert had no answer and no settle answered. */
  readonly earlyPolls: string[] = [];
  /** Reads a claim left pending and claimable with fewer than 64 reads pending. */
  readonly readsSkipped: string[] = [];
  /** The database time of each cleanup that ran. */
  readonly cleanups: number[] = [];

  constructor(fates: Fate[], private readonly b: Bites15 = {}) {
    super(fates, b);
  }

  row(id: string): Row15 | undefined {
    return this.rows.get(id) as Row15 | undefined;
  }

  override run(sql: string, values: any[], pid?: string, boundMs?: number): Promise<{ rows: any[]; rowCount: number }> {
    if (sql === POLL_SET_SQL) for (const id of values[0] as string[]) if (!this.joinable.has(id)) this.earlyPolls.push(id);
    if (this.b.joinAtSend && sql === REQUEST_INSERT_SQL) for (const polls of pollSetsSeen) polls.join(values[0]);
    const out = super.run(sql, values, pid, boundMs);
    if (sql === REQUEST_INSERT_SQL || sql === SETTLE_INSERT_SQL) void out.then(() => { this.joinable.add(values[0]); }, () => undefined);
    return out;
  }

  override exec(sql: string, v: any[]): { rows: any[]; rowCount: number } {
    if (sql === REQUEST_INSERT_SQL) {
      const res = super.exec(sql, v);
      Object.assign(this.rows.get(v[0])!, { body: v[6], guildId: v[1], createdAt: this.now });
      return res;
    }
    if (sql === REQUEST_CLAIM_SQL) return this.claimRows(v);
    if (sql === READ_ANSWERS_SQL) {
      const [ids, replies, batch] = v as [string[], string[], string];
      let n = 0;
      ids.forEach((id, i) => {
        const r = this.rows.get(id);
        if (!r || r.batch !== batch || r.state !== 'applying') return;
        r.state = 'done';
        r.reply = replies[i];
        this.doneAt.set(id, this.now);
        n += 1;
      });
      return { rows: [], rowCount: n };
    }
    if (sql === READ_ANSWERS_READ_BACK_SQL) {
      const out = (v[0] as string[]).flatMap(id => { const r = this.rows.get(id); return r ? [{ id, state: r.state, reply: r.reply }] : []; });
      return { rows: out, rowCount: out.length };
    }
    if (sql === CLEANUP_BODIES_SQL) {
      let n = 0;
      for (const r of this.rows.values() as Iterable<Row15>) {
        if ((r.state === 'pending' || r.state === 'expired') && r.claimBy < this.now - 5000 && r.body) { r.body = ''; n += 1; }
      }
      return { rows: [], rowCount: n };
    }
    if (sql === CLEANUP_SQL) {
      this.cleanups.push(this.now);
      let n = 0;
      for (const [id, r] of this.rows as Map<string, Row15>) {
        const done = this.doneAt.get(id);
        if ((r.state === 'done' && done !== undefined && done < this.now - 120_000) || (r.createdAt ?? this.now) < this.now - 3_600_000) {
          this.rows.delete(id);
          this.doneAt.delete(id);
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    return super.exec(sql, v);
  }

  private claimRows(v: any[]): { rows: any[]; rowCount: number } {
    const [pid, batch, counts, shards, claims, dataOps, dataLimit, actOps, actLimit, readOps, readLimit] = v;
    const c = this.claim;
    const paired = counts.some((n: number, i: number) => n === c.shardCount && shards[i] === c.shardId && claims[i] === c.claim);
    if (!paired || c.holderProcess !== pid || c.released) return { rows: [], rowCount: 0 };
    const limits: Record<string, number> = { dat: dataLimit, act: actLimit, rd: this.b.sharedPlaces ? actLimit : readLimit };
    const taken: Record<string, number> = { dat: 0, act: 0, rd: 0 };
    const counter = (pick: string) => (this.b.sharedPlaces && pick === 'rd' ? 'act' : pick);
    const out: any[] = [];
    const skipped: string[] = [];
    let pendingReads = 0;
    for (const [id, r] of this.rows as Map<string, Row15>) {
      const pick = dataOps.includes(r.op) ? 'dat' : actOps.includes(r.op) ? 'act' : readOps.includes(r.op) ? 'rd' : null;
      if (!pick) continue;
      if (r.state !== 'pending' || r.forProcess !== pid || r.claimBy <= this.now || r.shardCount !== c.shardCount || r.shardId !== c.shardId) continue;
      if (pick === 'rd') pendingReads += 1;
      if (taken[counter(pick)] >= limits[pick]) {
        if (pick === 'rd') skipped.push(id);
        continue;
      }
      taken[counter(pick)] += 1;
      r.state = 'applying';
      r.batch = batch;
      this.claimed.add(id);
      out.push({ id, guild_id: r.guildId ?? GUILD, shard_count: r.shardCount, shard_id: r.shardId, op: r.op, body: r.body ?? '', requested_by: 'ALPHA', left_ms: Math.max(r.answerBy - this.now, 0) });
      if (!this.b.claimKeepsBody) r.body = '';
    }
    if (pendingReads <= 64) this.readsSkipped.push(...skipped);
    return { rows: out, rowCount: out.length };
  }
}

export interface Sent15 {
  op: PanelRequestOp;
  audience: Audience;
  panel?: string;
  tag: string;
  id?: string;
  answer?: { status: number | null; reply: Record<string, any> };
  sentAt: number;
  answeredAt?: number;
  /** The fake clock at the send and at the answer: the model's clock moves a whole step before the timers run. */
  sentClock?: number;
  answeredClock?: number;
  cut?: boolean;
  crashed?: boolean;
}

interface Running { tag: string; gen: number; op: PanelRequestOp; resolve: (answer: any) => void; reject: (error: Error) => void }

const PANELS: Record<string, { panelScope?: string; devOnly?: boolean }> = { p: {}, q: {}, sys: { panelScope: 'system' }, dev: { devOnly: true } };
const COMMANDS: Record<string, { devOnly?: boolean }> = { ping: {}, webui: { devOnly: true } };
const MEMBER = '123456789012345678';
const LEASE: LeaseSnapshot = { nodeId: 'n-b', processId: 'p-b', claims: { 1: 1 }, shardCount: 2, shardIds: [1] };
const NOT_LEASED: LeaseSnapshot = { ...LEASE, claims: {}, shardIds: [] };
export const ENTRY = 'postgres://u@localhost:5432/smdb';

/** A listening client the test drives: it answers while the database is up and stays up until dropped. */
class FakeListen implements ListenClient {
  handlers: Record<string, Array<(arg?: any) => void>> = { notification: [], error: [], end: [] };
  ended = false;
  connection = { stream: { remoteAddress: '127.0.0.1', destroy: () => undefined } };
  constructor(private readonly world: World15) {}
  connect() { return this.world.model.away ? Promise.reject(new Error('connect ECONNREFUSED')) : Promise.resolve(); }
  query(text: string) {
    if (this.ended || this.world.model.away) return Promise.reject(new Error('Connection terminated unexpectedly'));
    if (text.startsWith('LISTEN')) this.world.listening.add(this);
    return Promise.resolve({ rows: [] });
  }
  on(event: string, fn: (arg?: any) => void) { this.handlers[event].push(fn); return this; }
  end() { this.ended = true; this.world.listening.delete(this); return Promise.resolve(); }
  emit(event: string, arg?: any) { for (const fn of this.handlers[event]) fn(arg); }
}

export class World15 {
  readonly model: Model15;
  sweep!: GuildRequestSweep;
  pid = 'p-b';
  gen = 0;
  stopping = false;
  guildWebUi: boolean | null = true;
  private lost = false;
  private latch = false;
  private gate = false;
  private readonly readiness = readinessRig(LEASE);
  private readonly tagOf = new AsyncLocalStorage<string>();
  exited = false;
  readonly sends: Sent15[] = [];
  /** Module code starts per tag, with the process and whether it served the guild then. */
  readonly runs = new Map<string, Array<{ pid: string; serving: boolean; scope: string }>>();
  readonly outcomes = new Map<string, Finish>();
  readonly running: Running[] = [];
  readonly dropped = new Set<string>();
  readonly disturbed = new Set<string>();
  /** The live layer: the holder's latest state per panel, the web UI's shown state and status per panel. */
  readonly latest = new Map<string, number>();
  readonly shown = new Map<string, unknown>();
  readonly status = new Map<string, boolean>();
  readonly listening = new Set<FakeListen>();
  watcher: PanelLiveWatch;
  watching: string | null = null;
  lastWatch = -Infinity;
  private changes = 0;
  private tags = 0;
  private readonly latestMap = new Map<string, unknown>();
  private lastDown = 0;
  /** Database times of passes that served with no cleanup in the minute before. */
  readonly cleanupMissed: number[] = [];

  constructor(fates: Fate[] = [], readonly bites: Bites15 = {}) {
    this.model = new Model15(fates, bites);
    if (bites.joinAtSend) seePollSets();
    _resetGuildRequests();
    _resetPanelLive();
    setBackendKind('postgres');
    _setGuildRequestDeps({
      holderOf: async () => {
        if (this.model.loginRefused) throw Object.assign(new Error('role is not permitted to log in'), { code: '28000' });
        if (this.model.away) throw new Error('connect ECONNREFUSED');
        const c = this.model.claim;
        const other = c.holderProcess === 'p-c';
        return { rows: [heldRow({ holder_process: c.holderProcess, node_process_id: c.holderProcess, holder_node: other ? 'n-c' : 'n-b', holder_name: other ? 'CHARLIE' : 'BRAVO', claim: String(c.claim), released: c.released })] };
      },
      currentUrl: () => 'postgres://model',
      requestDb: () => this.model.requestDb(),
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    _setNotifyDb({
      notify: async payloads => {
        if (this.model.away || this.latched) throw new Error('Connection terminated unexpectedly');
        for (const l of [...this.listening]) for (const payload of payloads) l.emit('notification', { channel: PANEL_CHANNEL, payload });
      },
    }, () => true);
    this.watcher = new PanelLiveWatch({
      fetch: async (guildId, panelId, userId, have) => {
        const plan = await planGuildRequest(down, guildId, 'panel:live', 'owner');
        return runGuildRequest(plan, { panelId, ...have, actor: { via: 'owner', userId } }, async () => ({}));
      },
      emitUpdate: data => { this.shown.set(data.panelId, data.response); },
      emitStatus: data => { this.status.set(data.panelId, data.live); },
      entry: () => ({ entry: ENTRY }),
      makeClient: () => new FakeListen(this),
    });
    _resetPanelHandler();
    setMaintenanceGate(null);
    setStoppedServingHook(() => this.latch);
    stubs.manager = this.panelManager();
    stubs.commands = Object.entries(COMMANDS).map(([name, c]) => ({ name, ...c, callback: () => this.moduleStart('command:invoke', undefined) }));
    void this.readiness.ws.hydrate(GUILD, tokenFor());
    this.newSweep();
  }

  /** The holder's lease lost shard 1 (true) or holds it (false), as the real readiness driver sees it. */
  get leaseLost(): boolean { return this.lost; }
  set leaseLost(lost: boolean) {
    if (lost === this.lost) return;
    this.lost = lost;
    if (this.bites.noLeaseCheck) return;
    this.readiness.driver.onLeaseChanged(lost ? NOT_LEASED : LEASE);
    if (!lost) void this.readiness.ws.hydrate(GUILD, tokenFor());
  }

  /** NB5's latch: the process stopped writing to its database, so stoppedServing() turns true. */
  get latched(): boolean { return this.latch; }
  set latched(on: boolean) { this.latch = on; }

  /** NB2's maintenance gate, closed by the hook. */
  get maintenance(): boolean { return this.gate; }
  set maintenance(on: boolean) {
    this.gate = on;
    setMaintenanceGate(on ? { cause: 'hook', message: DEFAULT_MAINTENANCE_MESSAGE } : null);
  }

  /** The module stand-in: counts the start under the request's tag and waits for the test to finish it. */
  private moduleStart(op: PanelRequestOp, panel: string | undefined): Promise<any> {
    const tag = this.tagOf.getStore() ?? 'untagged';
    const gen = this.gen;
    const list = this.runs.get(tag) ?? [];
    list.push({ pid: this.pid, serving: !this.lost, scope: panel ? (PANELS[panel]?.panelScope ?? (PANELS[panel]?.devOnly ? 'dev' : 'guild')) : 'guild' });
    this.runs.set(tag, list);
    return new Promise((resolve, reject) => { this.running.push({ tag, gen, op, resolve, reject }); });
  }

  /** Discord and the panel manager, faked: a ready client with the guild cached; each handler is the module stand-in. */
  private panelManager() {
    const guild = {
      id: GUILD, available: true, shardId: 1,
      members: { me: { permissions: { has: () => true } }, cache: new Map() },
      channels: { cache: new Map() }, roles: { cache: new Map() },
    };
    const client = {
      isReady: () => true,
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: { cache: new Map(), fetch: async () => null },
      users: { cache: new Map() },
      user: { id: '11' },
      application: { id: '11' },
      ws: { shards: new Map() },
    };
    const action = (op: PanelRequestOp) => (panelId: string) => this.moduleStart(op, panelId);
    return {
      getClient: () => client,
      getPanel: (id: string) => (this.bites.noScopeRule ? undefined : PANELS[id] ? { id, ...PANELS[id] } : undefined),
      getWebUIPanelList: () => Object.keys(PANELS).map(id => ({ id, scope: PANELS[id].panelScope ?? 'guild', devOnly: PANELS[id].devOnly })),
      executePanelForWebUI: action('panel:execute'),
      handleWebUIButton: action('panel:button'),
      handleWebUIDropdown: action('panel:dropdown'),
      handleWebUIModal: action('panel:modal'),
    };
  }

  private db(gen: number): SweepDb {
    const inner = this.model.sweepDb(this.pid);
    return {
      query: (sql, values, boundMs, at, carries) => {
        if (gen === this.gen && this.latched) return Promise.reject(new RequestsStoppedError('the main changed', true));
        return inner.query(sql, values, boundMs, at, carries);
      },
    };
  }

  /**
   * The sweep's hooks: actions and 'panel:live' go to the real answerPanelMessage and answerInvokeMessage, as
   * realPanelHooks sends them; the reads that only list Discord's cache answer an empty list after the real maintenance
   * and lease checks; the panel and command lookups and the member panel flag are the world's.
   */
  private hooks(): PanelHooks {
    return {
      answerPanel: async (op, body) => {
        if (op === 'panel:live' && this.bites.latestMap) {
          const kept = this.latestMap.get(String(body.panelId));
          return { success: true, data: kept ?? null, since: 1, notifying: true };
        }
        if (isReadOp(op) && op !== 'panel:live') {
          const refusal = maintenanceIpcRefusal(op);
          if (refusal) return refusal;
          if (servedElsewhere(String(body.guildId))) return NOT_HELD;
          return { success: true, [op === 'panel:list' ? 'panels' : op === 'guild:roles' ? 'roles' : 'channels']: [] };
        }
        return this.tagOf.run(String(body.tag), () => answerPanelMessage(op, body, 'request'));
      },
      answerInvoke: async body => this.tagOf.run(String(body.tag), () => answerInvokeMessage(body as any, 'request')),
      maintenanceRefusal: op => maintenanceIpcRefusal(op),
      getPanel: id => (this.bites.noScopeRule ? undefined : PANELS[id]),
      getCommand: name => COMMANDS[name],
      guildWebUi: () => this.guildWebUi,
      membership: () => ({ success: true, guilds: [] }),
      registerInterest: (guildId, panelId) => (this.bites.latestMap ? 1 : registerInterest(guildId, panelId)),
    };
  }

  private newSweep(): void {
    const gen = this.gen;
    const pid = this.pid;
    const claim = this.model.claim.claim;
    this.sweep = new GuildRequestSweep({
      db: this.db(gen),
      processId: () => pid,
      pairs: () => [{ shardCount: 2, shardId: 1, claim }],
      stoppedServing: () => false,
      isStopping: () => gen === this.gen && this.stopping,
      apply: async () => ({ ok: false, code: 'invalid', error: 'no data ops in this model' }),
      panel: this.hooks(),
    });
  }

  /** The body of an op as the routes build it, with a tag the module stand-in reads. */
  private payloadOf(op: PanelRequestOp, audience: Audience, panel: string, tag: string): Record<string, unknown> {
    const actor = audience === 'owner' ? { via: 'owner', userId: 'web-ui-owner' } : { via: 'member', userId: MEMBER };
    switch (op) {
      case 'command:invoke': return { command: panel === 'dev' ? 'webui' : 'ping', options: {}, actor, tag };
      case 'guild:membership': return { ids: [GUILD], actor, tag };
      case 'panel:live': return { panelId: panel, actor, tag };
      case 'guild:channels': case 'guild:roles': case 'panel:list': return { actor, tag };
      default: return { panelId: panel, buttonId: 'b', userId: actor.userId, actor, tag };
    }
  }

  async send(op: PanelRequestOp = 'panel:button', audience: Audience = 'owner', panel = 'p', between?: () => void): Promise<Sent15> {
    const before = this.model.sentInserts.length;
    const tag = `t${++this.tags}`;
    const sent: Sent15 = { op, audience, panel, tag, sentAt: this.model.now, sentClock: performance.now() };
    this.sends.push(sent);
    const plan = await planGuildRequest(down, GUILD, op, audience);
    between?.();
    void runGuildRequest(plan, this.payloadOf(op, audience, panel, tag), async () => ({})).then(a => {
      if (sent.crashed) return;
      sent.answer = a;
      sent.answeredAt = this.model.now;
      sent.answeredClock = performance.now();
    });
    await flush();
    sent.id = this.model.sentInserts[before];
    return sent;
  }

  async pass(): Promise<void> {
    const up = !this.model.away && !this.model.loginRefused && !this.latched && !this.stopping && !this.leaseLost;
    if (!up) this.lastDown = this.model.now;
    const before = this.model.sentSql.length;
    await this.sweep.pass();
    void this.sweep.cleanupTick();
    await flush();
    const ran = this.model.sentSql.slice(before).includes(REQUEST_CLAIM_SQL);
    const last = this.model.cleanups[this.model.cleanups.length - 1] ?? -Infinity;
    if (up && ran && this.model.now - this.lastDown > 62_000 && this.model.now - last > 61_000) this.cleanupMissed.push(this.model.now);
  }

  async finish(kind: Finish = 'ok'): Promise<void> {
    const at = this.running.findIndex(r => r.gen === this.gen);
    if (at < 0) return;
    const [run] = this.running.splice(at, 1);
    this.outcomes.set(run.tag, run.op === 'command:invoke' && kind !== 'throws' ? 'ok' : kind);
    if (kind === 'throws') run.reject(new Error('the module threw'));
    else run.resolve(answerOf(kind));
    await flush();
  }

  crash(): void {
    for (const r of this.running) if (r.gen === this.gen) this.dropped.add(r.tag);
    this.model.deadPids.add(this.pid);
    this.gen += 1;
    this.pid = `p-b${this.gen}`;
    this.stopping = false;
    this.leaseLost = false;
    this.latched = false;
    this.model.claim = { ...this.model.claim, holderProcess: this.pid, claim: this.model.claim.claim + 1 };
    this.newSweep();
  }

  /** The holder process dies and nothing restarts it: its claim row still names it. */
  kill(): void {
    for (const r of this.running) if (r.gen === this.gen) this.dropped.add(r.tag);
    this.model.deadPids.add(this.pid);
    this.gen += 1;
    this.sweep = new GuildRequestSweep({
      db: this.model.sweepDb('p-dead'), processId: () => null, pairs: () => [], stoppedServing: () => true, isStopping: () => true,
      apply: async () => ({ ok: false, code: 'io-error', error: 'dead' }), panel: this.hooks(),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    let ended = false;
    void this.sweep.stopStep().then(() => { ended = true; });
    await flush();
    for (let i = 0; i < 25 && !ended; i++) await this.advance(100);
  }

  takeover(): void {
    this.model.claim = { ...this.model.claim, holderProcess: 'p-c', claim: this.model.claim.claim + 1 };
  }

  /** NB5's switch: the holder latches and the main moves; the new main has the rows as last shipped. */
  switchMain(): void {
    this.latched = true;
    this.model.failover();
    this.down();
  }

  async exit(): Promise<void> {
    for (const s of this.sends) if (!s.answer) s.cut = true;
    this.exited = true;
    await endGuildRequests();
    await flush();
  }

  crashSender(): void {
    for (const s of this.sends) {
      if (s.answer) continue;
      s.crashed = true;
      s.cut = true;
      if (s.id) this.model.dead.add(s.id);
    }
  }

  async advance(ms: number): Promise<void> {
    const step = Math.min(ms, 1000);
    for (let done = 0; done < ms; done += step) {
      const now = Math.min(step, ms - done);
      this.model.now += now;
      await vi.advanceTimersByTimeAsync(now);
      if (this.watching && this.model.now - this.lastWatch >= 60_000) this.watch();
    }
  }

  away(): void { this.model.away = true; this.down(); }
  back(): void { this.model.away = false; }
  refuseLogin(): void { this.model.loginRefused = true; this.down(); }
  failover(): void { this.model.failover(); this.down(); }

  private down(): void {
    this.lastDown = this.model.now;
    this.disturbFollowed();
  }

  private disturbFollowed(): void {
    for (const s of this.sends) if (s.id && !s.answer) this.disturbed.add(s.id);
  }

  /** The page shows the remote panel and sends its watch call (every 60 s from then on, while shown). */
  watch(panel = 'p'): void {
    if (this.watching !== panel) {
      this.watching = panel;
      if (!this.shown.has(panel)) this.shown.set(panel, this.latest.has(panel) ? { v: this.latest.get(panel) } : null);
    }
    this.lastWatch = this.model.now;
    this.watcher.watch(GUILD, panel, 'web-ui-owner', 'BRAVO');
  }

  closePanel(): void { this.watching = null; }

  /** A panel of the holder changes by itself (a timer update through sendLiveUpdate). */
  changePanel(panel: string): void {
    const v = ++this.changes;
    this.latest.set(panel, v);
    if (this.bites.latestMap) {
      this.latestMap.delete(panel);
      this.latestMap.set(panel, { v });
      while (this.latestMap.size > 64) this.latestMap.delete(this.latestMap.keys().next().value as string);
      for (const l of [...this.listening]) l.emit('notification', { channel: PANEL_CHANNEL, payload: JSON.stringify({ g: GUILD, p: panel }) });
      return;
    }
    noteLiveChange(GUILD, panel, { v });
  }

  dropListener(): void {
    for (const l of [...this.listening]) { this.listening.delete(l); l.emit('end'); }
  }

  /** The database answers, the holder serves, and notifications, fetches and passes run out. */
  async settle(): Promise<void> {
    this.model.away = false;
    this.model.loginRefused = false;
    for (let i = 0; i < 24; i++) {
      this.model.runLate();
      await this.pass();
      await this.advance(250);
    }
    this.checkLive();
  }

  async drain(): Promise<void> {
    this.model.away = false;
    this.model.loginRefused = false;
    for (let i = 0; i < 100; i++) {
      this.model.runLate();
      while (this.running.some(r => r.gen === this.gen)) await this.finish('ok');
      await this.pass();
      await this.advance(1000);
      this.check();
    }
  }

  runsOf(sent: Sent15): number {
    return this.runs.get(sent.tag)?.length ?? 0;
  }

  /** Test 6's properties, after every step. */
  check(): void {
    for (const [tag, list] of this.runs) {
      expect(list.length, `request ${tag} ran ${list.length} times`).toBeLessThanOrEqual(1);
      for (const r of list) {
        expect(r.serving, `request ${tag} ran in ${r.pid}, which no longer served its guild`).toBe(true);
        expect(r.scope, `request ${tag} ran a ${r.scope} panel from a row`).toBe('guild');
      }
    }
    for (const sent of this.sends) {
      const runs = this.runsOf(sent);
      if (sent.answer) {
        const reply = sent.answer.reply;
        const text = String(reply.error ?? '');
        if (/nothing was run/i.test(text)) expect(runs, `"${text}" answered for request ${sent.tag}, which ran`).toBe(0);
        if (runs === 1 && reply.success !== true) expect(text, `request ${sent.tag} ran, but its answer reads as a refusal`).not.toMatch(/refused the request/i);
        if (reply.success === true && !isReadOp(sent.op)) {
          expect(runs, `success answered for request ${sent.tag}, which never ran`).toBe(1);
          expect(['ok', 'oversize', 'unserializable'], `success answered for request ${sent.tag} whose verdict was ${this.outcomes.get(sent.tag)}`).toContain(this.outcomes.get(sent.tag));
        }
        if (reply.code === 'no-answer' && sent.id) {
          const unseen = this.model.senderLost.has(sent.id) || this.disturbed.has(sent.id) || !!sent.cut || this.dropped.has(sent.tag) || this.doneTooLate(sent);
          expect(unseen, `can't confirm (${reply.noAnswer}) answered for request ${sent.tag} with nothing the sender could not observe`).toBe(true);
        }
        const took = sent.sentClock !== undefined && sent.answeredClock !== undefined ? sent.answeredClock - sent.sentClock
          : sent.answeredAt !== undefined ? sent.answeredAt - sent.sentAt : undefined;
        if (!sent.cut && took !== undefined) expect(took, `request ${sent.tag} answered after its T`).toBeLessThanOrEqual(changeDeadlineMs(sent.op));
      }
    }
    expect(this.model.earlyPolls, 'a poll carried the id of a request whose insert had no answer').toEqual([]);
    expect(this.model.readsSkipped, 'a claim left a read untaken with read places free').toEqual([]);
    for (const [id, r] of this.model.rows as Map<string, Row15>) {
      if (r.state === 'applying' || r.state === 'done') expect(r.body ?? '', `the ${r.state} row ${id} keeps its body`).toBe('');
    }
    expect(this.cleanupMissed, 'a pass that served ran no cleanup within a minute').toEqual([]);
  }

  /** Invariant 11, once the live layer ran out: a pair shown live shows the holder's latest state. */
  checkLive(): void {
    const panel = this.watching;
    if (!panel || this.model.now - this.lastWatch > 60_000) return;
    if (this.status.get(panel) !== true || !this.latest.has(panel)) return;
    expect(this.shown.get(panel), `panel ${panel} is shown live with a state older than the holder's`).toEqual({ v: this.latest.get(panel) });
  }

  private doneTooLate(sent: Sent15): boolean {
    const at = this.model.doneAt.get(sent.id!);
    if (at === undefined) return this.model.claimed.has(sent.id!);
    const followEnd = sent.sentAt + changeDeadlineMs(sent.op) - 5000;
    return at > Math.min(sent.answeredAt ?? Infinity, followEnd) - 500;
  }
}

const down = { writerRoute: () => BOT_DOWN, isRunning: () => false } as any;

/** What the panel module stand-in returns; runPanelAction passes it on when its ledger holds no write. 'pending' and 'refused' are the shapes runPanelAction gives a pending or deposed verdict. */
export function answerOf(kind: Finish): any {
  switch (kind) {
    case 'ok': return { success: true, data: { shown: 'next' } };
    case 'pending': return { success: false, ran: true, truth: 'pending', partial: false, pending: true, error: ranTruthText({ answer: 'pending', partial: false }) };
    case 'refused': return { success: false, ran: true, truth: 'deposed', partial: false, error: ranTruthText({ answer: 'deposed', partial: false }) };
    case 'oversize': return { success: true, data: { big: 'x'.repeat(300 * 1024) } };
    case 'unserializable': return { success: true, data: { toJSON() { throw new Error('no'); } } };
    case 'throws': throw new Error('use reject');
  }
}

export function resetWorld15(world?: World15): void {
  world?.watcher.stop();
  unseePollSets();
  stopDrivers();
  setMaintenanceGate(null);
  setStoppedServingHook(null);
  _resetPanelHandler();
  stubs.manager = null;
  stubs.commands = [];
  stopDrivers();
  setMaintenanceGate(null);
  setStoppedServingHook(null);
  _resetPanelHandler();
  stubs.manager = null;
  stubs.commands = [];
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  _resetPanelLive();
}
