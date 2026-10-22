// The interaction reply gate (BT-3): on a real interaction, a response method sends the module's payload only once
// every write in the union of its ledgers has landed and none was refused; otherwise a truthful text goes in its
// place. A response called before ACK_MS from the emit is acknowledged by then; one called later, at once. A module
// that declares dataContract 2 (BT-5) is judged on refusals only: its payload goes out at once, unless a write was
// refused, and the gate defers nothing for it.

import { ContainerBuilder, InteractionResponseType, MessageFlags, MessageFlagsBitField, TextDisplayBuilder, type Client } from 'discord.js';
import { getConfigProperty } from '../configManager';
import { confirmFrom } from '../dataManager';
import { parseButtonCustomId, parseDropdownCustomId, parseModalCustomId } from '../panel/panelCustomIds';
import { declaresOwnOutcomes } from './dataContract';
import { currentLedger, currentModule, installInteractionLedgers, landed, ledgerOf, type LedgerCause, type LedgerTicket, type WriteLedger } from './writeLedger';

/** From the interaction's emit to the gate's own defer. Discord's 3 s also pays the gateway's delivery and the callback. */
export const ACK_MS = 2000;
/** The longest a gated response waits on its writes (BT-1's bound). */
export const CONFIRM_MS = 8000;

export type TruthAnswer = 'pending' | 'held' | 'deposed' | 'unavailable' | LedgerCause;

// Worst first.
const RANK: TruthAnswer[] = [
  'node-stopping', 'database-read-only', 'guild-fenced', 'deposed', 'database-unreachable', 'database-backlog',
  'frozen', 'not-ready', 'io', 'unavailable', 'held', 'pending',
];
const worst = (answers: TruthAnswer[]): TruthAnswer => answers.reduce((a, b) => (RANK.indexOf(b) < RANK.indexOf(a) ? b : a));

/** partial: another write in the same response's ledgers was accepted, so "not saved in full". */
export function truthText(answer: TruthAnswer, partial: boolean): string {
  const notSaved = partial ? 'not saved in full' : 'not saved';
  const inFull = partial ? ' in full' : '';
  switch (answer) {
    case 'node-stopping':
      return `The bot is restarting, so your change was ${notSaved}. Please try again in a moment.`;
    case 'database-read-only':
      return `The bot's database is read-only while a backup covers an outage, so your change was ${notSaved}. Please try again in a few minutes.`;
    case 'guild-fenced':
    case 'deposed':
      return `This server's data just moved to another bot node, so your change was ${notSaved}. Please try again in a moment.`;
    case 'database-unreachable': {
      if (partial) return "The bot's database is unreachable, so your change was not saved in full. Please try again later.";
      const notice = getConfigProperty<string>('outageNotice.databaseUnreachable');
      return typeof notice === 'string' && notice.trim() !== ''
        ? notice
        : "The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support.";
    }
    case 'database-backlog':
      return `The bot's database is behind on saving changes, so your change was ${notSaved}. Please try again in a moment.`;
    case 'frozen':
      return `This server's data is being moved, so your change was ${notSaved}. Please try again in a moment.`;
    case 'not-ready':
      return `This server's data is still loading, so your change was ${notSaved}. Please try again in a moment.`;
    case 'io':
      return `The bot could not write to storage, so your change was ${notSaved}. Please try again.`;
    case 'unavailable':
      return `The bot cannot confirm whether your change was saved${inFull}. Please check before you try again.`;
    case 'held':
      return `Your change is ${notSaved} yet: storage refused it for now, and the bot keeps retrying. Please check again in a few minutes.`;
    case 'pending':
      return `Your change is not confirmed as saved${inFull} yet. Please check again in a moment.`;
  }
}

type Failure = { refusal: string } | { key: object; seq: number };
type Verdict = { ok: true } | { ok: false; answer: TruthAnswer; partial: boolean; failed: Failure[] };

/** A refused document, by its refusal's stamp; rewritten: a whole rewrite of it was recorded later in the union. */
interface Refused {
  cause: LedgerCause;
  doc: string;
  seq: number;
  rewritten: boolean;
}

interface Pending {
  tickets: LedgerTicket[];
  unlanded: LedgerTicket[];
  /** The lowest seq each ticket answers for: its ledger entry's, a lower write of its set or an absent delete. */
  from: Map<LedgerTicket, number>;
  refused: Refused[];
  /** A confirmed write is no longer listed: its entry gave way to a later write of the same guild or path. */
  landedBefore: boolean;
}

const keyOf = (ticket: LedgerTicket): object => (ticket.kind === 'file' ? ticket.record : ticket.set);

function pendingIn(ledgers: WriteLedger[]): Pending {
  const entries = ledgers.flatMap(ledger => ledger.tickets());
  const tickets = entries.map(entry => entry.ticket);
  const from = new Map<LedgerTicket, number>();
  for (const entry of entries) from.set(entry.ticket, Math.min(entry.from, from.get(entry.ticket) ?? entry.from));
  const refused = ledgers.flatMap(ledger => ledger.refusedDocs()).map(({ cause, doc, seq }) => ({
    cause, doc, seq, rewritten: ledgers.some(ledger => ledger.rewriteSeq(doc) > seq),
  }));
  return { tickets, unlanded: tickets.filter(ticket => !landed(ticket)), from, refused, landedBefore: ledgers.some(ledger => ledger.landedDropped) };
}

// A refused write later rewritten whole cannot be confirmed either way: the rewrite may or may not carry the refused
// change. It answers unavailable. The told-once key names the answer and the refusal's stamp, so a refusal told before
// the rewrite is told again, a newer refusal is told, and a further rewrite tells nothing new.
const refusalAnswer = (r: Refused): TruthAnswer => (r.rewritten ? 'unavailable' : r.cause);
const refusalKey = (r: Refused): string => `${refusalAnswer(r)}|${r.doc}|${r.seq}`;

async function judge(pending: Pending, waitMs = CONFIRM_MS): Promise<Verdict> {
  if (pending.refused.length > 0) {
    return {
      ok: false,
      answer: worst(pending.refused.map(refusalAnswer)),
      partial: pending.tickets.length > 0,
      failed: pending.refused.map(r => ({ refusal: refusalKey(r) })),
    };
  }
  const fromOf = (ticket: LedgerTicket): number => pending.from.get(ticket) ?? ticket.seq;
  const first = await Promise.all(pending.unlanded.map(ticket => confirmFrom(ticket, waitMs, fromOf(ticket)).catch(() => 'unavailable' as const)));
  // A held write is retried while slower confirms finish, so it is read again when the verdict is taken.
  const answers = await Promise.all(first.map((answer, i) => answer !== 'held'
    ? answer
    : confirmFrom(pending.unlanded[i], 0, fromOf(pending.unlanded[i])).then(now => (now === 'pending' ? 'held' as const : now), () => 'unavailable' as const)));
  const failed = pending.unlanded.filter((_, i) => answers[i] !== 'ok');
  if (failed.length === 0) return { ok: true };
  const partial = answers.some(answer => answer === 'ok') || pending.tickets.length > pending.unlanded.length || pending.landedBefore;
  return {
    ok: false,
    answer: worst(answers.filter((answer): answer is Exclude<typeof answer, 'ok'> => answer !== 'ok')),
    partial,
    failed: failed.map(ticket => ({ key: keyOf(ticket), seq: ticket.seq })),
  };
}

/** A synthetic entry's verdict (BT-4): ok only when every write in its ledgers landed and none was refused. */
export type WritesVerdict = { ok: true } | { ok: false; answer: TruthAnswer; partial: boolean };

/**
 * The verdict over these ledgers within CONFIRM_MS. After each ok judgement they are read again, so a write recorded
 * while it waited is judged too, with the time left: a refusal at once, an unconfirmed write as pending.
 */
export async function verdictOf(ledgers: WriteLedger[]): Promise<WritesVerdict> {
  const deadline = performance.now() + CONFIRM_MS;
  const confirmed = new Map<object, number>();
  for (;;) {
    const read = pendingIn(ledgers);
    const pending = {
      ...read,
      unlanded: read.unlanded.filter(ticket => (confirmed.get(keyOf(ticket)) ?? -1) < ticket.seq),
      landedBefore: read.landedBefore || confirmed.size > 0,
    };
    if (pending.refused.length === 0 && pending.unlanded.length === 0) return { ok: true };
    const verdict = await judge(pending, Math.max(0, deadline - performance.now()));
    if (!verdict.ok) return { ok: false, answer: verdict.answer, partial: verdict.partial };
    for (const ticket of pending.unlanded) confirmed.set(keyOf(ticket), ticket.seq);
  }
}

/** The union a module's last payload was judged on, and the module that sent it, for the sweep. */
interface Mark {
  module: string;
  ledgers: WriteLedger[];
  seqs: Map<object, number>;
  stamps: Map<string, number>;
}

function markOf(pending: Pending, ledgers: WriteLedger[], module: string): Mark {
  const seqs = new Map<object, number>();
  for (const ticket of pending.tickets) seqs.set(keyOf(ticket), Math.max(ticket.seq, seqs.get(keyOf(ticket)) ?? -1));
  const stamps = new Map<string, number>();
  for (const r of pending.refused) stamps.set(r.doc, Math.max(r.seq, stamps.get(r.doc) ?? 0));
  return { module, ledgers, seqs, stamps };
}

/** A write recorded since the mark: a new key, a higher seq, or a refusal with a higher stamp. */
function wroteSince(mark: Mark): boolean {
  return mark.ledgers.some(ledger =>
    ledger.tickets().some(({ ticket }) => ticket.seq > (mark.seqs.get(keyOf(ticket)) ?? -1))
    || ledger.refusedDocs().some(({ doc, seq }) => seq > (mark.stamps.get(doc) ?? 0)));
}

/** The key a component or modal was dispatched by, as the internal handlers match it; never its custom id, which carries ids. */
function handlerKey(handlers: unknown, customId: string): string {
  if (!(handlers instanceof Map)) return 'unregistered';
  if (handlers.has(customId)) return customId;
  for (const key of handlers.keys()) {
    if (customId.startsWith(key) && (customId.length === key.length || customId.charAt(key.length) === '_')) return key;
  }
  return 'unregistered';
}

const PANEL_IDS = { button: parseButtonCustomId, dropdown: parseDropdownCustomId, modal: parseModalCustomId };

/** Core's panel dispatcher holds every panel's components under one key, so a panel's site is its panel id instead. */
function componentSite(kind: keyof typeof PANEL_IDS, handlers: unknown, customId: string): { kind: string; name: string } {
  const key = handlerKey(handlers, customId);
  return { kind, name: (key === 'panel' && PANEL_IDS[kind](customId)?.panelId) || key };
}

function siteOf(interaction: Record<string, any>): { kind: string; name: string } {
  if (typeof interaction.commandName === 'string') return { kind: 'command', name: interaction.commandName };
  const client = interaction.client ?? {};
  if (interaction.isButton?.()) return componentSite('button', client.buttonHandlers, interaction.customId);
  if (interaction.isAnySelectMenu?.()) return componentSite('dropdown', client.dropdownHandlers, interaction.customId);
  if (interaction.isModalSubmit?.()) return componentSite('modal', client.modalHandlers, interaction.customId);
  return { kind: 'interaction', name: 'unknown' };
}

const reported = new Set<string>();

/** The verdict by the deadline, or undefined once it passes. A verdict already in (a refusal) wins even past it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    void promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function flagsOf(value: unknown): MessageFlagsBitField {
  try {
    return new MessageFlagsBitField((value ?? 0) as never);
  } catch {
    return new MessageFlagsBitField(0);
  }
}

type Options = Record<string, unknown> & { flags?: unknown; ephemeral?: boolean; fetchReply?: boolean; withResponse?: boolean };

function optionsOf(payload: unknown): Options {
  if (typeof payload === 'string') return { content: payload };
  if (payload && typeof payload === 'object') {
    const inner = (payload as { options?: unknown }).options;
    return ((payload as { constructor?: { name?: string } }).constructor?.name === 'MessagePayload' && inner ? inner : payload) as Options;
  }
  return {};
}

/** The gate's deferral's callback response, given the message the caller's call showed, which withResponse reads. */
function withMessage(ack: unknown, name: 'reply' | 'update', message: unknown): unknown {
  if (!ack || typeof ack !== 'object') return ack;
  const response = ack as { resource: Record<string, unknown> | null };
  if (response.resource) response.resource.message = message;
  else {
    const type = name === 'reply' ? InteractionResponseType.DeferredChannelMessageWithSource : InteractionResponseType.DeferredMessageUpdate;
    response.resource = { type, activityInstance: null, message };
  }
  return ack;
}

/** A reply's payload as an edit of the gate's own deferred reply: the reply-only options and Ephemeral come off. */
function asEdit(payload: unknown): unknown {
  if (typeof payload === 'string') return payload;
  const { ephemeral: _ephemeral, fetchReply: _fetchReply, withResponse: _withResponse, ...rest } = optionsOf(payload);
  if (rest.flags !== undefined) rest.flags = flagsOf(rest.flags).remove(MessageFlags.Ephemeral).bitfield;
  return rest;
}

type Method = (...args: unknown[]) => Promise<unknown>;
const SETS: Record<string, 'deferred' | 'replied' | null> = {
  reply: 'replied', update: 'replied', showModal: 'replied', editReply: 'replied', followUp: 'replied',
  deferReply: 'deferred', deferUpdate: 'deferred', deleteReply: null,
};
const GATED = new Set(['reply', 'update', 'editReply', 'followUp']);

/** Installs the gate on one interaction, before any listener sees it. */
export function installReplyGate(interaction: object, ledger: WriteLedger): void {
  const target = interaction as Record<string, unknown> & { message?: { flags?: unknown } | null };
  if (typeof target.reply !== 'function') return;
  const original: Record<string, Method> = {};
  for (const name of Object.keys(SETS)) {
    if (typeof target[name] === 'function') original[name] = target[name] as Method;
  }

  // discord.js sets these only after its REST call returns. While the gate holds a call, they answer as if it had
  // gone out; the gate's own sends see the real values, so discord.js's guards behave as without the gate.
  const real = { deferred: Boolean(target.deferred), replied: Boolean(target.replied) };
  const intent = { deferred: 0, replied: 0 };
  let hidden = 0;
  for (const flag of ['deferred', 'replied'] as const) {
    Object.defineProperty(target, flag, {
      configurable: true,
      enumerable: true,
      get: () => real[flag] || (hidden === 0 && intent[flag] > 0),
      set: (value: boolean) => {
        real[flag] = value;
      },
    });
  }

  const told = { refusals: new Set<string>(), tickets: new Map<object, number>() };
  const isNew = (failure: Failure) =>
    'refusal' in failure ? !told.refusals.has(failure.refusal) : (told.tickets.get(failure.key) ?? -1) < failure.seq;
  const markTold = (failure: Failure) => {
    if ('refusal' in failure) told.refusals.add(failure.refusal);
    else told.tickets.set(failure.key, Math.max(failure.seq, told.tickets.get(failure.key) ?? -1));
  };
  let originalIsV2 = flagsOf(target.message?.flags).has(MessageFlags.IsComponentsV2);

  const send = async (name: string, args: unknown[]): Promise<unknown> => {
    let call: Promise<unknown>;
    hidden += 1;
    try {
      call = original[name].apply(target, args);
    } finally {
      hidden -= 1;
    }
    const result = await call;
    const isV2 = flagsOf(optionsOf(args[0]).flags).has(MessageFlags.IsComponentsV2);
    // A reply or a deferral makes a new original message; an update or an edit can only turn the current one V2.
    if (name === 'reply' || name === 'deferReply') originalIsV2 = name === 'reply' && isV2;
    else if ((name === 'update' || name === 'editReply') && isV2) originalIsV2 = true;
    return result;
  };

  const truthPayload = (name: string, text: string, payload: unknown) => {
    const allowedMentions = { parse: [] };
    // The caller of reply or update gets the result type it asked for.
    const { fetchReply, withResponse } = name === 'reply' || name === 'update' ? optionsOf(payload) : {};
    const asked = { ...(fetchReply !== undefined && { fetchReply }), ...(withResponse !== undefined && { withResponse }) };
    if (name === 'reply' || name === 'followUp') {
      return { content: text, flags: MessageFlags.Ephemeral, embeds: [], components: [], files: [], allowedMentions, ...asked };
    }
    // An edit of the acknowledged message keeps its ephemerality, and a V2 message stays V2.
    if (originalIsV2 || flagsOf(optionsOf(payload).flags).has(MessageFlags.IsComponentsV2)) {
      const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
      return { components: [container], flags: MessageFlags.IsComponentsV2, attachments: [], allowedMentions, ...asked };
    }
    return { content: text, embeds: [], components: [], attachments: [], allowedMentions, ...asked };
  };

  const tell = async (name: string, verdict: Extract<Verdict, { ok: false }>, payload: unknown): Promise<unknown> => {
    if (!verdict.failed.some(isNew)) {
      // Told already: a later edit leaves the message as it stands, and a later followUp is dropped.
      if (name === 'editReply') return (target.fetchReply as Method).call(target);
      if (name === 'followUp') return undefined;
    }
    const result = await send(name, [truthPayload(name, truthText(verdict.answer, verdict.partial), payload)]);
    verdict.failed.forEach(markTold);
    return result;
  };

  // The sweep's mark: taken once a module's payload went out, never for the truth, a deferral or an acknowledgement;
  // a flagged module's payload (BT-5) takes none and clears the last one.
  let mark: Mark | null = null;

  const gated = async (name: string, args: unknown[], frameLedger: WriteLedger | undefined, sender: string): Promise<unknown> => {
    const ledgers = frameLedger && frameLedger !== ledger ? [frameLedger, ledger] : [ledger];
    // A module that handles its own outcomes (BT-5) is judged on refusals only, and its payload is never the sweep's.
    const ownOutcomes = declaresOwnOutcomes(sender);
    const read = pendingIn(ledgers);
    const pending = ownOutcomes ? { ...read, unlanded: [] } : read;
    const payload = async (call: string, callArgs: unknown[]): Promise<unknown> => {
      const result = await send(call, callArgs);
      mark = ownOutcomes ? null : markOf(pending, ledgers, sender);
      return result;
    };
    if (pending.refused.length === 0 && pending.unlanded.length === 0) return payload(name, args);
    const verdicts = judge(pending);
    const initial = name === 'reply' || name === 'update';
    if (initial && !real.deferred && !real.replied) {
      const early = await within(verdicts, ledger.openedAt + ACK_MS - performance.now());
      if (early === undefined) {
        const options = optionsOf(args[0]);
        const ephemeral = options.ephemeral === true || flagsOf(options.flags).has(MessageFlags.Ephemeral);
        const ack = name === 'reply'
          ? await send('deferReply', [{ flags: ephemeral ? MessageFlags.Ephemeral : undefined, withResponse: options.withResponse }])
          : await send('deferUpdate', [{ withResponse: options.withResponse }]);
        const verdict = await verdicts;
        const edited = verdict.ok ? await payload('editReply', [asEdit(args[0])]) : await tell('editReply', verdict, args[0]);
        // As discord.js does, withResponse wins over fetchReply.
        if (options.withResponse) return withMessage(ack, name === 'reply' ? 'reply' : 'update', edited);
        return options.fetchReply ? edited : ack;
      }
      return early.ok ? payload(name, args) : tell(name, early, args[0]);
    }
    const verdict = await verdicts;
    return verdict.ok ? payload(name, args) : tell(name, verdict, args[0]);
  };

  // A core sender whose result is a Discord message, not a response: true when every write is confirmed; otherwise
  // false. With tellMember, once it has a write to wait on it always answers the interaction: acknowledged before true,
  // or told the truth before false. Without tellMember it never acknowledges, so the caller's own response stays
  // possible; it then answers false once the ack deadline passes unconfirmed.
  const answer = async (frameLedger: WriteLedger | undefined, tellMember: boolean, caller: string | undefined): Promise<boolean> => {
    const ledgers = frameLedger && frameLedger !== ledger ? [frameLedger, ledger] : [ledger];
    const pending = pendingIn(ledgers);
    // The caller's visible result goes out next, outside the gate, so a true marks as a payload does.
    const confirmed = (): true => {
      mark = markOf(pending, ledgers, caller ?? ledger.kind);
      return true;
    };
    if (pending.refused.length === 0 && pending.unlanded.length === 0) return confirmed();
    const verdicts = judge(pending);
    const remaining = ledger.openedAt + ACK_MS - performance.now();
    if (!tellMember) return (await within(verdicts, remaining))?.ok === true && confirmed();
    // Its own acknowledgements read as made from the moment they are due, as a held call's do, so a reader of the
    // flags (the panel's auto-defer) sends no second one while they are on the wire.
    const raised: Array<'deferred' | 'replied'> = [];
    const due = (flag: 'deferred' | 'replied') => {
      if (real.deferred || real.replied || raised.includes(flag)) return;
      intent[flag] += 1;
      raised.push(flag);
    };
    // Only an interaction on a component's message takes an update; a command, or a modal submitted from one, does not.
    const onMessage = Boolean(original.deferUpdate) && Boolean(target.message);
    const acknowledge = () => (onMessage ? send('deferUpdate', []) : send('deferReply', [{ flags: MessageFlags.Ephemeral }]));
    try {
      due('deferred');
      let verdict = await within(verdicts, remaining);
      if (verdict === undefined) {
        if (!real.deferred && !real.replied) await acknowledge();
        verdict = await verdicts;
      }
      if (verdict.ok) {
        // The caller acts on a message before its own first response; after this wait, the acknowledgement goes first.
        if (!real.deferred && !real.replied) await acknowledge();
        return confirmed();
      }
      due('replied');
      await tell(real.deferred || real.replied ? 'followUp' : 'reply', verdict, undefined);
      return false;
    } finally {
      for (const flag of raised) intent[flag] -= 1;
    }
  };

  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(flag: 'deferred' | 'replied' | null, work: () => Promise<T>): Promise<T> => {
    if (flag) intent[flag] += 1;
    const settled = queue.then(work).finally(() => {
      if (flag) intent[flag] -= 1;
    });
    queue = settled.catch(() => undefined);
    return settled;
  };
  for (const name of Object.keys(original)) {
    target[name] = (...args: unknown[]): Promise<unknown> => {
      const frameLedger = currentLedger();
      const sender = currentModule() ?? ledger.kind;
      return enqueue(SETS[name], () => (GATED.has(name) ? gated(name, args, frameLedger, sender) : send(name, args)));
    };
  }
  // Logs once per site, never to the member; the mark is cleared so it keeps no working set alive.
  const sweep = async (): Promise<void> => {
    const last = mark;
    mark = null;
    if (!last || !wroteSince(last)) return;
    const { kind, name } = siteOf(target);
    const site = `${last.module}|${kind}|${name}`;
    if (reported.has(site)) return;
    reported.add(site);
    console.warn(`[Truth] ${last.module} sent a reply that did not wait on a write (${kind} ${name})`);
  };
  gates.set(interaction, {
    answer: (frameLedger, tellMember, caller) => enqueue(null, () => answer(frameLedger, tellMember, caller)),
    sweep: () => enqueue(null, sweep),
  });
}

interface Gate {
  answer(frameLedger: WriteLedger | undefined, tellMember: boolean, caller: string | undefined): Promise<boolean>;
  sweep(): Promise<void>;
}

const gates = new WeakMap<object, Gate>();

/** An interaction no gate holds (never emitted): the frame's and its own ledger, judged without sending anything. */
async function judgedOk(interaction: object | null | undefined): Promise<boolean> {
  const frameLedger = currentLedger();
  const own = interaction ? ledgerOf(interaction) : undefined;
  const ledgers = [frameLedger, own].filter((l, i, all): l is WriteLedger => l !== undefined && all.indexOf(l) === i);
  return (await verdictOf(ledgers)).ok;
}

/**
 * For a core sender whose visible result is a Discord message rather than a response (a persistent panel's edit):
 * true when every write is confirmed; otherwise false, and the member has been told the truth. When it had a write to
 * wait on, it hands the interaction back acknowledged before true: an update on a component's message, otherwise an
 * ephemeral deferral. An interaction no gate holds is judged without anything being sent.
 */
export function answerWrites(interaction: object | null | undefined): Promise<boolean> {
  const gate = interaction ? gates.get(interaction) : undefined;
  return gate ? gate.answer(currentLedger(), true, currentModule()) : judgedOk(interaction);
}

/**
 * As answerWrites, but it sends nothing and never acknowledges: false for a write not confirmed, and false once the
 * ack deadline passes with the verdict still out, so the caller's own response stays possible.
 */
export function writesConfirmed(interaction: object | null | undefined): Promise<boolean> {
  const gate = interaction ? gates.get(interaction) : undefined;
  return gate ? gate.answer(currentLedger(), false, currentModule()) : judgedOk(interaction);
}

/**
 * The sweep (BT-4), at the end of an interaction's dispatch: when a write was recorded that the last payload was not
 * judged on, so that payload did not wait on it, it logs the module that sent it, once per site. Only the last
 * payload is compared, so an earlier one sent before a write that a later payload waited on (a progress reply) is not
 * logged, and a last payload from a module that declares dataContract 2 (BT-5) is never compared: that module owns
 * its outcomes. It runs after every call still queued, and sends nothing; an interaction no gate holds is not swept,
 * nor a dispatch that outlives the interaction ledger's life (15 minutes), whose ledger is sealed by then.
 */
export function sweepLateWrites(interaction: object): Promise<void> {
  const gate = gates.get(interaction);
  return gate ? gate.sweep().catch(() => undefined) : Promise.resolve();
}

/** The gateway Client's interactions: each gets its ledger (BT-2) and its reply gate. */
export function installGatedInteractions(client: Client): void {
  installInteractionLedgers(client, installReplyGate);
}
