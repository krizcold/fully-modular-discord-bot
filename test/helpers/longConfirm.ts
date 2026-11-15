// The operator route's 8 s bound and what the reply gate has left of CONFIRM_MS: a loaded machine can pass them before the answer.
export const LONG_CONFIRM_FROM_MS = 7000;
export const LONG_CONFIRM_MS = 20_000;

type Confirms = { confirmWrite: (ticket: never, deadlineMs: number) => Promise<unknown> };

export function longConfirm<T extends Confirms>(real: T): T {
  const confirmWrite = real.confirmWrite;
  const stretched = (ticket: never, deadlineMs: number) => confirmWrite(ticket, deadlineMs >= LONG_CONFIRM_FROM_MS ? LONG_CONFIRM_MS : deadlineMs);
  return { ...real, confirmWrite: stretched as T['confirmWrite'] };
}
