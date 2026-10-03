// Master-side planned transfer (B4f-4, file mode; fleet master only, never
// constructed standalone). The designated backup asks this master to retire
// every shard it holds onto it, follows that retire, and takes the handover:
// the placement documents, after which this master deposes itself and the
// backup's beacon finishes its step-down. WHO may ask is the bootstrap's
// refusal (the designated backup, in file mode); this module judges the
// retire and the handover.

import { MSG, TransferHandoverReply, TransferStartReply, TransferStatusReply } from './protocol';
import type { PrecheckResult, StartRetirePayload } from './migration/migrationCoordinator';
import type { MigrationView } from './state';

/** The coordinator surface the transfer uses. */
export interface TransferCoordinator {
  activeRetire(): { id: string; state: string; paused: boolean; legs: { shardId: number; from: string; to: string; done: boolean }[]; currentLegIndex: number; error?: string } | null;
  getView(): MigrationView;
  hasActive(): boolean;
  precheck(payload: StartRetirePayload): Promise<PrecheckResult>;
  start(payload: StartRetirePayload): Promise<{ ok: boolean; error?: string; migrationId?: string }>;
  resume(migrationId: string): Promise<{ ok: boolean; error?: string }>;
  abort(migrationId: string, wholeRetire?: boolean): Promise<{ ok: boolean; error?: string }>;
}

export interface TransferAuthorityHooks {
  selfNodeId: string;
  selfNodeName: string;
  getTerm: () => number;
  /** Why the node may not ask (not the designated backup, not registered, not file mode, deposed, a stand-in, the reshard pause, a transformation, a cleanup a node owes); null when it may. */
  refusal: (requester: string) => string | null;
  heldShards: () => number[];
  nodeName: (nodeId: string) => string | null;
  coordinator: () => TransferCoordinator | null;
  /** The placement documents as the control store holds them now. */
  documents: () => Promise<{ name: string; body: string }[]>;
  /** Why the stored plan may not place every shard as served, short of a write; null when settled. */
  unsettled: () => string | null;
  /** Writes the plan as served into the control store. */
  persistPlan: () => Promise<void>;
  /** A control fence already stopped this master. */
  deposed: () => boolean;
  /** The supersession: stop granting, drop every worker, stage the co-worker role. */
  handOver: (by: { nodeId: string; nodeName: string; term: number }) => void;
}

export class TransferAuthority {
  private handedOverTo: { nodeId: string; reply: TransferHandoverReply } | null = null;

  constructor(private readonly hooks: TransferAuthorityHooks) {}

  /** TRANSFER_START, TRANSFER_STATUS and TRANSFER_ABORT from a registered node. */
  async request(requester: string, type: string, data: any): Promise<TransferStartReply | TransferStatusReply | { ok: boolean; error?: string }> {
    // Stopping a retire of this master onto the asker is always safe, so the
    // abort is answered ahead of the who-may-ask refusal (a backup moved down
    // the order, a reshard pause): whichever such retire runs is the
    // transfer's, whatever id the backup's record holds.
    if (type === MSG.TRANSFER_ABORT) {
      const coordinator = this.hooks.coordinator();
      const retire = coordinator?.activeRetire() ?? null;
      if (!coordinator || !retire || retire.legs.length === 0 || !retire.legs.every(l => l.from === this.hooks.selfNodeId && l.to === requester)) return { ok: true };
      const asker = this.hooks.nodeName(requester) ?? requester.slice(0, 8);
      const aborted = await coordinator.abort(retire.id, true);
      if (aborted.ok) console.warn(`[Fleet] PLANNED TRANSFER cancelled by ${asker}: the retire ${retire.id} is aborted; the legs it completed stand`);
      else console.warn(`[Fleet] PLANNED TRANSFER cancelled by ${asker}, but the retire ${retire.id} could not be aborted yet (${aborted.error}); the backup asks again`);
      return aborted.ok ? { ok: true } : { ok: false, error: aborted.error };
    }
    const coordinator = this.hooks.coordinator();
    if (!coordinator) return { ok: false, error: 'migrations are unavailable on this master' };
    const self = this.hooks.selfNodeId;
    const retire = coordinator.activeRetire();
    const ours = !!retire && retire.legs.length > 0 && retire.legs.every(l => l.from === self && l.to === requester);
    const name = this.hooks.nodeName(requester) ?? requester.slice(0, 8);
    if (type === MSG.TRANSFER_STATUS) {
      const id = typeof data?.migrationId === 'string' ? data.migrationId : null;
      const running = retire && retire.id === id ? retire : null;
      const view = coordinator.getView();
      const finished = id && !running ? [...view.history].reverse().find(h => h.id === id) ?? null : null;
      return {
        ok: true,
        heldShards: this.hooks.heldShards(),
        active: running ? {
          state: running.state,
          paused: running.paused,
          legsDone: running.legs.filter(l => l.done).length,
          legsTotal: running.legs.length,
          shardId: running.legs[running.currentLegIndex]?.shardId ?? null,
          ...(running.error ? { error: running.error } : {}),
        } : null,
        finished: finished ? { state: finished.state, ...(finished.error ? { error: finished.error } : {}) } : null,
        otherActive: !running && view.active ? view.active.kind : null,
      };
    }
    // Past the status, which is read-only like the abort: a backup refused
    // mid-retire follows the retire to its end and hears the refusal from
    // the handover rather than reading it as silence.
    const refusal = this.hooks.refusal(requester);
    if (refusal) return { ok: false, error: refusal };
    if (type !== MSG.TRANSFER_START) return { ok: false, error: `unknown transfer request: ${type}` };
    // The retire of this master onto the backup, or its paused one resumed
    // (a Continue on the backup), or nothing to move.
    if (retire && ours) {
      if (data?.precheck !== true && retire.paused) {
        const resumed = await coordinator.resume(retire.id);
        if (!resumed.ok) return { ok: false, error: resumed.error };
        console.warn(`[Fleet] PLANNED TRANSFER to ${name}: the paused retire ${retire.id} resumes`);
      }
      return { ok: true, migrationId: retire.id, legs: retire.legs.length };
    }
    if (coordinator.hasActive()) return { ok: false, error: `a ${coordinator.getView().active?.kind ?? 'migration'} is running on the fleet; the transfer waits until it finishes` };
    const held = this.hooks.heldShards();
    if (held.length === 0) return { ok: true, migrationId: null, legs: 0 };
    const payload: StartRetirePayload = { kind: 'retire', nodeId: self, targets: Object.fromEntries(held.map(shardId => [String(shardId), requester])) };
    if (data?.precheck === true) {
      const pre = await coordinator.precheck(payload);
      return pre.ok ? { ok: true, migrationId: null, legs: held.length, ...(pre.warnings && pre.warnings.length > 0 ? { warnings: pre.warnings } : {}) } : { ok: false, error: pre.error };
    }
    const started = await coordinator.start(payload);
    if (!started.ok) return { ok: false, error: started.error };
    console.warn(`[Fleet] PLANNED TRANSFER to ${name}: retiring shard(s) [${held.join(', ')}] of this master onto it (migration ${started.migrationId})`);
    return { ok: true, migrationId: started.migrationId ?? null, legs: held.length };
  }

  /**
   * TRANSFER_HANDOVER, pre-registration. The answer carries the documents;
   * once it is on the wire this master deposes itself. A backup whose answer
   * was lost asks again and takes the same one.
   */
  async handover(data: any): Promise<{ reply: TransferHandoverReply; afterReply?: () => void }> {
    const requester = typeof data?.nodeId === 'string' ? data.nodeId : '';
    if (this.handedOverTo) {
      return this.handedOverTo.nodeId === requester
        ? { reply: this.handedOverTo.reply }
        : { reply: { ok: false, error: `this master handed over to node ${this.handedOverTo.nodeId.slice(0, 8)} already` } };
    }
    const term = Number(data?.term);
    const blocked = (): TransferHandoverReply | null => {
      const refusal = this.hooks.refusal(requester);
      if (refusal) return { ok: false, error: refusal };
      const coordinator = this.hooks.coordinator();
      if (coordinator?.hasActive()) return { ok: false, error: `a ${coordinator.getView().active?.kind ?? 'migration'} is running on the fleet` };
      const held = this.hooks.heldShards();
      if (held.length > 0) return { ok: false, error: `this master holds shard(s) [${held.join(', ')}]; the backup moves them here first`, heldShards: held };
      const unsettled = this.hooks.unsettled();
      if (unsettled) return { ok: false, error: `the plan is not settled: ${unsettled}` };
      if (!Number.isInteger(term) || term <= this.hooks.getTerm()) return { ok: false, error: `the term the backup would mint (${String(data?.term)}) is not above this master's term ${this.hooks.getTerm()}` };
      return null;
    };
    const before = blocked();
    if (before) return { reply: before };
    // Written first: a lease a heartbeat confirmed may not be in the store yet.
    try {
      await this.hooks.persistPlan();
    } catch (error) {
      return { reply: { ok: false, error: `writing the plan to the control store failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
    const documents = await this.hooks.documents();
    // Judged again past the read: a grant or a migration may have landed meanwhile.
    const after = blocked() ?? (this.handedOverTo ? { ok: false, error: 'another handover landed meanwhile' } : null);
    if (after) return { reply: after };
    const name = this.hooks.nodeName(requester) ?? requester.slice(0, 8);
    const reply: TransferHandoverReply = { ok: true, masterNodeId: this.hooks.selfNodeId, masterNodeName: this.hooks.selfNodeName, masterTerm: this.hooks.getTerm(), documents };
    return {
      reply,
      afterReply: () => {
        if (this.handedOverTo || this.hooks.deposed()) return;
        this.handedOverTo = { nodeId: requester, reply };
        console.warn(`[Fleet] PLANNED TRANSFER: handed over to ${name}, which boots as master at term ${term}; this master steps down once its beacon is seen`);
        this.hooks.handOver({ nodeId: requester, nodeName: name, term });
      },
    };
  }
}
