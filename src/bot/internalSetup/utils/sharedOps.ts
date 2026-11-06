// The web UI's changes to shared files, as ops one executor applies: the bot process while it runs (IPC shared:op),
// the web UI's local chain while it does not. One implementation, so a local change and a child change behave alike.

import * as path from 'path';
import { dataPath } from '../../../utils/dataRoot';
import { isStopping, readRawStrict, writeRawAtomic } from './dataManager';
import { ROOT_CONFIG_PATH } from './configManager';
import { isInternalGlobalRel } from './configDiscovery';
import { applyOperatorGlobalRead, shaOfRaw, CHANGED_SINCE_OPEN_TEXT, CHANGED_TEXT, type GlobalDataReadRequest } from './ipcDataHandler';
import { maintenanceIpcRefusal } from './maintenance';
import { isMaintenanceBoot, maintenanceText } from './maintenanceGate';
import { carryWrites, landed, markPaymentLedger, NO_WRITES, runSealed, writesOf, type OpWrites, type WriteLedger } from './dataBackends/writeLedger';
import { truthText, verdictOf, type TruthAnswer } from './dataBackends/replyGate';
import { checkWriterLock, deposedText } from './writerLock';
export { deposedText } from './writerLock';
import { getPremiumManager, invalidatePremiumCache, MigrationBusy, settlePremiumInstalls } from './premiumManager';
import { getPaymentRegistry } from './payment/paymentRegistry';
import { invalidateDummyCaches } from './payment/dummyProvider';

export interface SharedOpRequest {
  op: string;
  args?: any;
}

export type SharedOpCode = 'invalid' | 'maintenance' | 'held-elsewhere' | 'changed' | 'changed-since-open' | 'unconfirmed' | 'failed';

export type SharedOpReply =
  | { ok: true; result?: unknown }
  | { ok: false; code: SharedOpCode; error: string; answer?: TruthAnswer; partial?: boolean; result?: unknown; stopping?: boolean };

export const PROVIDER_SENTENCE = "A payment provider call this change made may already have taken effect; check the provider's dashboard.";

/** Whether an op's not-ok answer carries the provider sentence. */
export const callsProvider = (op: string): boolean => op.startsWith('premium.') || op.startsWith('payment.');

/** Every PremiumManager method the web UI calls that can save. */
export const PREMIUM_METHODS = [
  'setTier', 'deleteTier', 'setMessages', 'resetMessages', 'setGlobalModuleConfig', 'grantManual', 'extendManual',
  'revokeManual', 'initiatePaidSubscription', 'cancelPaidSubscription', 'reactivatePaidSubscription',
  'cancelPaidSubscriptionImmediately', 'cancelAndRemovePausedSubscription', 'adoptOrphan', 'cancelOrphan',
  'linkAccount', 'unlinkAccount', 'unlinkProviderAccount', 'recordMigrationDecision', 'setNotificationsChannelId', 'setProviderActivation',
  'setMigrationSilencePolicy', 'scheduleMigration', 'cancelMigration',
] as const;

export const DUMMY_METHODS = [
  'adminSetVariant', 'adminDeleteVariant', 'adminSetProduct', 'adminDeleteProduct', 'adminSetCoupon', 'adminDeleteCoupon',
] as const;

type OpFn = (args: any) => unknown;

/** Waits for the work an op started under its ledger: the installs a provider event starts (decision 13 of NB10). */
let settler: ((ledger: WriteLedger) => Promise<void>) | null = settlePremiumInstalls;

export function setOpSettler(fn: ((ledger: WriteLedger) => Promise<void>) | null): void {
  settler = fn;
}

/** The Dummy provider as the dummy.* ops and their refusal see it, when it is registered. */
function registeredDummy(): { cannotReadText?: () => string | null } | undefined {
  return getPaymentRegistry().get('dummy') as unknown as { cannotReadText?: () => string | null } | undefined;
}

/**
 * Decision 8 step 4: a premium, Dummy or payment op is refused at once while its file cannot be read, while the bot
 * holds or applies kept provider events, or, in the web UI, while the event journal is pending or cannot be read.
 */
function cacheRefusal(op: string): string | null {
  const premium = getPremiumManager();
  const unreadable = op.startsWith('dummy.') ? registeredDummy()?.cannotReadText?.() ?? null : premium.unreadableText();
  return unreadable ?? premium.heldEventsText();
}

/** Drops the premium and Dummy caches: the local chain calls it after an op whose answer is not ok, before the next op. */
export function invalidateSharedCaches(): void {
  invalidatePremiumCache();
  invalidateDummyCaches();
}

/** The path a global.write or global read names: the root config, or a .json under /data/global. */
export function globalTarget(req: GlobalDataReadRequest): string | null {
  if (req.root === 'config') return ROOT_CONFIG_PATH;
  const rel = req.rel;
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\\') || rel.includes('..') || rel.startsWith('/') || !rel.endsWith('.json') || isInternalGlobalRel(rel)) return null;
  const globalDir = dataPath('global');
  const absPath = path.join(globalDir, ...rel.split('/'));
  return absPath.startsWith(globalDir + path.sep) ? absPath : null;
}

class OpRefusal extends Error {
  constructor(readonly code: SharedOpCode, message: string) {
    super(message);
  }
}

function globalWrite(args: { root?: 'config'; rel?: string; contentJson?: unknown; expectSha?: unknown; sinceOpen?: unknown }): boolean {
  if (isMaintenanceBoot()) throw new OpRefusal('maintenance', maintenanceText());
  const absPath = globalTarget({ root: args?.root, rel: args?.rel });
  if (!absPath) throw new OpRefusal('invalid', 'invalid global file');
  if (typeof args.contentJson !== 'string') throw new OpRefusal('invalid', 'contentJson is required');
  if (typeof args.expectSha !== 'string') throw new OpRefusal('invalid', 'expectSha is required');
  // The compare and the write are one synchronous turn.
  if (shaOfRaw(readRawStrict(absPath)) !== args.expectSha) {
    throw args.sinceOpen === true ? new OpRefusal('changed-since-open', CHANGED_SINCE_OPEN_TEXT) : new OpRefusal('changed', CHANGED_TEXT);
  }
  // A refusal is recorded in the op's ledger, whose verdict answers it.
  return writeRawAtomic(absPath, args.contentJson);
}

function dummyProvider(): Record<string, (...a: any[]) => unknown> {
  const dummy = getPaymentRegistry().get('dummy') as unknown as Record<string, (...a: any[]) => unknown> | undefined;
  if (!dummy || typeof dummy.adminSetVariant !== 'function') throw new OpRefusal('invalid', 'The Dummy provider is not registered');
  return dummy;
}

async function paymentWebhook(args: { providerId?: unknown; body?: unknown; signature?: unknown; headers?: unknown }): Promise<{ received: true }> {
  const provider = typeof args?.providerId === 'string' ? getPaymentRegistry().get(args.providerId) : undefined;
  if (!provider || !provider.handleWebhook) throw new OpRefusal('invalid', `Unknown provider or no webhook handler: ${String(args?.providerId)}`);
  const body = Buffer.from(typeof args.body === 'string' ? args.body : '', 'base64');
  const headers = (args.headers && typeof args.headers === 'object' ? args.headers : {}) as Record<string, string>;
  try {
    await provider.handleWebhook(body, typeof args.signature === 'string' ? args.signature : '', headers);
  } catch (error) {
    throw new WebhookRejected(error instanceof Error ? error.message : String(error));
  }
  return { received: true };
}

/** handleWebhook's own error: the route answers it 400 as today. */
export class WebhookRejected extends Error {}

async function paymentOAuthCallback(args: { providerId?: unknown; query?: unknown }): Promise<{ linked: string } | { linkedElsewhere: string }> {
  const providerId = typeof args?.providerId === 'string' ? args.providerId : 'patreon';
  const provider = getPaymentRegistry().get(providerId);
  if (!provider || !provider.handleOAuthCallback) throw new OpRefusal('invalid', `${providerId} is not configured on this bot.`);
  let result;
  try {
    result = await provider.handleOAuthCallback((args.query ?? {}) as Record<string, string>);
  } catch (error) {
    throw new WebhookRejected(error instanceof Error ? error.message : String(error));
  }
  const mgr = getPremiumManager();
  const existing = mgr.getAccountLink(provider.id, result.externalAccountId);
  if (existing && existing !== result.guildId) return { linkedElsewhere: existing };
  mgr.linkAccount(provider.id, result.externalAccountId, result.guildId);
  getPaymentRegistry().emitEvent({
    type: 'subscription.created',
    providerId: provider.id,
    providerSubId: `${provider.id}:${result.externalAccountId}:${result.guildId}`,
    guildId: result.guildId,
    tierId: result.tierId,
    offeringId: result.offeringId,
    variantId: result.variantId,
    state: result.state,
  });
  return { linked: result.guildId };
}

function setGlobalModuleConfig(args: { moduleName?: unknown; partial?: unknown; expectSha?: unknown; rel?: unknown }): unknown {
  if (typeof args?.moduleName !== 'string') throw new OpRefusal('invalid', 'moduleName is required');
  if (typeof args.expectSha === 'string' && typeof args.rel === 'string') {
    const absPath = globalTarget({ rel: args.rel });
    if (!absPath) throw new OpRefusal('invalid', 'invalid global file');
    const raw = readRawStrict(absPath);
    if (shaOfRaw(raw) !== args.expectSha) throw new OpRefusal('changed', CHANGED_TEXT);
    let base: Record<string, any> = {};
    if (raw !== null) {
      try {
        base = JSON.parse(raw);
      } catch {
        throw new OpRefusal('invalid', `the global settings of ${args.moduleName} are not valid JSON`);
      }
    }
    return getPremiumManager().setGlobalModuleConfig(args.moduleName, (args.partial ?? {}) as any, base);
  }
  throw new OpRefusal('invalid', 'expectSha is required');
}

const registry = new Map<string, OpFn>();
registry.set('global.write', globalWrite);
registry.set('payment.webhook', paymentWebhook);
registry.set('payment.oauthCallback', paymentOAuthCallback);
for (const method of PREMIUM_METHODS) {
  if (method === 'setGlobalModuleConfig') continue;
  registry.set(`premium.${method}`, (args: { args?: unknown[] }) => {
    const fn = (getPremiumManager() as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== 'function') throw new OpRefusal('invalid', `unknown premium op ${method}`);
    return fn.apply(getPremiumManager(), Array.isArray(args?.args) ? args.args : []);
  });
}
registry.set('premium.setGlobalModuleConfig', setGlobalModuleConfig);
for (const method of DUMMY_METHODS) {
  registry.set(`dummy.${method}`, (args: { args?: unknown[] }) => dummyProvider()[method](...(Array.isArray(args?.args) ? args.args : [])));
}

export function isRegisteredOp(op: string): boolean {
  return registry.has(op);
}

export function registeredOps(): string[] {
  return [...registry.keys()];
}

function withProviderSentence(op: string, text: string): string {
  return callsProvider(op) ? `${text} ${PROVIDER_SENTENCE}` : text;
}

/**
 * Every partial answer, wherever it is worded, ends here: it names the files known to have landed (or says it can't
 * confirm which part was saved) and asks for a reload in place of a retry, which could apply the saved part twice.
 */
export function partialEnding(saved: string[]): string {
  return saved.length > 0
    ? `What was saved: ${saved.join(', ')}. Reload to see it before you try again: trying again could apply the saved part twice.`
    : "Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice.";
}

/** The partialEnding a partial answer's text carries, with what follows it (the provider sentence), or null. */
export function partialEndingIn(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const at = [text.indexOf('What was saved: '), text.indexOf("Can't confirm whether part of it was saved.")].filter(i => i >= 0);
  return at.length > 0 ? text.slice(Math.min(...at)) : null;
}

/** NB13 D4: a path is named saved only when the listed tickets hold a landed one of it and none of it not landed. */
function landedNames(ledger: WriteLedger): string[] {
  const files = ledger.tickets().map(entry => entry.ticket).filter(ticket => ticket.kind === 'file') as Array<{ path: string } & Parameters<typeof landed>[0]>;
  const open = new Set(files.filter(ticket => !landed(ticket)).map(ticket => ticket.path));
  return [...new Set(files.filter(ticket => landed(ticket) && !open.has(ticket.path)).map(ticket => path.basename(ticket.path)))];
}

/** A partial answer drops its closing "Please ..." request and ends with partialEnding. */
export function partialText(text: string, ledger: WriteLedger): string {
  return `${text.replace(/ Please [^.]*\.$/, '')} ${partialEnding(landedNames(ledger))}`;
}

/** Applies one op in this process: the lock check, the op inside its own sealed ledger, and the verdict over it. */
export async function applySharedOp(req: SharedOpRequest): Promise<SharedOpReply> {
  const op = typeof req?.op === 'string' ? req.op : '';
  const check = checkWriterLock();
  if (check.kind === 'deposed') return carryWrites({ ok: false, code: 'held-elsewhere', error: deposedText(check.holder) }, NO_WRITES);
  const fn = registry.get(op);
  if (!fn) return carryWrites({ ok: false, code: 'invalid', error: `unknown op ${op || '(none)'}` }, NO_WRITES);
  if (op.startsWith('premium.') || op.startsWith('dummy.') || op.startsWith('payment.')) {
    const refusal = cacheRefusal(op);
    if (refusal) return carryWrites({ ok: false, code: 'failed', error: refusal }, NO_WRITES);
  }
  let writes: OpWrites | undefined;
  try {
    const reply = await runSealed('console', null, null, async ledger => {
      try {
        if (op.startsWith('payment.')) markPaymentLedger(ledger, op);
        const result = await fn(req.args);
        if (settler) await settler(ledger);
        const verdict = await verdictOf([ledger]);
        if (verdict.ok) return { ok: true as const, result };
        return {
          ok: false as const,
          code: 'unconfirmed' as const,
          answer: verdict.answer,
          partial: verdict.partial,
          error: withProviderSentence(op, verdict.partial ? partialText(truthText(verdict.answer, true), ledger) : truthText(verdict.answer, false)),
          result,
          ...(isStopping() ? { stopping: true } : {}),
        };
      } finally {
        writes = writesOf(ledger);
      }
    });
    return carryWrites(reply, writes);
  } catch (error) {
    if (error instanceof OpRefusal) return carryWrites({ ok: false, code: error.code, error: error.code === 'unconfirmed' ? withProviderSentence(op, error.message) : error.message }, writes);
    if (error instanceof WebhookRejected) return carryWrites({ ok: false, code: 'invalid', error: error.message }, writes);
    if (error instanceof MigrationBusy) return carryWrites({ ok: false, code: 'changed', error: error.message }, writes);
    // A throw of its own leaves the op's writes off its reply: the local chain answers it can't confirm.
    return { ok: false, code: 'failed', error: withProviderSentence(op, error instanceof Error ? error.message : String(error)) };
  }
}

let handlerInstalled = false;

/** The bot process's early handler for shared:op and data:global-read, registered once the boot mode is known. */
export function setupSharedOpsIPC(): void {
  if (handlerInstalled || !process.send) return;
  handlerInstalled = true;
  process.on('message', async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: string; requestId?: string; data?: any };
    if ((type !== 'shared:op' && type !== 'data:global-read') || !requestId) return;
    let reply: unknown;
    try {
      if (type === 'shared:op') {
        reply = await applySharedOp((data || {}) as SharedOpRequest);
      } else {
        reply = maintenanceIpcRefusal(type) ?? applyOperatorGlobalRead((data || {}) as GlobalDataReadRequest);
      }
    } catch (error) {
      reply = { ok: false, code: type === 'shared:op' ? 'failed' : 'io-error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
    try {
      process.send!({ requestId, data: reply });
    } catch (error) {
      console.error('[SharedOps] Could not send an answer to the web UI:', error);
    }
  });
}
