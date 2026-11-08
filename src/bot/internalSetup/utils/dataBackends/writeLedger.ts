// The write ledger (BT-2): every write the data facade accepts or refuses while
// an entry's handlers run (an interaction, a panel action, the console invoke)
// is recorded in that entry's ledger, with the module it came from. Recording
// changes no answer; BT-3 and BT-4 read the ledger to keep replies truthful.

import { AsyncLocalStorage } from 'async_hooks';
import type { Client } from 'discord.js';
import { fileTicketState, type FileTicket } from './fileBackend';
import { saveMark, type SaveMark } from './scopeRecord';
import type { RowTicket } from '../sharedStore';
import type { DataUnavailableCause, WsTicket } from './workingSet';

export type LedgerKind = 'interaction' | 'panel' | 'console' | 'message';
export type LedgerTicket = WsTicket | FileTicket | RowTicket;
/** Why a write was refused: the facade's own refusals, or the cause of a DataBackendUnavailableError. */
export type LedgerCause = 'frozen' | 'not-ready' | 'io' | 'writer-lost' | 'unstorable' | 'changed-elsewhere' | DataUnavailableCause;

/** An interaction token's life; no reply can be sent after it. */
export const INTERACTION_LEDGER_LIFE_MS = 15 * 60 * 1000;

interface Entry {
  ticket: LedgerTicket;
  modules: Set<string>;
  /**
   * NB13 C6: the tickets the entry's ticket replaced, or that were recorded below it, while not landed. A later
   * ticket no longer covers them: a file line in a failed range, or a set's batch of unknown fate, answers apart.
   */
  earlier: LedgerTicket[];
}

/** Orders refusals and whole-document rewrites across every ledger, so a reader of two ledgers can tell which came last. */
let docSeq = 0;

export class WriteLedger {
  readonly openedAt = performance.now();
  /** confirmSaved's default since inside this ledger's frame: the writes accepted after it opened. */
  readonly openedMark: SaveMark = saveMark();
  private closed = false;
  /** Keyed by the ticket's working set or landing record; earlier tickets not landed are kept beside the latest. */
  private readonly entries = new Map<object, Entry>();
  /** The keys holding entries for one guild's sets or one path's records. */
  private readonly keysByTarget = new Map<string, Set<object>>();
  /** Per cause, the modules, and the documents whose writes were refused, each with its latest refusal's stamp. */
  private readonly refused = new Map<LedgerCause, { modules: Set<string>; docs: Map<string, number> }>();
  /** Refusals whose writer keeps the change and retries it, by cause and document. */
  private readonly retried = new Set<string>();
  /** The reason of each document's latest 'unstorable' refusal. */
  private readonly reasons = new Map<string, string>();
  /** The documents rewritten whole (a save or a delete), each with its latest rewrite's stamp. */
  private readonly rewritten = new Map<string, number>();
  /** Compaction dropped an entry whose write had landed, so the ledger no longer lists that confirmed write. */
  private droppedLanded = false;

  constructor(readonly kind: LedgerKind, private readonly lifeMs: number | null) {}

  /** Sealed once its entry can no longer answer (checked here, so no timer is armed per ledger). */
  get sealed(): boolean {
    if (!this.closed && this.lifeMs !== null && performance.now() - this.openedAt >= this.lifeMs) this.seal();
    return this.closed;
  }

  seal(): void {
    this.closed = true;
    this.entries.clear();
    this.keysByTarget.clear();
    this.refused.clear();
    this.retried.clear();
    this.reasons.clear();
    this.rewritten.clear();
  }

  /**
   * rewrites: the document this write replaces whole (a save or a delete). An earlier refusal of that document stays
   * recorded, since the rewrite may not carry the refused change, and its reader can no longer confirm it either way.
   */
  noteTicket(ticket: LedgerTicket, module: string, rewrites?: string): void {
    if (this.sealed) return;
    if (rewrites !== undefined) this.rewritten.set(rewrites, ++docSeq);
    const key = ledgerKeyOf(ticket);
    const target = ticket.kind === 'file' ? `file:${ticket.path}` : ticket.kind === 'row' ? `row:${ticket.key}` : `ws:${ticket.guildId}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.earlier = entry.earlier.filter(earlier => !landed(earlier));
      if (ticket.seq > entry.ticket.seq) {
        // A row op's writes all settle together, so a later write of the same op stands for the earlier one.
        if (landed(entry.ticket)) this.droppedLanded = true;
        else if (ticket.kind !== 'row') entry.earlier.push(entry.ticket);
        entry.ticket = ticket;
      } else if (ticket.kind !== 'row' && ticket.seq < entry.ticket.seq && !landed(ticket) && !entry.earlier.some(earlier => earlier.seq === ticket.seq)) {
        // D8: a lower ticket recorded late (a redelivery's queued line) is not covered by the higher one.
        entry.earlier.push(ticket);
      }
      entry.modules.add(module);
      return;
    }
    // A landed ticket stays confirmed, so its entry gives way when its guild or path is written again.
    let keys = this.keysByTarget.get(target);
    if (!keys) {
      keys = new Set();
      this.keysByTarget.set(target, keys);
    }
    for (const other of keys) {
      const held = this.entries.get(other)!;
      // D1: an entry gives way only once its ticket and every earlier one landed.
      if (landed(held.ticket) && held.earlier.every(landed)) {
        this.entries.delete(other);
        keys.delete(other);
        this.droppedLanded = true;
      }
    }
    this.entries.set(key, { ticket, modules: new Set([module]), earlier: [] });
    keys.add(key);
  }

  noteRefusal(cause: LedgerCause, module: string, doc: string, reason?: string): void {
    if (this.sealed) return;
    if (cause === 'unstorable' && reason !== undefined) this.reasons.set(doc, reason);
    const record = this.refused.get(cause);
    if (record) {
      record.modules.add(module);
      record.docs.set(doc, ++docSeq);
    } else {
      this.refused.set(cause, { modules: new Set([module]), docs: new Map([[doc, ++docSeq]]) });
    }
  }

  /**
   * The tickets every recorded write is confirmed by, with the modules each covers: each entry's ticket, then its
   * earlier tickets not landed now, in the order they were replaced.
   */
  tickets(): Array<{ ticket: LedgerTicket; modules: string[] }> {
    if (this.sealed) return [];
    return [...this.entries.values()].flatMap(({ ticket, modules, earlier }) => {
      const sorted = [...modules].sort();
      return [ticket, ...earlier.filter(t => !landed(t))].map(t => ({ ticket: t, modules: sorted }));
    });
  }

  refusals(): Array<{ cause: LedgerCause; modules: string[] }> {
    if (this.sealed) return [];
    return [...this.refused].map(([cause, { modules }]) => ({ cause, modules: [...modules].sort() }));
  }

  /** Marks every refusal of this document as one its writer keeps and retries (never one of the stop, a deposition, content no store takes or another machine's change). */
  noteRetried(doc: string): void {
    if (this.sealed) return;
    for (const [cause, { docs }] of this.refused) {
      if (docs.has(doc) && cause !== 'node-stopping' && cause !== 'writer-lost' && cause !== 'unstorable' && cause !== 'changed-elsewhere') this.retried.add(`${cause}|${doc}`);
    }
  }

  /** Each refused document with its cause, its latest refusal's stamp, whether its writer retries it and, for 'unstorable', its reason. */
  refusedDocs(): Array<{ cause: LedgerCause; doc: string; seq: number; retried: boolean; reason?: string }> {
    if (this.sealed) return [];
    return [...this.refused].flatMap(([cause, { docs }]) => [...docs].map(([doc, seq]) => {
      const retried = this.retried.has(`${cause}|${doc}`);
      return cause === 'unstorable' && this.reasons.has(doc) ? { cause, doc, seq, retried, reason: this.reasons.get(doc)! } : { cause, doc, seq, retried };
    }));
  }

  /** The stamp of this document's latest whole rewrite in this ledger, or 0. */
  rewriteSeq(doc: string): number {
    if (this.sealed) return 0;
    return this.rewritten.get(doc) ?? 0;
  }

  /** True once compaction dropped an entry whose write had landed: some write of this ledger is confirmed saved. */
  get landedDropped(): boolean {
    return !this.sealed && this.droppedLanded;
  }
}

export function landed(ticket: LedgerTicket): boolean {
  if (ticket.kind === 'file') return fileTicketState(ticket) === 'landed';
  // A row op is stored once it reaches 'mirror' (its mirror write may still be pending), as rowTicketState answers.
  if (ticket.kind === 'row') return ticket.op.state === 'mirror' || ticket.op.state === 'landed';
  return ticket.set.landedSeq >= ticket.seq;
}

/** The object a ticket's entry is kept under: a file's landing record, a guild's working set, or a row op. */
export function ledgerKeyOf(ticket: LedgerTicket): object {
  return ticket.kind === 'file' ? ticket.record : ticket.kind === 'row' ? ticket.op : ticket.set;
}

/** An op's own writes, which its reply carries to the web UI's local chain (never over IPC). */
export interface OpWrites {
  tickets: LedgerTicket[];
  /** A write was refused and no later whole rewrite of its document followed. */
  refused: boolean;
  /** A refused write was rewritten whole later, or its writer retries it: whether it is saved cannot be known. */
  unknowable: boolean;
  /** Compaction dropped an entry whose write had landed. */
  landedBefore: boolean;
}

export const NO_WRITES: OpWrites = Object.freeze({ tickets: [], refused: false, unknowable: false, landedBefore: false }) as OpWrites;

const OP_WRITES = Symbol('opWrites');

/** The ledger's writes now; read before it seals. */
export function writesOf(ledger: WriteLedger): OpWrites {
  const refusals = ledger.refusedDocs();
  const open = (r: { doc: string; seq: number; retried: boolean }) => r.retried || ledger.rewriteSeq(r.doc) > r.seq;
  return {
    tickets: ledger.tickets().map(entry => entry.ticket),
    refused: refusals.some(r => !open(r)),
    unknowable: refusals.some(open),
    landedBefore: ledger.landedDropped,
  };
}

/** Puts the op's writes on its reply under a non-enumerable symbol key, which no IPC serialization carries. */
export function carryWrites<T>(reply: T, writes: OpWrites | undefined): T {
  if (writes && reply && typeof reply === 'object') Object.defineProperty(reply, OP_WRITES, { value: writes, enumerable: false, configurable: true });
  return reply;
}

export function carriedWrites(reply: unknown): OpWrites | undefined {
  return reply && typeof reply === 'object' ? (reply as Record<symbol, OpWrites | undefined>)[OP_WRITES] : undefined;
}

interface Frame {
  ledger: WriteLedger;
  module: string | null;
  /** confirmSaved's default since for a handler the dispatch gate held: its admission (R1-J2). */
  since?: SaveMark;
}

const frames = new AsyncLocalStorage<Frame>();
const byEntry = new WeakMap<object, WriteLedger>();

// A timer armed in a handler keeps its interaction's ledger reachable for as long as it waits, so expired ledgers are
// sealed here, oldest first (each has the same life), whether or not anything reads them again. The queue holds them
// weakly, so it keeps none alive itself: a ledger is collected once nothing reaches it, neither its entry nor any
// async work started in its frame (the facade's own flush and retries included).
const SWEEP_MS = 60 * 1000;
const openInteractions: WeakRef<WriteLedger>[] = [];
let sweepTimer: NodeJS.Timeout | null = null;

function sealExpired(): void {
  while (openInteractions.length > 0) {
    const head = openInteractions[0].deref();
    if (head && !head.sealed) break;
    openInteractions.shift();
  }
  if (openInteractions.length === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** A new ledger; with an entry object (an interaction), ledgerOf finds it from any context. */
export function openLedger(kind: LedgerKind, entry?: object): WriteLedger {
  const ledger = new WriteLedger(kind, kind === 'interaction' ? INTERACTION_LEDGER_LIFE_MS : null);
  if (entry) byEntry.set(entry, ledger);
  if (kind === 'interaction') {
    sealExpired();
    openInteractions.push(new WeakRef(ledger));
    if (!sweepTimer) {
      sweepTimer = setInterval(sealExpired, SWEEP_MS);
      sweepTimer.unref();
    }
  }
  return ledger;
}

export function runInLedger<T>(ledger: WriteLedger, module: string | null, fn: () => T): T {
  return frames.run({ ledger, module }, fn);
}

/** A panel action's or the console invoke's run: its ledger records while fn runs and seals when it returns or throws. */
export async function runSealed<T>(kind: LedgerKind, entry: object | null, module: string | null, fn: (ledger: WriteLedger) => Promise<T>): Promise<T> {
  const ledger = openLedger(kind, entry ?? undefined);
  try {
    return await runInLedger(ledger, module, () => fn(ledger));
  } finally {
    ledger.seal();
  }
}

export function ledgerOf(entry: object): WriteLedger | undefined {
  return byEntry.get(entry);
}

export function currentLedger(): WriteLedger | undefined {
  return frames.getStore()?.ledger;
}

/** Runs fn as a handler the dispatch gate admitted at mark: its confirmSaved counts the writes after it. */
export function runAdmitted<T>(mark: SaveMark, fn: () => T): T {
  const frame = frames.getStore();
  return frame ? frames.run({ ...frame, since: mark }, fn) : fn();
}

/** confirmSaved's default since here: the gate's admission of this handler, else its ledger's opening. */
export function currentSince(): SaveMark | undefined {
  const frame = frames.getStore();
  return frame ? frame.since ?? frame.ledger.openedMark : undefined;
}

/** The module a write made here would be recorded under. */
export function currentModule(): string | undefined {
  const frame = frames.getStore();
  return frame ? frame.module ?? frame.ledger.kind : undefined;
}

/** Runs fn with its writes tagged with this module, inside the ledger in scope; with none, just runs fn. */
export function withModule<T>(module: string | null | undefined, fn: () => T): T {
  const frame = frames.getStore();
  return frame ? frames.run({ ...frame, module: module ?? frame.module }, fn) : fn();
}

export function recordTicket(ticket: LedgerTicket, rewrites?: string): void {
  const frame = frames.getStore();
  frame?.ledger.noteTicket(ticket, frame.module ?? frame.ledger.kind, rewrites);
}

export function recordRefusal(cause: LedgerCause, doc: string, reason?: string): void {
  const frame = frames.getStore();
  frame?.ledger.noteRefusal(cause, frame.module ?? frame.ledger.kind, doc, reason);
}

/** The refusal of this document in the current ledger is kept by its writer and retried: it answers held. */
export function markRetried(doc: string): void {
  frames.getStore()?.ledger.noteRetried(doc);
}

/** Runs fn outside every ledger frame, so no caller's ledger records what it writes. */
export function outsideLedgers<T>(fn: () => T): T {
  return frames.exit(fn);
}

const paymentOps = new WeakMap<WriteLedger, string>();

/** Names the payment op (payment.webhook, payment.oauthCallback) this ledger runs. */
export function markPaymentLedger(ledger: WriteLedger, op: string): void {
  paymentOps.set(ledger, op);
}

export function paymentOpOf(ledger: WriteLedger | undefined): string | undefined {
  return ledger ? paymentOps.get(ledger) : undefined;
}

export function isPaymentLedger(ledger: WriteLedger | undefined): boolean {
  return paymentOpOf(ledger) !== undefined;
}

/** NB9 43: the interaction hook, read at each interaction, so it can be set after the wrap. */
export interface InteractionHookHolder {
  onOpen?: (interaction: object, ledger: WriteLedger) => void;
}

/**
 * Wraps the gateway Client's emit once: interactionCreate opens a ledger keyed
 * to the interaction and runs every listener inside it (the dispatcher, module
 * listeners, collectors). Every other event passes through unchanged. The
 * holder's onOpen sees each interaction and its ledger before any listener
 * (BT-3's reply gate).
 */
export function installInteractionLedgers(client: Client, holder: InteractionHookHolder = {}): void {
  const emit = client.emit;
  client.emit = function emitWithLedger(this: Client, event: string | symbol, ...args: unknown[]): boolean {
    const interaction = args[0];
    if (event !== 'interactionCreate' || typeof interaction !== 'object' || interaction === null) {
      return (emit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args);
    }
    const ledger = openLedger('interaction', interaction);
    holder.onOpen?.(interaction, ledger);
    return runInLedger(ledger, null, () => (emit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args));
  } as Client['emit'];
}
