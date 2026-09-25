// The write step of the stand-in lane (PLAN_REPLICATION 20.5, B6 map F2).
//
// A serving stand-in coordinates the fleet from a copy still in recovery. This
// module decides, once per witness tick, whether that copy may leave recovery
// and take the fleet's writes: the post-claim hold has expired, the master is
// still gone on every term the arm itself required, and the replicated in-sync
// row proves the master was synchronously waiting for THIS copy when it died.
// The promotion itself runs in the PARENT process, which is the only place the
// container-pinned URL verdict is correct (every set key reads pinned inside a
// forked child), so the decision ends in an IPC request and the parent answers
// by rewriting the arm record.

import { PEER_TERM_PROBE_MS } from './constants';
import { ArmEvidenceInputs, freeArmTerms, writeStepTiming, writeStepVerdict } from './armLane';
import { readStandbyTermRow } from './armProbe';
import { readArmRecord, writeArmRecord } from './armRecord';
import { probePeerTerm } from './peerTermProbe';
import { readPromoteRecord } from './promoteRecord';
import { canonicalStoreReachable, probeReplica } from './replicaPromotion';
import { requestStandInWrites } from './stepDown';
import { readReplayedSyncPosture, readSyncPostureRecord, syncPostureVerdict } from './syncPostureFact';
import type { WitnessStatus } from './witness';

export interface StandInWriteContext {
  nodeId: string;
  coveringNodeId: string;
  /** The local copy, credentials spliced in. */
  standInUrl: string;
  secret: string;
  /** The fleet's master candidates other than this node, read at each tick. */
  candidates: () => string[];
  /**
   * Whether a backup is registered with THIS stand-in. Its beacon's masterSeen
   * then names this node, not the master being covered, so it is no evidence
   * about that master at all; read unqualified it would pin every fleet with a
   * second backup to read-only for the whole outage.
   */
  peerRegisteredHere: (nodeId: string) => boolean;
}

let inFlight = false;

/** The reason this tick did not ask for writes, kept on the record for the Fleet tab and logged once per change. */
function noteGate(reason: string | null): void {
  const record = readArmRecord();
  if (!record || (record.phase !== 'serving' && record.phase !== 'promoting') || record.writeGate === reason) return;
  writeArmRecord({ ...record, writeGate: reason });
  if (reason) console.warn(`[Fleet] Stand-in keeps serving READ-ONLY: ${reason}`);
}

export async function evaluateStandInWrites(ctx: StandInWriteContext, renewOk: boolean, status: WitnessStatus): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    const record = readArmRecord();
    if (!record || record.coveringNodeId !== ctx.coveringNodeId) return;
    if (record.phase !== 'serving' && record.phase !== 'promoting') return;
    // Checked BEFORE the timing: a promote record, running or parked, means
    // the parent received the request and owns the step from here. Treating a
    // parked one as an unanswered request would reset this record to serving
    // under it, after which Continue (which needs promoting) and Cancel (which
    // needs a copy still in recovery) can both refuse, with no exit left.
    const promote = readPromoteRecord();
    if (promote && promote.phase !== 'done') {
      noteGate(promote.parked ? 'a promote is parked on this node; Continue or Cancel it from the Fleet tab' : 'a promote is running on this node');
      return;
    }
    const timing = writeStepTiming(record, now);
    switch (timing.step) {
      case 'hold':
        noteGate(`holding ${Math.ceil(timing.remainingMs / 1000)}s more after the claim before writes may be taken (20.6)`);
        return;
      case 'requested':
        return;
      case 'stale-request':
        writeArmRecord({ ...record, phase: 'serving', writeRequestedAt: null, writeGate: 'the request to take writes went unanswered; asking again' });
        console.warn('[Fleet] Stand-in: the request to take writes went unanswered; asking again on the next tick');
        return;
      case 'after-refusal':
        noteGate(`the last request to take writes was refused (${record.writeRefusal ?? 'no reason recorded'}); asking again in ${Math.ceil(timing.remainingMs / 60_000)} min`);
        return;
      case 'check':
        break;
    }
    // The same six terms the arm required, gathered again from where a serving
    // master stands: no control client exists here, so the covered master is
    // asked directly through the fence's own peer probe.
    const free = freeArmTerms(status, ctx.nodeId, now, id => ctx.peerRegisteredHere(id));
    const cheap = {
      ownRenewOk: renewOk,
      masterBeaconDark: free.masterBeaconDark,
      noPeerSeesMaster: free.noPeerSeesMaster,
    };
    // Free evidence first; the connections below are only opened once it agrees.
    // Passing the costly terms as satisfied is safe because this call can only refuse.
    const cheapVerdict = writeStepVerdict({ ...cheap, masterUnreachable: true, storeUnreachable: true, receiverStopped: true }, { inSync: true, heldToLsn: null, reason: '' }, free.absent);
    if (!cheapVerdict.arm) {
      noteGate(`writes not taken: ${cheapVerdict.reason}`);
      return;
    }

    let masterAnswers = false;
    for (const url of ctx.candidates()) {
      const peer = await probePeerTerm(url, ctx.secret, PEER_TERM_PROBE_MS);
      if (peer && peer.nodeId === ctx.coveringNodeId) {
        masterAnswers = true;
        break;
      }
    }
    const copy = await probeReplica(ctx.standInUrl);
    const evidence: ArmEvidenceInputs = {
      ...cheap,
      masterUnreachable: !masterAnswers,
      storeUnreachable: !(await canonicalStoreReachable()).ok,
      receiverStopped: copy.ok === true && copy.receiverStreaming !== true,
    };
    // Read FRESH at the decision, never from the sampler's cache: a relax this
    // copy has already replayed is invisible in a cached read.
    const replayed = await readReplayedSyncPosture(ctx.standInUrl);
    const pushed = readSyncPostureRecord();
    const termRow = await readStandbyTermRow(ctx.standInUrl);
    const sync = syncPostureVerdict({
      replayed,
      pushed,
      mySlotName: copy.slotName ?? null,
      sourceIsCurrentMaster: replayed !== null && replayed.fact.masterNodeId === ctx.coveringNodeId && pushed?.sourceIsCurrentMaster !== false,
      copyTerm: termRow?.term ?? null,
    }, now);
    const verdict = writeStepVerdict(evidence, sync, free.absent);
    if (!verdict.arm) {
      noteGate(`writes not taken: ${verdict.reason}`);
      return;
    }

    // Re-read after the awaits above: the 5 s witness consumer can disarm this
    // record while the probes run, and writing the pre-await snapshot back
    // would resurrect a stand-in that has already recognised a higher term.
    const fresh = readArmRecord();
    if (!fresh || fresh.phase !== 'serving' || fresh.coveringNodeId !== ctx.coveringNodeId) {
      console.warn(`[Fleet] Stand-in: the arm record changed while the write step was measured (now ${fresh?.phase ?? 'absent'}); not asking`);
      return;
    }
    writeArmRecord({ ...fresh, phase: 'promoting', writeRequestedAt: now, writeGate: null, writeRefusal: null, writeRefusedAt: null });
    console.error(`[Fleet] STAND-IN TAKING WRITES for ${ctx.coveringNodeId}: the master is still gone on all six checks after the post-claim hold, and this copy was synchronously held to ${sync.heldToLsn}; asking the parent to promote the copy`);
    requestStandInWrites({ coveringNodeId: ctx.coveringNodeId, inheritedTerm: record.inheritedTerm, heldToLsn: sync.heldToLsn });
  } catch (error) {
    console.warn('[Fleet] Stand-in write-step evaluation failed:', error instanceof Error ? error.message : error);
  } finally {
    inFlight = false;
  }
}
