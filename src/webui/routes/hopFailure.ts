import { RESTORE_RUNNING_WRITE } from '../backups/restoreState';

export interface HopFailure {
  status: number;
  error: string;
}

/**
 * HTTP status and operator text for a guild data request the bot refused.
 * Returns null for codes the caller words itself (invalid, unknown).
 */
export function hopFailure(code: unknown, detail?: string): HopFailure | null {
  switch (code) {
    case 'frozen':
      return { status: 503, error: "This guild's shard is not served by this bot process right now, so nothing was changed; retry in a moment" };
    case 'not-owner':
      return { status: 503, error: detail ? `Another bot process took over this guild's data, so the change was not saved (${detail})` : "Another bot process took over this guild's data, so the change was not saved" };
    case 'backend-unavailable':
      return { status: 503, error: detail || 'the database backend is unavailable' };
    case 'bot-down':
      return { status: 503, error: 'the bot process is not running' };
    case 'maintenance':
      return { status: 503, error: detail || 'the bot is in maintenance, so nothing was changed' };
    case 'starting':
      return { status: 503, error: detail || 'The bot is starting and has not opened its data files yet; nothing was saved. Try again in a moment.' };
    case 'stopping':
      return { status: 503, error: detail || 'The bot is stopping; nothing was saved. Save again once it has stopped.' };
    case 'held-elsewhere':
      return { status: 503, error: detail || 'Another process holds the data files; nothing was saved. Try again once it has ended.' };
    case 'changed':
      return { status: 409, error: detail || 'This file changed while the save was being made; nothing was saved. Reload it to see the current values.' };
    case 'changed-since-open':
      return { status: 409, error: detail || 'This file changed since you opened it; nothing was saved. Reload it to see the current values.' };
    case 'disk':
      return { status: 503, error: detail || 'The disk did not take the write, so your change was not saved. Check the disk, then try again.' };
    case 'unconfirmed':
      return { status: 503, error: detail || 'Your change is not confirmed as saved yet. Please check again in a moment.' };
    case 'no-answer':
      return { status: 503, error: detail || noAnswerText('failed', 'write') };
    case 'no-holder':
      return { status: 503, error: detail || "No machine runs this server's shard right now; nothing was saved. Try again in a moment." };
    case 'not-taken':
      return { status: 503, error: detail || 'The machine that runs this server did not apply the change; nothing was saved. Try again in a moment.' };
    case 'insecure-transport':
      return { status: 503, error: detail || "This machine's database address does not check the database's certificate, so changes to servers other machines run are off; nothing was saved. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL." };
    case 'restoring':
      return { status: 503, error: detail || RESTORE_RUNNING_WRITE };
    case 'answer-too-large':
      return { status: 502, error: detail || 'The answer from the machine that runs this server is too large to pass between machines.' };
    default:
      return null;
  }
}

/** The can't-confirm text of a change the bot never answered: what names a write, a file delete or a server's data delete. */
export function noAnswerText(cause: unknown, what: 'write' | 'delete' | 'guild-delete'): string {
  const lead = cause === 'timeout' ? 'The bot did not answer in time' : cause === 'stopped' ? 'The bot stopped before answering' : 'The bot did not answer';
  const outcome = what === 'delete'
    ? "can't confirm whether the file was deleted"
    : what === 'guild-delete'
      ? "can't confirm whether this server's data was deleted"
      : "can't confirm whether the change was saved";
  return `${lead}; ${outcome}. Reload to check.`;
}

/** A shared op's or guild write's reply as HTTP: noAnswer first, then the codes above; null for an ok reply. */
export function sharedOpFailure(reply: any, what: 'write' | 'delete' | 'guild-delete' = 'write'): HopFailure | null {
  if (reply && reply.noAnswer) {
    const sentence = typeof reply.providerSentence === 'string' ? ` ${reply.providerSentence}` : '';
    return { status: 503, error: `${noAnswerText(reply.noAnswer, what)}${sentence}` };
  }
  if (reply && reply.ok) return null;
  const detail = reply && typeof reply.error === 'string' ? reply.error : undefined;
  const failure = hopFailure(reply?.code, detail);
  if (failure) return typeof reply?.status === 'number' ? { status: reply.status, error: failure.error } : failure;
  if (reply?.code === 'invalid') return { status: 400, error: detail || 'Invalid request' };
  return { status: 500, error: detail || 'The change failed' };
}

/**
 * A payment webhook's answer to the provider from the payment.webhook op's reply: 200 once applied, 404 for a provider
 * the executor does not know, 400 for the handler's own error, 503 otherwise so the provider delivers it again.
 */
export function webhookAnswer(reply: any): { status: number; body: Record<string, unknown>; log?: string } {
  if (reply?.ok) return { status: 200, body: { received: true } };
  if (reply?.code === 'invalid' && typeof reply.error === 'string' && reply.error.startsWith('Unknown provider or no webhook handler')) {
    return { status: 404, body: { error: reply.error } };
  }
  if (reply?.code === 'invalid') return { status: 400, body: { error: reply.error || 'Webhook handling failed' }, log: `failed: ${reply.error}` };
  const failure = sharedOpFailure(reply);
  return { status: 503, body: { error: failure?.error ?? 'Webhook not applied' }, log: `not applied: ${failure?.error ?? 'unknown outcome'}` };
}

/** Thrown once a shared op's failure was answered, so the route's own catch sends nothing more. */
export class SharedOpAnswered extends Error {}

/** Runs a premium or Dummy op through BotManager and answers its failure; resolves with the op's result when ok. */
export function sharedOpRunner(botManager: { runSharedOp(op: string, args: unknown): Promise<any> }) {
  return async (res: { status(code: number): { json(body: unknown): unknown } }, op: string, args: unknown[]): Promise<any> => {
    const reply = await botManager.runSharedOp(op, { args });
    const failure = sharedOpFailure(reply);
    if (!failure) return reply?.result;
    res.status(failure.status).json({ success: false, error: failure.error });
    throw new SharedOpAnswered(failure.error);
  };
}
