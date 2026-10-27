// The scope record (BT-5): every write the data facade accepts with a ticket, and every write it refuses, kept per
// scope ('global' or a guild id) and stamped in acceptance order, so confirmSaved answers for every write made for a
// scope after a mark through the same tickets the reply gate confirms (notes/BT.md, "BT-5 design sheet: final").

import { randomUUID } from 'crypto';

import type { FileTicket } from './fileBackend';
import type { WsTicket } from './workingSet';

/** A point in this run's acceptance order. The run is new at every start, so a mark kept from before a restart is refused. */
export interface SaveMark {
  readonly run: string;
  readonly stamp: number;
}
type Ticket = WsTicket | FileTicket;

/** Lost marks, and refused documents, kept per scope; dropping the oldest raises the scope's prunedThrough. */
export const LOST_MARKS_PER_SCOPE = 32;

/** Where a recycle's carry of a set's writes went (workingSet.ts, CarryFate): only a kept one may still land. */
export interface CarryOutcome {
  outcome(): 'carried' | 'kept' | 'landed' | 'dropped';
}

/** A working set that left the record's view before its writes landed: deposed when it was fenced; carry, the carry holding them all, if one does. */
export interface LostMark {
  stamp: number;
  carry: CarryOutcome | null;
  deposed: boolean;
}

/** A document's latest refused write: rewritten once a later whole write of it was accepted, which may carry the change. */
export interface Refusal {
  stamp: number;
  doc: string;
  rewritten: boolean;
}

interface Entry {
  ticket: Ticket;
  stamp: number;
  // The lowest seq noted on it (an absent delete is noted at the delete it found, below the key's latest write): it
  // answers for its key's writes from there to its ticket's.
  from: number;
}

interface Scope {
  entries: Map<object, Entry>;
  lost: LostMark[];
  refused: Map<string, Refusal>;
  prunedThrough: number;
}

const RUN = randomUUID();
let counter = 0;
const scopes = new Map<string, Scope>();
const scopeOfSet = new WeakMap<object, string>();

const landed = (ticket: Ticket): boolean =>
  ticket.kind === 'file' ? ticket.record.landed >= ticket.seq : ticket.set.landedSeq >= ticket.seq;
const keyOf = (ticket: Ticket): object => (ticket.kind === 'file' ? ticket.record : ticket.set);

/** A mark at the latest write noted so far: a write noted later is stamped above it. */
export function saveMark(): SaveMark {
  return { run: RUN, stamp: counter };
}

/** The stamp of a mark this run gave out, or null for anything else: another run's mark, a number, a stamp out of range. */
export function stampOf(mark: unknown): number | null {
  if (typeof mark !== 'object' || mark === null) return null;
  const { run, stamp } = mark as { run?: unknown; stamp?: unknown };
  if (run !== RUN || typeof stamp !== 'number' || !Number.isInteger(stamp) || stamp < 0 || stamp > counter) return null;
  return stamp;
}

function scopeFor(scopeId: string): Scope {
  let scope = scopes.get(scopeId);
  if (!scope) {
    scope = { entries: new Map(), lost: [], refused: new Map(), prunedThrough: 0 };
    scopes.set(scopeId, scope);
  }
  return scope;
}

function dropLanded(scope: Scope): void {
  for (const [key, entry] of scope.entries) {
    if (landed(entry.ticket)) scope.entries.delete(key);
  }
}

/**
 * Notes an accepted write. One landed already owes nothing and changes no entry. Otherwise its entry keeps the
 * highest-seq ticket on the key and takes the newest stamp: an absent delete carries the earlier delete's own ticket,
 * and its caller's mark may lie between the two. rewrites: the document a save or delete replaces whole, which may
 * carry an earlier refused change of it.
 */
export function noteScopeTicket(scopeId: string, ticket: Ticket, rewrites?: string): void {
  const stamp = ++counter;
  const scope = scopeFor(scopeId);
  const refusal = rewrites === undefined ? undefined : scope.refused.get(rewrites);
  if (refusal) refusal.rewritten = true;
  dropLanded(scope);
  if (landed(ticket)) return;
  const key = keyOf(ticket);
  const entry = scope.entries.get(key);
  if (entry) {
    if (ticket.seq > entry.ticket.seq) entry.ticket = ticket;
    entry.from = Math.min(entry.from, ticket.seq);
    entry.stamp = stamp;
  } else {
    scope.entries.set(key, { ticket, stamp, from: ticket.seq });
  }
  if (ticket.kind === 'ws') scopeOfSet.set(ticket.set, scopeId);
}

/** The first write a scope's entry answers for with this ticket: the entry's lowest, or the ticket's own without one. */
export function firstSeqOf(scopeId: string, ticket: Ticket): number {
  const entry = scopes.get(scopeId)?.entries.get(keyOf(ticket));
  return entry ? entry.from : ticket.seq;
}

/**
 * Notes a refused write (frozen, not ready, an I/O error, or a refusal thrown): the code awaiting confirmSaved may not
 * be the code that saw the save's own return.
 */
export function noteScopeRefusal(scopeId: string, doc: string): void {
  const stamp = ++counter;
  const scope = scopeFor(scopeId);
  scope.refused.set(doc, { stamp, doc, rewritten: false });
  if (scope.refused.size <= LOST_MARKS_PER_SCOPE) return;
  let oldest: Refusal | undefined;
  for (const refusal of scope.refused.values()) {
    if (!oldest || refusal.stamp < oldest.stamp) oldest = refusal;
  }
  scope.refused.delete(oldest!.doc);
  scope.prunedThrough = Math.max(scope.prunedThrough, oldest!.stamp);
}

/**
 * A working set left its manager's view (evicted, or its manager quiesced). An unlanded entry becomes a lost mark, so
 * the record holds the set no longer. carryOf names the carry a recycle took the entry's writes off in (from its
 * lowest to its latest), which a later manager may still land, or null when none holds them all.
 */
export function setLeft(set: object, carryOf: (from: number, to: number) => CarryOutcome | null = () => null): void {
  const scopeId = scopeOfSet.get(set);
  const scope = scopeId === undefined ? undefined : scopes.get(scopeId);
  const entry = scope?.entries.get(set);
  if (!scope || !entry) return;
  scope.entries.delete(set);
  if (landed(entry.ticket)) return;
  const deposed = entry.ticket.kind === 'ws' && entry.ticket.set.state === 'fenced';
  scope.lost.push({ stamp: entry.stamp, carry: carryOf(entry.from, entry.ticket.seq), deposed });
  if (scope.lost.length <= LOST_MARKS_PER_SCOPE) return;
  let oldest = 0;
  for (let i = 1; i < scope.lost.length; i += 1) {
    if (scope.lost[i].stamp < scope.lost[oldest].stamp) oldest = i;
  }
  const [dropped] = scope.lost.splice(oldest, 1);
  scope.prunedThrough = Math.max(scope.prunedThrough, dropped.stamp);
}

/**
 * What a scope still owes after since: unlanded tickets, lost marks and refusals stamped after it; pruned when a lost
 * mark or a refusal it would count was dropped.
 */
export function pendingFor(scopeId: string, since: number): { tickets: Ticket[]; lost: LostMark[]; refused: Refusal[]; pruned: boolean } {
  const scope = scopes.get(scopeId);
  if (!scope) return { tickets: [], lost: [], refused: [], pruned: false };
  dropLanded(scope);
  return {
    tickets: [...scope.entries.values()].filter(entry => entry.stamp > since).map(entry => entry.ticket),
    lost: scope.lost.filter(mark => mark.stamp > since),
    refused: [...scope.refused.values()].filter(refusal => refusal.stamp > since),
    pruned: since < scope.prunedThrough,
  };
}
