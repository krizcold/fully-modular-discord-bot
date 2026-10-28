// The interaction reply gate (BT-3): on a real interaction, a response method sends the module's payload only once
// every write in the union of its ledgers has landed and none was refused; otherwise the member is told a truthful
// text in its place (tell says where it goes). A response called before ACK_MS from the emit is acknowledged by then;
// one called later, at once. A module that declares dataContract 2 (BT-5) is judged on refusals only: its payload goes
// out at once, unless a write was refused, and the gate defers nothing for it.

import {
  ContainerBuilder,
  InteractionCallbackResponse,
  InteractionResponseType,
  Message,
  MessageFlags,
  MessageFlagsBitField,
  TextDisplayBuilder,
  type Client,
} from 'discord.js';
import { getConfigProperty } from '../configManager';
import { confirmWrite, isStopping } from '../dataManager';
import { parseButtonCustomId, parseDropdownCustomId, parseModalCustomId } from '../panel/panelCustomIds';
import { declaresOwnOutcomes } from './dataContract';
import { currentLedger, currentModule, installInteractionLedgers, landed, ledgerOf, openLedger, runInLedger, type LedgerCause, type LedgerTicket, type WriteLedger } from './writeLedger';

/** From the interaction's emit to the gate's own defer. Discord's 3 s also pays the gateway's delivery and the callback. */
export const ACK_MS = 2000;
/** The longest a gated response waits on its writes (BT-1's bound). */
export const CONFIRM_MS = 8000;

export type TruthAnswer = 'pending' | 'held' | 'deposed' | 'unavailable' | LedgerCause;

// Worst first.
const RANK: TruthAnswer[] = [
  'node-stopping', 'maintenance', 'guild-fenced', 'deposed', 'database-unreachable', 'database-backlog',
  'frozen', 'not-ready', 'storage-failing', 'io', 'unavailable', 'held', 'pending',
];
const worst = (answers: TruthAnswer[]): TruthAnswer => answers.reduce((a, b) => (RANK.indexOf(b) < RANK.indexOf(a) ? b : a));

/** partial: another write in the same response's ledgers was accepted, so "not saved in full". */
export function truthText(answer: TruthAnswer, partial: boolean): string {
  const notSaved = partial ? 'not saved in full' : 'not saved';
  const inFull = partial ? ' in full' : '';
  // The exit drain may give up on a held or pending write and the process exits, so no retry is promised.
  if ((answer === 'held' || answer === 'pending') && isStopping()) {
    return `The bot is restarting and could not confirm your change was saved${inFull}; it may be lost. Please check once it is back.`;
  }
  switch (answer) {
    case 'node-stopping':
      return `The bot is restarting, so your change was ${notSaved}. Please try again in a moment.`;
    case 'maintenance':
      return `The bot is in maintenance, so your change was ${notSaved}. Please try again later.`;
    case 'guild-fenced':
    case 'deposed':
      return `Another bot process took over this server's data, so your change was ${notSaved}. Please try again in a moment.`;
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
      return `This server's data is not served by this bot process right now, so your change was ${notSaved}. Please try again in a moment.`;
    case 'not-ready':
      return `This server's data is still loading, so your change was ${notSaved}. Please try again in a moment.`;
    case 'storage-failing':
      return `The bot cannot write to its disk right now, so your change was ${notSaved}. Please try again later or contact support.`;
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
  refused: Refused[];
  /** A confirmed write is no longer listed: its entry gave way to a later write of the same guild or path. */
  landedBefore: boolean;
}

const keyOf = (ticket: LedgerTicket): object => (ticket.kind === 'file' ? ticket.record : ticket.set);

function pendingIn(ledgers: WriteLedger[]): Pending {
  const tickets = ledgers.flatMap(ledger => ledger.tickets()).map(entry => entry.ticket);
  const refused = ledgers.flatMap(ledger => ledger.refusedDocs()).map(({ cause, doc, seq }) => ({
    cause, doc, seq, rewritten: ledgers.some(ledger => ledger.rewriteSeq(doc) > seq),
  }));
  return { tickets, unlanded: tickets.filter(ticket => !landed(ticket)), refused, landedBefore: ledgers.some(ledger => ledger.landedDropped) };
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
  const first = await Promise.all(pending.unlanded.map(ticket => confirmWrite(ticket, waitMs).catch(() => 'unavailable' as const)));
  // A held write is retried while slower confirms finish, so it is read again when the verdict is taken.
  const answers = await Promise.all(first.map((answer, i) => answer !== 'held'
    ? answer
    : confirmWrite(pending.unlanded[i], 0).then(now => (now === 'pending' ? 'held' as const : now), () => 'unavailable' as const)));
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
  const verdict = await failuresOf(ledgers);
  return verdict.ok ? verdict : { ok: false, answer: verdict.answer, partial: verdict.partial };
}

async function failuresOf(ledgers: WriteLedger[]): Promise<Verdict> {
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
    if (!verdict.ok) return verdict;
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

const isEphemeral = (options: Options): boolean => options.ephemeral === true || flagsOf(options.flags).has(MessageFlags.Ephemeral);

/** The message a deleteReply or fetchReply argument names, as discord.js reads it. */
function idOf(message: unknown): string {
  if (message === undefined || message === null) return '@original';
  return typeof message === 'string' ? message : String((message as { id?: unknown }).id);
}

/** The message an editReply's options name. */
const targetOf = (options: Options): string => idOf(options.message);

/** The message id a response method's result shows, if any (an InteractionResponse's id is the interaction's). */
function messageIdOf(result: unknown): string | undefined {
  if (result instanceof Message) return result.id;
  if (result instanceof InteractionCallbackResponse) return result.resource?.message?.id ?? result.interaction.responseMessageId ?? undefined;
  return undefined;
}

const isUnknownMessage = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 10008;

/**
 * A deferral with nothing in it yet. Discord takes no empty edit or followUp, so a fill always left content, an
 * embed, a component, an attachment or a poll. Whether the Loading flag reads back (before or after a fill) is not
 * measured (RK-2), so it decides nothing.
 */
function isEmptyDeferral(message: Message): boolean {
  return !message.content && message.embeds.length === 0 && message.components.length === 0
    && message.attachments.size === 0 && !message.poll;
}

/**
 * The gate's deferral's callback response, given the message the caller's call showed, which withResponse reads. When
 * that message is the followUp standing in for the deleted deferral, the response names it as its message too.
 */
function withMessage(ack: unknown, name: 'reply' | 'update', message: unknown, standIn = false): unknown {
  if (!ack || typeof ack !== 'object') return ack;
  const response = ack as { resource: Record<string, unknown> | null; interaction?: Record<string, unknown> };
  if (response.resource) response.resource.message = message;
  else {
    const type = name === 'reply' ? InteractionResponseType.DeferredChannelMessageWithSource : InteractionResponseType.DeferredMessageUpdate;
    response.resource = { type, activityInstance: null, message };
  }
  if (standIn && response.interaction) {
    Object.assign(response.interaction, {
      responseMessageId: messageIdOf(message) ?? null,
      responseMessageLoading: false,
      responseMessageEphemeral: true,
    });
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
  const target = interaction as Record<string, unknown> & { message?: { id?: string; flags?: unknown } | null };
  if (typeof target.reply !== 'function') return;
  const original: Record<string, Method> = {};
  for (const name of Object.keys(SETS)) {
    if (typeof target[name] === 'function') original[name] = target[name] as Method;
  }
  const fetchMessage = target.fetchReply as Method;

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
  const componentEphemeral = flagsOf(target.message?.flags).has(MessageFlags.Ephemeral);
  // What the calls made of the original (the message an editReply edits by default): whether the member alone is known
  // to see it, and whether it is a deferral no call is known to have filled. That one is read back before any delete.
  const shown = { ephemeral: false, emptyDeferral: false };
  // The original's message id once a result showed it, so a call naming it by id or by its Message is a call on it.
  let originalId: string | undefined;
  // Once the gate deleted an empty public deferral, its truth's followUp stands in the original's place.
  let standIn: string | undefined;
  let deletedOriginal = false;
  const isOriginal = (id: string): boolean => id === '@original' || id === originalId;
  const onOriginal = (id: string): boolean => (standIn === undefined ? isOriginal(id) : id === standIn);

  const send = async (name: string, args: unknown[]): Promise<unknown> => {
    let call: Promise<unknown>;
    hidden += 1;
    try {
      call = original[name].apply(target, args);
    } finally {
      hidden -= 1;
    }
    const result = await call;
    const options = optionsOf(args[0]);
    const isV2 = flagsOf(options.flags).has(MessageFlags.IsComponentsV2);
    // A reply or a deferral makes a new original message; an update or an edit can only turn the current one V2.
    if (name === 'reply' || name === 'deferReply') originalIsV2 = name === 'reply' && isV2;
    else if ((name === 'update' || name === 'editReply') && isV2) originalIsV2 = true;
    if (name === 'reply' || name === 'deferReply') {
      // discord.js records the flags it sent; an ephemeral option on a payload built for another target is not sent.
      shown.ephemeral = typeof target.ephemeral === 'boolean' ? target.ephemeral : isEphemeral(options);
      shown.emptyDeferral = name === 'deferReply';
      originalId ??= messageIdOf(result);
    } else if (name === 'update' || name === 'deferUpdate') {
      // The original is the component's message.
      shown.ephemeral = componentEphemeral;
      shown.emptyDeferral = false;
      originalId = target.message?.id;
    } else if (name === 'editReply' && onOriginal(targetOf(options))) {
      shown.emptyDeferral = false;
      if (standIn === undefined) originalId ??= messageIdOf(result);
    } else if (name === 'deleteReply' && isOriginal(idOf(args[0]))) {
      shown.ephemeral = false;
      shown.emptyDeferral = false;
    }
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
    const message = name === 'editReply' ? { message: targetOf(optionsOf(payload)) } : {};
    if (originalIsV2 || flagsOf(optionsOf(payload).flags).has(MessageFlags.IsComponentsV2)) {
      const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
      return { components: [container], flags: MessageFlags.IsComponentsV2, attachments: [], allowedMentions, ...message, ...asked };
    }
    return { content: text, embeds: [], components: [], attachments: [], allowedMentions, ...message, ...asked };
  };

  // A public deferral no call is known to have filled is read back first, and deleted only while it holds nothing
  // (isEmptyDeferral). One Discord no longer holds counts as deleted; either way the truth's followUp
  // then stands in its place. A delete that fails otherwise rejects the call, and the next call tries again.
  const dropEmptyDeferral = async (): Promise<void> => {
    const message = await (fetchMessage.call(target, '@original') as Promise<Message>).catch(error => {
      if (isUnknownMessage(error)) return null;
      throw error;
    });
    if (message && !isEmptyDeferral(message)) {
      shown.emptyDeferral = false;
      return;
    }
    if (message) {
      await send('deleteReply', []).catch(error => {
        if (!isUnknownMessage(error)) throw error;
      });
    }
    shown.ephemeral = false;
    shown.emptyDeferral = false;
    deletedOriginal = true;
  };

  // The truth goes into a message in place only when the member alone is known to see it: a refused first reply goes
  // as an ephemeral reply; the ephemeral message a button, select menu or form came from takes the update, or the edit
  // after an update or deferUpdate of it; an original a reply or a deferral sent ephemeral takes the edit; and so does
  // the truth's own followUp standing in for a deleted deferral. Otherwise it goes to the member by an ephemeral
  // followUp (after an update's acknowledgement) and the message others see is left as it is, except an empty public
  // deferral, deleted first (dropEmptyDeferral) so no public placeholder stays. An ephemeral message the member
  // dismissed answers Unknown Message to the edit, and the truth then goes by a new ephemeral followUp.
  const tell = async (name: string, verdict: Extract<Verdict, { ok: false }>, payload: unknown, wantMessage = true): Promise<unknown> => {
    const options = optionsOf(payload);
    if (!verdict.failed.some(isNew)) {
      // Told already: a later edit leaves the message as it stands, and a later followUp is dropped.
      if (name === 'editReply') return fetchMessage.call(target, targetOf(options));
      if (name === 'followUp') return undefined;
    }
    const text = truthText(verdict.answer, verdict.partial);
    const inPlace = name === 'reply'
      || (name === 'update' && componentEphemeral)
      || (name === 'editReply' && onOriginal(targetOf(options)) && shown.ephemeral);
    let gone = false;
    if (inPlace) {
      try {
        const result = await send(name, [truthPayload(name, text, payload)]);
        verdict.failed.forEach(markTold);
        return result;
      } catch (error) {
        if (name !== 'editReply' || !isUnknownMessage(error)) throw error;
        gone = true;
        shown.ephemeral = false;
        shown.emptyDeferral = false;
        standIn = undefined;
      }
    }
    const ack = name === 'update' ? await send('deferUpdate', [{ withResponse: options.withResponse }]) : undefined;
    if (shown.emptyDeferral && !shown.ephemeral && standIn === undefined) await dropEmptyDeferral();
    let told: unknown;
    try {
      told = await send('followUp', [truthPayload('followUp', text, undefined)]);
    } catch (error) {
      // Not measured (RK-2): whether Discord takes a followUp once its deferral was deleted. If it answers Unknown
      // Message, every later call would fail the same way, so this truth counts as told, and that is logged.
      if (deletedOriginal && standIn === undefined && isUnknownMessage(error)) {
        verdict.failed.forEach(markTold);
        const { kind, name: site } = siteOf(target);
        console.warn(`[Truth] Discord refused the truth's followUp after its deferral was deleted (${kind} ${site})`);
      }
      throw error;
    }
    verdict.failed.forEach(markTold);
    // The truth whose followUp failed after the delete is told on a later call, which then stands in for it.
    const replacing = deletedOriginal && standIn === undefined;
    if (replacing) {
      standIn = (told as { id?: string } | undefined)?.id;
      shown.ephemeral = standIn !== undefined;
      originalIsV2 = false;
    }
    if (name === 'followUp') return told;
    if (name === 'update') {
      if (!options.withResponse && !options.fetchReply) return ack;
      // The caller asked for the message it showed: the component message, as it stands.
      const message = await fetchMessage.call(target);
      return options.withResponse ? withMessage(ack, 'update', message) : message;
    }
    if (!wantMessage) return undefined;
    // The message that stands: the truth's followUp in place of a deleted deferral or a dismissed message, otherwise
    // the one the edit named.
    return replacing || gone ? told : fetchMessage.call(target, targetOf(options));
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
        const ephemeral = isEphemeral(options);
        const ack = name === 'reply'
          ? await send('deferReply', [{ flags: ephemeral ? MessageFlags.Ephemeral : undefined, withResponse: options.withResponse }])
          : await send('deferUpdate', [{ withResponse: options.withResponse }]);
        const verdict = await verdicts;
        const wantMessage = Boolean(options.withResponse || options.fetchReply);
        const edited = verdict.ok ? await payload('editReply', [asEdit(args[0])]) : await tell('editReply', verdict, args[0], wantMessage);
        // As discord.js does, withResponse wins over fetchReply.
        if (options.withResponse) return withMessage(ack, name === 'reply' ? 'reply' : 'update', edited, standIn !== undefined);
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
  // A call on the original (by @original, its id or its Message) after the gate deleted it goes to the followUp
  // standing in its place, and a delete of it, or of that followUp, is done: the truth stays in front of the member.
  // InteractionResponse's edit, delete and fetch call these.
  const retarget = (name: string, args: unknown[]): unknown[] | null => {
    if (standIn === undefined) return args;
    if (name === 'editReply') {
      const options = optionsOf(args[0]);
      return isOriginal(targetOf(options)) ? [{ ...options, message: standIn }, ...args.slice(1)] : args;
    }
    return name === 'deleteReply' && (isOriginal(idOf(args[0])) || idOf(args[0]) === standIn) ? null : args;
  };
  for (const name of Object.keys(original)) {
    target[name] = (...args: unknown[]): Promise<unknown> => {
      const frameLedger = currentLedger();
      const sender = currentModule() ?? ledger.kind;
      return enqueue(SETS[name], async () => {
        const callArgs = retarget(name, args);
        if (callArgs === null) return undefined;
        return GATED.has(name) ? gated(name, callArgs, frameLedger, sender) : send(name, callArgs);
      });
    };
  }
  // A read, so neither gated nor queued; discord.js's own fetchReply inside a reply or deferral comes through it too.
  if (typeof fetchMessage === 'function') {
    target.fetchReply = async (message?: unknown): Promise<unknown> => {
      const id = idOf(message);
      const result = await fetchMessage.call(target, standIn !== undefined && isOriginal(id) ? standIn : message);
      if (standIn === undefined && id === '@original') originalId ??= messageIdOf(result);
      return result;
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

const MESSAGE_SENDS = ['reply', 'editReply', 'followUp'] as const;
const gatedCallbacks = new WeakSet<Function>();

/**
 * A command called with no reply gate (a message-triggered proxy; never a gated interaction or the console invoke)
 * runs in its own ledger, and its argument's reply, editReply and followUp send the truth text in place of the
 * module's payload unless every write so far landed. A write recorded after the last payload is logged, as the sweep does.
 */
export function gateCommandCallback(command: { callback?: unknown; _moduleName?: string; name?: string }): void {
  const callback = command.callback;
  if (typeof callback !== 'function' || gatedCallbacks.has(callback)) return;
  const wrapped = async function gatedCallback(this: unknown, ...args: unknown[]): Promise<unknown> {
    const target = args[1] as Record<string, unknown> | null | undefined;
    if (!target || typeof target !== 'object' || ledgerOf(target) || currentLedger()) return callback.apply(this, args);
    const ledger = openLedger('message');
    const module = command._moduleName ?? null;
    const name = command.name ?? 'unknown';
    const saved: Array<[string, PropertyDescriptor | undefined]> = [];
    let mark: Mark | null = null;
    let postedV2 = false;
    const told = { refusals: new Set<string>(), tickets: new Map<object, number>() };
    const isNew = (failure: Failure) =>
      'refusal' in failure ? !told.refusals.has(failure.refusal) : (told.tickets.get(failure.key) ?? -1) < failure.seq;
    const markTold = (failure: Failure) => {
      if ('refusal' in failure) told.refusals.add(failure.refusal);
      else told.tickets.set(failure.key, Math.max(failure.seq, told.tickets.get(failure.key) ?? -1));
    };
    const editedFlags = async (): Promise<unknown> => {
      const posted = target.replyMessage as { flags?: unknown } | null | undefined;
      if (posted?.flags !== undefined) return posted.flags;
      if (typeof target.fetchReply !== 'function') return undefined;
      const message = await Promise.resolve((target.fetchReply as () => unknown).call(target)).catch(() => null);
      return (message as { flags?: unknown } | null)?.flags;
    };
    for (const method of MESSAGE_SENDS) {
      const send = target[method];
      if (typeof send !== 'function') continue;
      saved.push([method, Object.getOwnPropertyDescriptor(target, method)]);
      target[method] = async (...callArgs: unknown[]): Promise<unknown> => {
        const verdict = await failuresOf([ledger]);
        if (!verdict.ok) {
          mark = null;
          if (!verdict.failed.some(isNew)) {
            // Told already: a later followUp is dropped and a later edit leaves the message as it stands.
            if (method === 'followUp') return undefined;
            return typeof target.fetchReply === 'function' ? (target.fetchReply as () => unknown).call(target) : undefined;
          }
          const text = truthText(verdict.answer, verdict.partial);
          const allowedMentions = { parse: [] };
          let payload: Record<string, unknown> = { content: text };
          if (method === 'editReply') {
            const v2 = postedV2 || flagsOf(optionsOf(callArgs[0]).flags).has(MessageFlags.IsComponentsV2)
              || flagsOf(await editedFlags()).has(MessageFlags.IsComponentsV2);
            payload = v2
              ? { components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text))], flags: MessageFlags.IsComponentsV2, attachments: [], allowedMentions }
              : { content: text, embeds: [], components: [], attachments: [], allowedMentions };
          }
          const result = await send.call(target, payload);
          verdict.failed.forEach(markTold);
          return result;
        }
        if (method !== 'followUp' && flagsOf(optionsOf(callArgs[0]).flags).has(MessageFlags.IsComponentsV2)) postedV2 = true;
        const result = await send.apply(target, callArgs);
        mark = markOf(pendingIn([ledger]), [ledger], module ?? 'message');
        return result;
      };
    }
    try {
      return await runInLedger(ledger, module, () => callback.apply(this, args));
    } finally {
      for (const [method, descriptor] of saved) {
        if (descriptor) Object.defineProperty(target, method, descriptor);
        else delete target[method];
      }
      const last = mark as Mark | null;
      const site = `${last?.module}|message|${name}`;
      if (last && wroteSince(last) && !reported.has(site)) {
        reported.add(site);
        console.warn(`[Truth] ${last.module} sent a reply that did not wait on a write (message ${name})`);
      }
      ledger.seal();
    }
  };
  gatedCallbacks.add(wrapped);
  command.callback = wrapped;
}
