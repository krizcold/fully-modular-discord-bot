// NB9 16: Discord's identify spacing kept across every process of the bot. Each identify waits its turn in a local queue
// keyed on shardId % max_concurrency, as @discordjs/ws's SimpleIdentifyThrottler does, then reserves its bucket: in the
// database ('database'), from the web UI process ('parent'), or by this process's own clock ('local').

import { randomUUID } from 'crypto';
import { IDENTIFY_SPACING_MS } from './constants';
import { ClaimPausedError, classifyFailure, identifyAborted as aborted, type FailureClass } from './claimStore';
import { describeFailureClass } from './shardClaims';

export type SlotMode = 'database' | 'parent' | 'local';

export interface SlotThrottlerDeps {
  mode: SlotMode;
  /** 'database': the slot statements on the claims pool's identify lane (ClaimStore.reserveIdentifySlot). */
  reserve?: (bucket: number, signal?: AbortSignal) => Promise<{ granted: true } | { granted: false; waitMs: number }>;
  /** 'parent': the web UI's wait in ms (0 grants), or null when it did not answer within 5 s. */
  askParent?: (bucket: number) => Promise<number | null>;
  renewMs: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 0 to 1, for the jitter after a refused slot. */
  random?: () => number;
}

const JITTER_MS = 500;
const FAILURE_LOG_MS = 30_000;
const PARENT_ANSWER_MS = 5000;

export class SlotThrottler {
  private current: SlotMode;
  private readonly queues = new Map<number, Promise<void>>();
  private readonly localLast = new Map<number, number>();
  private lastFailureLog = -Infinity;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(readonly maxConcurrency: number, private readonly deps: SlotThrottlerDeps) {
    this.current = deps.mode;
    this.log = deps.log ?? console;
  }

  mode(): SlotMode {
    return this.current;
  }

  /** @discordjs/ws's IIdentifyThrottler: resolves when the shard may send IDENTIFY; rejects when the signal aborts. */
  async waitForIdentify(shardId: number, signal: AbortSignal): Promise<void> {
    const bucket = shardId % Math.max(this.maxConcurrency, 1);
    const before = this.queues.get(bucket) ?? Promise.resolve();
    let done: () => void = () => undefined;
    const mine = new Promise<void>(resolve => { done = resolve; });
    this.queues.set(bucket, before.then(() => mine));
    try {
      await abortable(before, signal);
      await this.reserve(bucket, shardId, signal);
    } finally {
      done();
    }
  }

  private async reserve(bucket: number, shardId: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw aborted();
      if (this.current === 'local') return this.localWait(bucket, signal);
      if (this.current === 'parent') {
        const waitMs = await abortable(this.deps.askParent!(bucket), signal);
        if (waitMs === null) {
          this.log.warn(l25Line(shardId));
          return this.localWait(bucket, signal);
        }
        if (waitMs <= 0) return;
        await sleep(waitMs, signal);
        continue;
      }
      let answer: { granted: true } | { granted: false; waitMs: number };
      try {
        answer = await abortable(this.deps.reserve!(bucket, signal), signal);
      } catch (error) {
        if (signal.aborted) throw aborted();
        if (error instanceof ClaimPausedError) {
          await sleep(this.deps.renewMs, signal);
          continue;
        }
        const failure = classifyFailure(error);
        if (failure.kind === 'refused') {
          this.current = 'local';
          this.log.warn(l24Line(shardId));
          return this.localWait(bucket, signal);
        }
        const now = Date.now();
        if (now - this.lastFailureLog >= FAILURE_LOG_MS) {
          this.lastFailureLog = now;
          this.log.warn(l23Line(failure, shardId, this.deps.renewMs));
        }
        await sleep(this.deps.renewMs, signal);
        continue;
      }
      this.lastFailureLog = -Infinity;
      if (answer.granted) return;
      await sleep(answer.waitMs + (this.deps.random ?? Math.random)() * JITTER_MS, signal);
    }
  }

  private async localWait(bucket: number, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const at = Math.max((this.localLast.get(bucket) ?? -Infinity) + IDENTIFY_SPACING_MS, now);
    this.localLast.set(bucket, at);
    if (at > now) await sleep(at - now, signal);
  }
}

/** The Client's `ws.buildIdentifyThrottler`: max_concurrency from the manager's gateway information. */
export function slotThrottlerBuilder(deps: SlotThrottlerDeps): (manager: { fetchGatewayInformation(): Promise<{ session_start_limit: { max_concurrency: number } }> }) => Promise<SlotThrottler> {
  return async manager => {
    const info = await manager.fetchGatewayInformation();
    return new SlotThrottler(info.session_start_limit.max_concurrency, deps);
  };
}

interface ParentChannel {
  send?: (message: unknown) => boolean;
  on(event: 'message', fn: (message: any) => void): unknown;
  off(event: 'message', fn: (message: any) => void): unknown;
}

/** 'parent': 'identify:slot' `{ nonce, bucket }` to the web UI; its answer `{ nonce, waitMs }`, or null after 5 s. */
export function parentSlotAsker(channel: ParentChannel = process as unknown as ParentChannel): (bucket: number) => Promise<number | null> {
  return bucket => new Promise(resolve => {
    const nonce = randomUUID();
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: number | null) => {
      if (timer) clearTimeout(timer);
      channel.off('message', onMessage);
      resolve(value);
    };
    const onMessage = (message: any) => {
      if (message?.type !== 'identify:slot' || message.data?.nonce !== nonce) return;
      const waitMs = Number(message.data.waitMs);
      finish(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0);
    };
    channel.on('message', onMessage);
    timer = setTimeout(() => finish(null), PARENT_ANSWER_MS);
    timer.unref?.();
    try {
      if (!channel.send || channel.send({ type: 'identify:slot', data: { nonce, bucket } }) === false) finish(null);
    } catch {
      finish(null);
    }
  });
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); }), signal);
}

/** NB9 L23. */
export function l23Line(failure: FailureClass, shardId: number, renewMs: number): string {
  return `[Shards] Cannot reserve a gateway login slot in the database (${describeFailureClass(failure)}); shard ${shardId} waits and tries again every ${Math.round(renewMs / 100) / 10} s`;
}

/** NB9 L24. */
export function l24Line(shardId: number): string {
  return `[Shards] The database refused the login while shard ${shardId} waited for a gateway login slot; this process spaces its own logins from now on`;
}

/** NB9 L25. */
export function l25Line(shardId: number): string {
  return `[Shards] The web UI did not answer a gateway login slot request within 5 s; shard ${shardId} uses this process's own spacing`;
}
