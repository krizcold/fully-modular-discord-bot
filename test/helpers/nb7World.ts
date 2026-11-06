import { expect, vi } from 'vitest';

import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import { CHANGED_TEXT, type DataWriteReply } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { changeDeadlineMs, type GuildRequestOp } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetGuildRequests, _setGuildRequestDeps, endGuildRequests, planGuildChange, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { ModelDb, type Bites, type Fate } from './nb7Model';
import { BOT_DOWN, fakeBot, GUILD, heldRow } from './nb7Rig';
import { setBackendKind } from './backendKind';

// NB7 tests 7 and 8: the real sender and the real holder's sweep over the model store, driven one step at a time.
// The holder's executor is a stand-in whose applies the test finishes; started counts every apply it began, which is
// what "nothing was saved" must exclude (invariant 2).

export type Outcome = 'ok' | 'pending' | 'refused' | 'maintenance' | 'deposed' | 'changed';

export interface Sent {
  op: GuildRequestOp;
  id?: string;
  answer?: any;
  /** The database time of the plan's start and of the route's answer. */
  sentAt?: number;
  answeredAt?: number;
  /** The web UI exited, or the sender crashed, before this request was answered. */
  cut?: boolean;
  crashed?: boolean;
}

const OUTCOMES: Record<Outcome, DataWriteReply> = {
  ok: { ok: true },
  pending: { ok: true, pending: true },
  refused: { ok: false, code: 'invalid', error: 'The data was not saved: refused by the executor' },
  maintenance: { ok: false, code: 'maintenance', error: 'Back soon' },
  deposed: { ok: false, code: 'not-owner', error: 'another bot process took ownership of this guild mid-write; it was not saved' },
  changed: { ok: false, code: 'changed', which: 'target', error: CHANGED_TEXT } as DataWriteReply,
};

export const payloadOf = (op: GuildRequestOp) => (op === 'write'
  ? { guildId: GUILD, module: 'm', filename: 'a.json', op, contentJson: '{"a":1}', expectSha: 'absent' }
  : op === 'delete' ? { guildId: GUILD, module: 'm', filename: 'a.json', op } : { guildId: GUILD, module: '', filename: '', op });

export class World {
  readonly model: ModelDb;
  sweep!: GuildRequestSweep;
  pid = 'p-b';
  gen = 0;
  stopping = false;
  readonly started = new Map<string, number>();
  readonly outcomes = new Map<string, Outcome>();
  /** The executor's documents: a request whose change it holds compares against it, as compareRead reads the working set. */
  readonly saved = new Set<string>();
  readonly applying: Array<{ id: string; gen: number; resolve: (reply: DataWriteReply) => void }> = [];
  readonly sends: Sent[] = [];
  /** Requests whose holder may have changed them outside the model's sight (a crash drops an apply in flight). */
  readonly dropped = new Set<string>();
  /** Requests a database away or a failover touched while they were followed. */
  readonly disturbed = new Set<string>();
  /** The executor's answer to the next applies, in order; 'ok' after them. */
  readonly script: Outcome[] = [];
  /** Whether each apply waits for finish(); otherwise it answers at once. */
  holdApplies = true;
  exited = false;

  constructor(fates: Fate[] = [], bites: Bites = {}) {
    this.model = new ModelDb(fates, { ...bites, startedMap: bites.startedMap ? () => new Set(this.started.keys()) : undefined });
    _resetGuildRequests();
    setBackendKind('postgres');
    _setGuildRequestDeps({
      holderOf: async () => {
        if (this.model.loginRefused) throw Object.assign(new Error('role is not permitted to log in'), { code: '28000' });
        if (this.model.away) throw new Error('connect ECONNREFUSED');
        const c = this.model.claim;
        return { rows: [heldRow({ holder_process: c.holderProcess, node_process_id: c.holderProcess, holder_node: c.holderProcess === 'p-c' ? 'n-c' : 'n-b', holder_name: c.holderProcess === 'p-c' ? 'CHARLIE' : 'BRAVO', claim: String(c.claim), released: c.released })] };
      },
      currentUrl: () => 'postgres://model',
      requestDb: () => this.model.requestDb(),
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    this.newSweep();
  }

  private newSweep(): void {
    const gen = this.gen;
    const pid = this.pid;
    const claim = this.model.claim.claim;
    this.sweep = new GuildRequestSweep({
      db: this.model.sweepDb(pid),
      processId: () => pid,
      pairs: () => [{ shardCount: 2, shardId: 1, claim }],
      stoppedServing: () => false,
      isStopping: () => gen === this.gen && this.stopping,
      apply: req => {
        const id = String(req.filename);
        this.started.set(id, (this.started.get(id) ?? 0) + 1);
        if (this.saved.has(id)) {
          this.outcomes.set(id, 'changed');
          return Promise.resolve(OUTCOMES.changed);
        }
        const scripted = this.script.shift();
        // The maintenance refusal is answered before the executor (answerGuildWrite): nothing started.
        if (scripted === 'maintenance') {
          this.started.set(id, (this.started.get(id) ?? 1) - 1);
          return Promise.resolve(OUTCOMES.maintenance);
        }
        if (!this.holdApplies) {
          const kind = scripted ?? 'ok';
          this.outcomes.set(id, kind);
          if (kind === 'ok' || kind === 'pending') this.saved.add(id);
          return Promise.resolve(OUTCOMES[kind]);
        }
        return new Promise<DataWriteReply>(resolve => { this.applying.push({ id, gen, resolve }); });
      },
    });
  }

  /** The web panel sends a change; its answer lands on the Sent when the route answers. */
  async send(op: GuildRequestOp = 'write'): Promise<Sent> {
    const before = this.model.sentInserts.length;
    const sent: Sent = { op, sentAt: this.model.now };
    this.sends.push(sent);
    const plan = await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, op);
    void sendGuildChange(fakeBot().bot, plan, payloadOf(op) as any).then(a => {
      if (sent.crashed) return;
      sent.answer = a;
      sent.answeredAt = this.model.now;
    });
    await flush();
    sent.id = this.model.sentInserts[before];
    return sent;
  }

  async pass(): Promise<void> {
    await this.sweep.pass();
    await flush();
  }

  /** The oldest apply of the running process ends with kind. */
  async finish(kind: Outcome = 'ok'): Promise<void> {
    const at = this.applying.findIndex(a => a.gen === this.gen);
    if (at < 0) return;
    const [apply] = this.applying.splice(at, 1);
    this.outcomes.set(apply.id, kind);
    if (kind === 'ok' || kind === 'pending') this.saved.add(apply.id);
    apply.resolve(OUTCOMES[kind]);
    await flush();
  }

  /** The holder process dies: its applies in flight never answer; it restarts with a new process id and claim. */
  crash(): void {
    for (const a of this.applying) if (a.gen === this.gen) this.dropped.add(a.id);
    this.model.deadPids.add(this.pid);
    this.gen += 1;
    this.pid = `p-b${this.gen}`;
    this.stopping = false;
    this.model.claim = { ...this.model.claim, holderProcess: this.pid, claim: this.model.claim.claim + 1 };
    this.newSweep();
  }

  /** The holder process dies and nothing restarts it: its claim row still names it until the row expires. */
  kill(): void {
    for (const a of this.applying) if (a.gen === this.gen) this.dropped.add(a.id);
    this.model.deadPids.add(this.pid);
    this.gen += 1;
    const dead = new GuildRequestSweep({
      db: this.model.sweepDb('p-dead'), processId: () => null, pairs: () => [], stoppedServing: () => true, isStopping: () => true,
      apply: async () => ({ ok: false, code: 'io-error', error: 'dead' }),
    });
    this.sweep = dead;
  }

  /** The stop step runs on the model's clock: it ends when its work does or at its 2 s bound, as on a real clock. */
  async stop(): Promise<void> {
    this.stopping = true;
    let ended = false;
    void this.sweep.stopStep().then(() => { ended = true; });
    await flush();
    for (let i = 0; i < 25 && !ended; i++) await this.advance(100);
  }

  /** Another machine takes the shard. */
  takeover(): void {
    this.model.claim = { ...this.model.claim, holderProcess: 'p-c', claim: this.model.claim.claim + 1 };
  }

  /** The web UI exits: decision 14's settle. */
  async exit(): Promise<void> {
    for (const s of this.sends) if (!s.answer) s.cut = true;
    this.exited = true;
    await endGuildRequests();
    await flush();
  }

  /** The web UI is killed: no answer of any request it followed is read from now on. */
  crashSender(): void {
    for (const s of this.sends) {
      if (s.answer) continue;
      s.crashed = true;
      s.cut = true;
      if (s.id) this.model.dead.add(s.id);
    }
  }

  async advance(ms: number): Promise<void> {
    this.model.now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  }

  away(): void {
    this.model.away = true;
    this.disturbFollowed();
  }

  /** The database refuses this bot's login (28000): every connect and statement is refused. */
  refuseLogin(): void {
    this.model.loginRefused = true;
    this.disturbFollowed();
  }

  back(): void {
    this.model.away = false;
  }

  /**
   * The standby is promoted behind the same URL. The holder's applies, finished or in flight, stay in its memory and
   * reach the promoted store with its next flush (gatekeeper ruling 6), so started keeps counting them.
   */
  failover(): void {
    this.model.failover();
    this.disturbFollowed();
  }

  private disturbFollowed(): void {
    for (const s of this.sends) if (s.id && !s.answer) this.disturbed.add(s.id);
  }

  /** Everything left runs out: late statements land, applies finish, the holder sweeps, every sender answers by its T. */
  async drain(): Promise<void> {
    this.model.away = false;
    this.model.loginRefused = false;
    for (let i = 0; i < 100; i++) {
      this.model.runLate();
      while (this.applying.some(a => a.gen === this.gen)) await this.finish('ok');
      await this.pass();
      await this.advance(1000);
      this.check();
    }
  }

  /** The properties of test 7, after every step. */
  check(): void {
    for (const [id, n] of this.started) expect(n, `request ${id} applied ${n} times`).toBeLessThanOrEqual(1);
    for (const sent of this.sends) {
      if (!sent.answer || !sent.id) continue;
      const started = this.started.get(sent.id) ?? 0;
      const text = String(sent.answer.error ?? '');
      if (sent.answer.sender && /nothing was/i.test(text)) expect(started, `"${text}" answered for a request the holder started`).toBe(0);
      if (sent.answer.ok === true) {
        expect(started, 'ok answered for a request nobody applied').toBe(1);
        expect(this.outcomes.get(sent.id)).toBe(sent.answer.pending ? 'pending' : 'ok');
      }
      if (sent.answer.noAnswer) {
        const unseen = this.model.senderLost.has(sent.id) || this.disturbed.has(sent.id) || !!sent.cut || this.dropped.has(sent.id) || this.doneTooLate(sent);
        expect(unseen, `can't confirm (${sent.answer.noAnswer}) answered for request ${sent.id} with nothing the sender could not observe`).toBe(true);
      }
    }
  }

  /**
   * Whether the row was not 'done' early enough for the follow to read it: the follow polls every 250 ms until T minus
   * 5 s, so a row done 500 ms before the answer (or before T minus 5 s) is one the sender saw unless a poll failed. A
   * row never done is one the sender could not see the end of only when a claim took it.
   */
  private doneTooLate(sent: Sent): boolean {
    const at = this.model.doneAt.get(sent.id!);
    if (at === undefined) return this.model.claimed.has(sent.id!);
    const followEnd = sent.sentAt! + changeDeadlineMs(sent.op) - 5000;
    return at > Math.min(sent.answeredAt ?? Infinity, followEnd) - 500;
  }

  /** Applications of a request: 0, 1, or undefined while its outcome is unknown to the model. */
  applications(sent: Sent): number {
    return sent.id ? this.started.get(sent.id) ?? 0 : 0;
  }
}

export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

export function fakeModelTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
}

export function quietLogs(): { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

export function resetWorld(): void {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
}
