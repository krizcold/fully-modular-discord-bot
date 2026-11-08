// The scope record (BT-5): every write the data facade accepts with a ticket, and every write it refuses, kept per
// scope ('global' or a guild id) and stamped in acceptance order, so confirmSaved answers for every write made for a
// scope after a mark through the same tickets the reply gate confirms (notes/BT.md, "BT-5 design sheet: final").

import { randomUUID } from 'crypto';

import type { RowTicket } from '../sharedStore';
import { fileTicketState, type FileTicket } from './fileBackend';
import type { WsTicket } from './workingSet';

/** A point in this run's acceptance order. The run is new at every start, so a mark kept from before a restart is refused. */
export interface SaveMark {
  readonly run: string;
  readonly stamp: number;
}
type Ticket = WsTicket | FileTicket | RowTicket;

/** Lost marks, and refused documents, kept per scope; dropping the oldest raises the scope's prunedThrough. */
export const LOST_MARKS_PER_SCOPE = 32;

/** A file entry's tickets stamped after a mark, and whether a ticket of it stamped after the mark was found unconfirmed. */
export interface FilePending {
  path: string;
  tickets: FileTicket[];
  failed: boolean;
}

/** A working set that left the record's view before its writes landed: deposed when it was fenced. */
export interface LostMark {
  stamp: number;
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
  /** A file entry's tickets not landed yet, each with its own stamp (NB13 decision 8). */
  open?: Array<{ stamp: number; ticket: FileTicket }>;
  /** The highest stamp of a file ticket found 'unconfirmed': the entry then stays for the process's life. */
  failedStamp?: number;
  /** A row ticket's document, under which a refusal of its op is kept once the op settles. */
  doc?: string;
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

const landed = (ticket: Ticket): boolean => {
  if (ticket.kind === 'file') return fileTicketState(ticket) === 'landed';
  if (ticket.kind === 'row') return ticket.op.state === 'mirror' || ticket.op.state === 'landed';
  return ticket.set.landedSeq >= ticket.seq;
};
const keyOf = (ticket: Ticket): object => (ticket.kind === 'file' ? ticket.record : ticket.kind === 'row' ? ticket.op : ticket.set);

/** A mark at the latest write noted so far: a write noted later is stamped above it. */
export function saveMark(): SaveMark {
  return { run: RUN, stamp: counter };
}

/** A mark above every mark given out before it; every later mark is at or above it. */
export function markBarrier(): SaveMark {
  return { run: RUN, stamp: ++counter };
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
    const { ticket } = entry;
    if (ticket.kind === 'row' && (ticket.op.state === 'refused' || ticket.op.state === 'unconfirmed')) {
      // A settled row op leaves the entries: a refusal is kept as the document's, an op of unknown fate as a lost mark.
      scope.entries.delete(key);
      if (ticket.op.state === 'refused') keepRefusal(scope, { stamp: entry.stamp, doc: entry.doc ?? ticket.key, rewritten: false });
      else keepLost(scope, { stamp: entry.stamp, deposed: false });
      continue;
    }
    if (entry.open) {
      // A landed ticket leaves; an 'unconfirmed' one leaves and raises failedStamp.
      entry.open = entry.open.filter(kept => {
        const state = fileTicketState(kept.ticket);
        if (state === 'unconfirmed') entry.failedStamp = Math.max(entry.failedStamp ?? 0, kept.stamp);
        return state !== 'landed' && state !== 'unconfirmed';
      });
      if (entry.open.length === 0 && !entry.failedStamp) scope.entries.delete(key);
    } else if (landed(entry.ticket)) scope.entries.delete(key);
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
  // First, so a row op refused before this write keeps its refusal, which this rewrite then marks.
  dropLanded(scope);
  const refusal = rewrites === undefined ? undefined : scope.refused.get(rewrites);
  if (refusal) refusal.rewritten = true;
  if (landed(ticket)) return;
  const key = keyOf(ticket);
  const entry = scope.entries.get(key);
  if (entry) {
    if (ticket.seq > entry.ticket.seq) entry.ticket = ticket;
    entry.stamp = stamp;
    if (ticket.kind === 'file') (entry.open ??= []).push({ stamp, ticket });
  } else {
    scope.entries.set(key, {
      ticket,
      stamp,
      ...(ticket.kind === 'file' ? { open: [{ stamp, ticket }] } : {}),
      ...(ticket.kind === 'row' && rewrites !== undefined ? { doc: rewrites } : {}),
    });
  }
  if (ticket.kind === 'ws') scopeOfSet.set(ticket.set, scopeId);
}

/**
 * Notes a refused write (frozen, not ready, an I/O error, or a refusal thrown): the code awaiting confirmSaved may not
 * be the code that saw the save's own return.
 */
export function noteScopeRefusal(scopeId: string, doc: string): void {
  keepRefusal(scopeFor(scopeId), { stamp: ++counter, doc, rewritten: false });
}

/** A document's refusal, kept as its latest unless one stamped later is kept; the oldest goes past the bound. */
function keepRefusal(scope: Scope, refusal: Refusal): void {
  const kept = scope.refused.get(refusal.doc);
  if (kept && kept.stamp > refusal.stamp) return;
  scope.refused.set(refusal.doc, refusal);
  if (scope.refused.size <= LOST_MARKS_PER_SCOPE) return;
  let oldest: Refusal | undefined;
  for (const r of scope.refused.values()) {
    if (!oldest || r.stamp < oldest.stamp) oldest = r;
  }
  scope.refused.delete(oldest!.doc);
  scope.prunedThrough = Math.max(scope.prunedThrough, oldest!.stamp);
}

/** A working set left its manager's view (evicted). An unlanded entry becomes a lost mark, so the record holds the set no longer. */
export function setLeft(set: object): void {
  const scopeId = scopeOfSet.get(set);
  const scope = scopeId === undefined ? undefined : scopes.get(scopeId);
  const entry = scope?.entries.get(set);
  if (!scope || !entry) return;
  scope.entries.delete(set);
  if (landed(entry.ticket)) return;
  // A fenced set's batch that may have landed is lost as 'unavailable', not deposed (NB13 decision 6).
  const deposed = entry.ticket.kind === 'ws' && entry.ticket.set.state === 'fenced' && entry.ticket.seq > (entry.ticket.set.unknownThrough ?? 0);
  keepLost(scope, { stamp: entry.stamp, deposed });
}

/** A lost mark, kept; the oldest goes past the bound. */
function keepLost(scope: Scope, mark: LostMark): void {
  scope.lost.push(mark);
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
export function pendingFor(scopeId: string, since: number): { tickets: Ticket[]; files?: FilePending[]; lost: LostMark[]; refused: Refusal[]; pruned: boolean } {
  const scope = scopes.get(scopeId);
  if (!scope) return { tickets: [], lost: [], refused: [], pruned: false };
  dropLanded(scope);
  const files: FilePending[] = [];
  for (const entry of scope.entries.values()) {
    if (!entry.open) continue;
    const tickets = entry.open.filter(kept => kept.stamp > since).map(kept => kept.ticket);
    const failed = (entry.failedStamp ?? 0) > since;
    if (tickets.length > 0 || failed) files.push({ path: (entry.ticket as FileTicket).path, tickets, failed });
  }
  return {
    // A file entry noted after since answers through its highest kept ticket; files names each ticket after since.
    tickets: [...scope.entries.values()].flatMap(entry => {
      if (!entry.open) return entry.stamp > since ? [entry.ticket] : [];
      const after = entry.open.filter(kept => kept.stamp > since);
      return after.length > 0 ? [entry.open.reduce((a, b) => (b.ticket.seq > a.ticket.seq ? b : a)).ticket] : [];
    }),
    ...(files.length > 0 ? { files } : {}),
    lost: scope.lost.filter(mark => mark.stamp > since),
    refused: [...scope.refused.values()].filter(refusal => refusal.stamp > since),
    pruned: since < scope.prunedThrough,
  };
}
