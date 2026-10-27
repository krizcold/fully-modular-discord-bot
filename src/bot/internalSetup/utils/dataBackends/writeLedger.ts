// The write ledger (BT-2): every write the data facade accepts or refuses while
// an entry's handlers run (an interaction, a panel action, the console invoke)
// is recorded in that entry's ledger, with the module it came from. Recording
// changes no answer; BT-3 and BT-4 read the ledger to keep replies truthful.

import { AsyncLocalStorage } from 'async_hooks';
import type { Client } from 'discord.js';
import type { FileTicket } from './fileBackend';
import { saveMark, type SaveMark } from './scopeRecord';
import type { DataUnavailableCause, WsTicket } from './workingSet';

export type LedgerKind = 'interaction' | 'panel' | 'console' | 'message';
export type LedgerTicket = WsTicket | FileTicket;
/** Why a write was refused: the facade's own refusals, or the cause of a DataBackendUnavailableError. */
export type LedgerCause = 'frozen' | 'not-ready' | 'io' | DataUnavailableCause;

/** An interaction token's life; no reply can be sent after it. */
export const INTERACTION_LEDGER_LIFE_MS = 15 * 60 * 1000;

interface Entry {
  ticket: LedgerTicket;
  modules: Set<string>;
}

/** Orders refusals and whole-document rewrites across every ledger, so a reader of two ledgers can tell which came last. */
let docSeq = 0;

export class WriteLedger {
  readonly openedAt = performance.now();
  /** confirmSaved's default since inside this ledger's frame: the writes accepted after it opened. */
  readonly openedMark: SaveMark = saveMark();
  private closed = false;
  /** Keyed by the ticket's working set or landing record: a later ticket on it covers every earlier one. */
  private readonly entries = new Map<object, Entry>();
  /** The keys holding entries for one guild's sets or one path's records. */
  private readonly keysByTarget = new Map<string, Set<object>>();
  /** Per cause, the modules, and the documents whose writes were refused, each with its latest refusal's stamp. */
  private readonly refused = new Map<LedgerCause, { modules: Set<string>; docs: Map<string, number> }>();
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
    this.rewritten.clear();
  }

  /**
   * rewrites: the document this write replaces whole (a save or a delete). An earlier refusal of that document stays
   * recorded, since the rewrite may not carry the refused change, and its reader can no longer confirm it either way.
   */
  noteTicket(ticket: LedgerTicket, module: string, rewrites?: string): void {
    if (this.sealed) return;
    if (rewrites !== undefined) this.rewritten.set(rewrites, ++docSeq);
    const key = ticket.kind === 'file' ? ticket.record : ticket.set;
    const target = ticket.kind === 'file' ? `file:${ticket.path}` : `ws:${ticket.guildId}`;
    const entry = this.entries.get(key);
    if (entry) {
      if (ticket.seq > entry.ticket.seq) {
        // Every write the entry held landed: it answers from the new one.
        if (landed(entry.ticket)) this.droppedLanded = true;
        entry.ticket = ticket;
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
      if (landed(this.entries.get(other)!.ticket)) {
        this.entries.delete(other);
        keys.delete(other);
        this.droppedLanded = true;
      }
    }
    this.entries.set(key, { ticket, modules: new Set([module]) });
    keys.add(key);
  }

  noteRefusal(cause: LedgerCause, module: string, doc: string): void {
    if (this.sealed) return;
    const record = this.refused.get(cause);
    if (record) {
      record.modules.add(module);
      record.docs.set(doc, ++docSeq);
    } else {
      this.refused.set(cause, { modules: new Set([module]), docs: new Map([[doc, ++docSeq]]) });
    }
  }

  /** The tickets every recorded write is confirmed by, with the modules each covers. */
  tickets(): Array<{ ticket: LedgerTicket; modules: string[] }> {
    if (this.sealed) return [];
    return [...this.entries.values()].map(({ ticket, modules }) => ({ ticket, modules: [...modules].sort() }));
  }

  refusals(): Array<{ cause: LedgerCause; modules: string[] }> {
    if (this.sealed) return [];
    return [...this.refused].map(([cause, { modules }]) => ({ cause, modules: [...modules].sort() }));
  }

  /** Each refused document with its cause and its latest refusal's stamp. */
  refusedDocs(): Array<{ cause: LedgerCause; doc: string; seq: number }> {
    if (this.sealed) return [];
    return [...this.refused].flatMap(([cause, { docs }]) => [...docs].map(([doc, seq]) => ({ cause, doc, seq })));
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
  return ticket.kind === 'file' ? ticket.record.landed >= ticket.seq : ticket.set.landedSeq >= ticket.seq;
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

export function recordRefusal(cause: LedgerCause, doc: string): void {
  const frame = frames.getStore();
  frame?.ledger.noteRefusal(cause, frame.module ?? frame.ledger.kind, doc);
}

/**
 * Wraps the gateway Client's emit once: interactionCreate opens a ledger keyed
 * to the interaction and runs every listener inside it (the dispatcher, module
 * listeners, collectors). Every other event passes through unchanged. onOpen
 * sees each interaction and its ledger before any listener (BT-3's reply gate).
 */
export function installInteractionLedgers(client: Client, onOpen?: (interaction: object, ledger: WriteLedger) => void): void {
  const emit = client.emit;
  client.emit = function emitWithLedger(this: Client, event: string | symbol, ...args: unknown[]): boolean {
    const interaction = args[0];
    if (event !== 'interactionCreate' || typeof interaction !== 'object' || interaction === null) {
      return (emit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args);
    }
    const ledger = openLedger('interaction', interaction);
    onOpen?.(interaction, ledger);
    return runInLedger(ledger, null, () => (emit as (event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args));
  } as Client['emit'];
}
