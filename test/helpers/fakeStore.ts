import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushOutcome,
  GuildFlushBatch,
  HydrationOutcome,
  RetireOutcome,
} from '../../src/bot/internalSetup/utils/dataBackends/backend';

// BT-1's scripted DataBackend, shared by the write-ticket and write-ledger tests.
export type FlushMode = 'commit' | 'unavailable' | 'read-only' | 'deposed';

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
 * refuses as read-only or answers deposed. While holding, every flush stays
 * on the wire until release.
 */
export class FakeStore implements DataBackend {
  readonly kind = 'postgres' as const;
  mode: FlushMode = 'commit';
  holding = false;
  unproven = false;
  reclaim: 'kept' | 'lost' | null = 'kept';
  readonly docs = new Map<string, string>();
  readonly streams = new Map<string, string>();
  readonly commits: FlushCall[] = [];
  flushesSent = 0;
  buildIndex: (token: FenceToken) => number = () => 0;
  private readonly wire: Array<() => void> = [];

  start(): void { /* nothing to connect */ }
  async stop(): Promise<void> { /* nothing to close */ }
  connectionState(): { state: 'connecting' | 'ready' | 'outage' } {
    return { state: 'ready' };
  }

  async hydrateGuild(guildId: string): Promise<HydrationOutcome> {
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
    if (this.mode === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (this.mode === 'read-only') return { ok: false, reason: 'read-only' };
    if (this.mode === 'deposed') return { ok: false, reason: 'deposed', currentOwner: { nodeId: 'newer-owner', term: 9, epoch: 9 } };
    for (const { key, doc } of batch.upserts) this.docs.set(rowKey(guildId, key), doc);
    for (const key of batch.deletes) {
      this.docs.delete(rowKey(guildId, key));
      this.streams.delete(rowKey(guildId, key));
    }
    for (const { key, chunk } of batch.appends) {
      this.streams.set(rowKey(guildId, key), (this.streams.get(rowKey(guildId, key)) ?? '') + chunk);
    }
    this.commits.push(call);
    return { ok: true };
  }

  /** Every flush held on the wire comes off it. */
  release(): void {
    for (const resume of this.wire.splice(0)) resume();
  }

  doc(guildId: string, filename: string): string | undefined {
    return this.docs.get(`${guildId}|m/${filename}`);
  }

  isUnproven(): boolean {
    return this.unproven;
  }

  async retireGuild(): Promise<RetireOutcome> {
    return { ok: false, reason: 'unavailable' };
  }

  async restoreGuild(): Promise<{ ok: false; reason: string }> {
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

  async sizeOfGuildData(): Promise<number> {
    return 0;
  }

  healthy(): boolean {
    return true;
  }

  isReadOnly(): boolean {
    return false;
  }

  onAlert(): void { /* no alerts */ }
}

let epochs = 0;
export const tokenFor = (): FenceToken => ({ nodeId: 'node-a', term: 1, epoch: ++epochs, shardId: 0, shardCount: 1 });
