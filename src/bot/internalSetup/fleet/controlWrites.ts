import type { RegisterResult } from './protocol';

/** How long a control-store write may take before its outcome is given up as unknown. */
export const CONTROL_WRITE_DEADLINE_MS = 45_000;

/** A control-store write that passed its deadline: its COMMIT may already be sent, so it can still land. */
export class ControlWriteUnconfirmedError extends Error {
  constructor(what: string) {
    super(`${what} was not answered within ${Math.round(CONTROL_WRITE_DEADLINE_MS / 1000)}s`);
    this.name = 'ControlWriteUnconfirmedError';
  }
}

/** A plan write the control store refused, whole or in part: the plan document may have landed while the registry's was refused. */
export class ControlWriteError extends Error {
  readonly unconfirmed: boolean;

  constructor(readonly planLanded: boolean, refused: unknown) {
    super(refused instanceof Error ? refused.message : String(refused));
    this.name = 'ControlWriteError';
    this.unconfirmed = refused instanceof ControlWriteUnconfirmedError;
  }
}

export const planLanded = (error: unknown): boolean => error instanceof ControlWriteError && error.planLanded;

/** The write's outcome is unknown (it may still land), not refused. */
export const unconfirmed = (error: unknown): boolean => error instanceof ControlWriteUnconfirmedError || (error instanceof ControlWriteError && error.unconfirmed);

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** What a reply says of a refused or unconfirmed plan write, per document. */
export function refusedWriteNote(error: unknown): string {
  if (planLanded(error)) {
    return unconfirmed(error)
      ? `the plan landed; the registry write could not be confirmed (${reason(error)}) and is written again on a later placement pass`
      : `the plan landed; the registry write was refused (${reason(error)}) and is written again on a later placement pass`;
  }
  return unconfirmed(error)
    ? `the plan write could not be confirmed (${reason(error)}; it can still land), written again on a later placement pass`
    : `the control store refused the plan write (${reason(error)}), written again on a later placement pass`;
}

/** What a reply says of a refused or unconfirmed migration record write. */
export function recordWriteNote(error: unknown): string {
  return unconfirmed(error)
    ? `the migration record write could not be confirmed (${reason(error)}; it can still land)`
    : `the control store refused the migration record (${reason(error)})`;
}

/** A held-shard choice whose write did not land: the shard still waits on a choice here. */
export function choiceNotSavedText(error: unknown, shardId: number): string {
  return unconfirmed(error)
    ? `the choice could not be confirmed (${reason(error)}; it can still land); shard ${shardId} still waits on a choice here, choose again`
    : `the choice was not saved (${reason(error)}); shard ${shardId} still waits on it`;
}

/** A Declare Lost whose migration record write did not land: nothing changed here. */
export function declareNotDoneText(error: unknown, nodeName: string): string {
  return unconfirmed(error)
    ? `${nodeName} is not declared lost here: ${recordWriteNote(error)}; declare it lost again`
    : `${nodeName} is not declared lost: ${recordWriteNote(error)}; nothing changed, try again`;
}

export type RestorePlacement = 'unsaved' | 'holder-gone' | 'place-down' | 'place';

/**
 * What a Restore does once its plan write settled (null when it landed
 * whole): memory takes only what the store holds, and never a node gone
 * meanwhile; a holder that disconnected meanwhile keeps the stored lease.
 */
export function restorePlacement(writeError: unknown, holder: { connected: boolean } | undefined): RestorePlacement {
  if (writeError !== null && !planLanded(writeError)) return 'unsaved';
  if (!holder) return 'holder-gone';
  return holder.connected ? 'place' : 'place-down';
}

/** A settled redistribute proposal is cleared only once every shard landed and the plan holding them is stored. */
export function proposalClearable(pendingShards: number, planKey: string, storedPlanKey: string | null): boolean {
  return pendingShards === 0 && planKey === storedPlanKey;
}

/** A node registering while its Declare Lost is being written is refused, granted nothing: it retries and rejoins once the verdict stands. */
export function declareLostRegisterRefusal(declaringLost: ReadonlySet<string>, nodeId: string, term: number): RegisterResult | null {
  return declaringLost.has(nodeId) ? { accepted: false, term, reason: 'declare-lost-in-flight' } : null;
}
