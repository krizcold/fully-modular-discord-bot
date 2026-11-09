import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushFate,
  FlushOutcome,
  GuildFlushBatch,
  HydrationOutcome,
  RestoreOutcome,
  RetireOutcome,
} from '../../src/bot/internalSetup/utils/dataBackends/backend';

// BT-1's scripted DataBackend, shared by the write-ticket and write-ledger tests.
// NB13: 'landed-unanswered' commits and answers as if the COMMIT's answer was lost, 'lost-unanswered' stores nothing
// and answers the same, 'commit-hang' sets commitSent and answers only when released (then as 'commit').
export type FlushMode = 'commit' | 'unavailable' | 'deposed' | 'landed-unanswered' | 'lost-unanswered' | 'commit-hang';
export type CheckMode = 'answer' | 'unknown';
export type HydrateMode = 'ok' | 'deposed' | 'unavailable' | 'held';

export interface FlushCall {
  token: FenceToken;
  batch: GuildFlushBatch;
  /** How many writes the sending set had accepted when its batch was built. */
  builtAt: number;
}

const rowKey = (guildId: string, key: DocKey) => `${guildId}|${key.module}/${key.filename}`;

export function keyOfRow(row: string): DocKey {
  const doc = row.slice(row.indexOf('|') + 1);
  const cut = doc.indexOf('/');
  return { module: doc.slice(0, cut), filename: doc.slice(cut + 1) };
}

/**
 * The DataBackend contract over a scripted store. A flush answers by the mode
 * it finds when it comes off the wire: it commits, fails as unavailable,
 * answers deposed, or commits and answers unavailable (a COMMIT whose answer
 * was lost). While holding, every flush stays on the wire until release.
 */
export class FakeStore implements DataBackend {
  readonly kind = 'postgres' as const;
  mode: FlushMode = 'commit';
  holding = false;
  reclaim: 'kept' | 'lost' | null = 'kept';
  readonly docs = new Map<string, string>();
  readonly streams = new Map<string, string>();
  readonly commits: FlushCall[] = [];
  flushesSent = 0;
  buildIndex: (token: FenceToken) => number = () => 0;
  /** How a hydration answers (R1-J2): it reads the store, is deposed, is unavailable, or waits for releaseHydrations. */
  hydrateMode: HydrateMode = 'ok';
  hydrationsSent = 0;
  /** Each guild's last committed flush id, as guild_ownership.last_flush holds it. */
  readonly marks = new Map<string, string>();
  /** Each guild's owner claim, as guild_ownership.claim holds it: raised by a commit and by takeOver. */
  readonly ownerClaims = new Map<string, number>();
  /** Guilds another holder took: a flush under a lower claim is deposed. */
  private readonly taken = new Set<string>();
  checkMode: CheckMode = 'answer';
  checkDetail = 'the check failed';
  checkCode: string | undefined = undefined;
  /** How long resolveFlush holds its answer (fake timers advance it). */
  checkDelayMs = 0;
  checksSent = 0;
  /** The code an 'unavailable' answer carries. */
  failCode: string | null = null;
  /** 'move': retireGuild moves the guild's rows into retiredRows, as the real retire moves them to the graveyard. */
  retireMode: 'unavailable' | 'move' = 'unavailable';
  readonly retiredRows = new Map<string, string>();
  private readonly wire: Array<() => void> = [];
  private readonly hydrations: Array<(mode: HydrateMode) => void> = [];

  start(): void { /* nothing to connect */ }
  async stop(): Promise<void> { /* nothing to close */ }
  connectionState(): { state: 'connecting' | 'ready' | 'outage' } {
    return { state: 'ready' };
  }

  async hydrateGuild(guildId: string): Promise<HydrationOutcome> {
    this.hydrationsSent += 1;
    let mode = this.hydrateMode;
    if (mode === 'held') mode = await new Promise<HydrateMode>(resolve => { this.hydrations.push(resolve); });
    if (mode === 'deposed') return { ok: false, reason: 'deposed' };
    if (mode === 'unavailable') return { ok: false, reason: 'unavailable' };
    const own = (row: string) => row.startsWith(`${guildId}|`);
    return {
      ok: true,
      docs: [...this.docs].filter(([row]) => own(row)).map(([row, doc]) => ({ key: keyOfRow(row), doc })),
      appendKeys: [...this.streams.keys()].filter(own).map(keyOfRow),
    };
  }

  async reclaimGuild(): Promise<'kept' | 'lost' | null> {
    return this.reclaim;
  }

  async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    const call: FlushCall = { token, batch: structuredClone(batch), builtAt: this.buildIndex(token) };
    this.flushesSent += 1;
    if (this.holding) await new Promise<void>(resolve => { this.wire.push(resolve); });
    const owner = this.ownerClaims.get(guildId);
    if (this.taken.has(guildId) && owner !== undefined && (token.claim ?? 0) < owner) {
      return { ok: false, reason: 'deposed', currentOwner: { nodeId: 'newer-owner', claim: owner } };
    }
    if (this.mode === 'commit-hang') {
      batch.commitSent = true;
      await new Promise<void>(resolve => { this.wire.push(resolve); });
    }
    if (this.mode === 'unavailable') return { ok: false, reason: 'unavailable', ...(this.failCode ? { code: this.failCode } : {}) };
    if (this.mode === 'deposed') return { ok: false, reason: 'deposed', currentOwner: { nodeId: 'newer-owner', claim: 9 } };
    if (this.mode === 'lost-unanswered') return { ok: false, reason: 'unavailable', detail: 'Connection terminated unexpectedly', commitUnanswered: true };
    for (const { key, doc } of batch.upserts) this.docs.set(rowKey(guildId, key), doc);
    for (const key of batch.deletes) {
      this.docs.delete(rowKey(guildId, key));
      this.streams.delete(rowKey(guildId, key));
    }
    for (const { key, chunk } of batch.appends) {
      this.streams.set(rowKey(guildId, key), (this.streams.get(rowKey(guildId, key)) ?? '') + chunk);
    }
    this.commits.push(call);
    if (batch.flushId) this.marks.set(guildId, batch.flushId);
    if ((token.claim ?? 0) > (this.ownerClaims.get(guildId) ?? 0)) this.ownerClaims.set(guildId, token.claim ?? 0);
    if (this.mode === 'landed-unanswered') return { ok: false, reason: 'unavailable', detail: 'Connection terminated unexpectedly', commitUnanswered: true };
    return { ok: true };
  }

  /** NB13 decision 4 over the scripted rows: the mark, then the owner claim. */
  async resolveFlush(guildId: string, flushId: string, _sentClaim: number, token: FenceToken): Promise<FlushFate> {
    this.checksSent += 1;
    if (this.checkDelayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, this.checkDelayMs); });
    if (this.checkMode === 'unknown') return { fate: 'unknown', detail: this.checkDetail, ...(this.checkCode ? { code: this.checkCode } : {}) };
    const claim = this.ownerClaims.get(guildId);
    const marked = this.marks.get(guildId) === flushId;
    if (claim !== undefined && claim > (token.claim ?? 0)) return { fate: 'deposed', landed: marked ? true : null, currentOwner: { nodeId: 'newer-owner', claim } };
    if (marked) return { fate: 'landed' };
    return { fate: 'not-landed' };
  }

  /** Another holder takes the guild: its claim above every token's, and with ownFlush a mark of its own. */
  takeOver(guildId: string, ownFlush: boolean): void {
    this.ownerClaims.set(guildId, 1_000_000_000);
    this.taken.add(guildId);
    if (ownFlush) this.marks.set(guildId, `new-holder-${guildId}`);
  }

  /** Every held hydration answers by mode from now on. */
  releaseHydrations(mode: Exclude<HydrateMode, 'held'> = 'ok'): void {
    this.hydrateMode = mode;
    for (const resume of this.hydrations.splice(0)) resume(mode);
  }

  /** The oldest held hydration answers by mode; the rest stay held. */
  releaseFirstHydration(mode: Exclude<HydrateMode, 'held'> = 'ok'): void {
    this.hydrations.shift()?.(mode);
  }

  /** Every flush held on the wire comes off it. */
  release(): void {
    for (const resume of this.wire.splice(0)) resume();
  }

  doc(guildId: string, filename: string): string | undefined {
    return this.docs.get(`${guildId}|m/${filename}`);
  }

  async retireGuild(guildId: string, ..._rest: unknown[]): Promise<RetireOutcome> {
    if (this.retireMode !== 'move') return { ok: false, reason: 'unavailable' };
    let moved = 0;
    for (const rows of [this.docs, this.streams]) {
      for (const [row, value] of [...rows]) {
        if (!row.startsWith(`${guildId}|`)) continue;
        this.retiredRows.set(row, value);
        rows.delete(row);
        moved += 1;
      }
    }
    return { ok: true, moved, retiredAt: Date.now() };
  }

  async restoreGuild(..._args: unknown[]): Promise<RestoreOutcome> {
    return { ok: false, reason: 'unavailable' };
  }

  async loadDoc(): Promise<string | null> {
    return null;
  }

  async listGuilds(): Promise<string[]> {
    return [];
  }

  async listOwnedGuilds(): Promise<string[]> {
    return [];
  }

  async listGuildFiles(): Promise<string[]> {
    return [];
  }

  async guildFileExists(): Promise<boolean> {
    return false;
  }

  onAlert(): void { /* no alerts */ }
}

let claims = 0;
export const tokenFor = (): FenceToken => ({ nodeId: 'node-a', claim: ++claims, processId: 'process-a', shardId: 0, shardCount: 1 });
