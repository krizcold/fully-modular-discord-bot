// NB9 19, 37, 51 and 60: the manager's memory reading. The web UI's hook checks the body with checkMemoryReading; the
// bot process (and a standby) checks the message the web UI pushes with checkMemoryMessage and keeps the last good one
// for its heartbeat.

const INT_MAX = 2147483647;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const ROOM_TEXT = 'room must be true, false or null';
export const MB_TEXT = 'useMb and freeMb must be whole numbers from 0 to 2147483647, or null';
export const AT_TEXT = 'at must be an ISO 8601 date';
export const ERROR_TEXT = 'error must be a string or absent';
export const AGE_TEXT = 'ageMs must be a number of 0 or more';

export const refusedLine = (text: string): string => `[Memory] Refused a memory reading from the manager: ${text}`;
export const ignoredLine = (text: string): string => `[Shards] Ignored a memory reading from the web UI process: ${text}`;

const megabytes = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= INT_MAX);

/** The rules the hook's body and the pushed message share: room, the two sizes and error. */
function sharedRules(body: Record<string, unknown>): string | null {
  if (body.room !== true && body.room !== false && body.room !== null) return ROOM_TEXT;
  if (!megabytes(body.useMb) || !megabytes(body.freeMb)) return MB_TEXT;
  return null;
}

const errorRule = (body: Record<string, unknown>): string | null =>
  body.error === undefined || typeof body.error === 'string' ? null : ERROR_TEXT;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The hook's body `{ room, useMb, freeMb, at, error? }`: the text of the first rule it breaks, or null. */
export function checkMemoryReading(value: unknown): string | null {
  const body = asRecord(value);
  const shared = sharedRules(body);
  if (shared) return shared;
  if (typeof body.at !== 'string' || !ISO_DATE.test(body.at) || !Number.isFinite(Date.parse(body.at))) return AT_TEXT;
  return errorRule(body);
}

/** The pushed message `{ room, useMb, freeMb, error?, ageMs }`: the text of the first rule it breaks, or null. */
export function checkMemoryMessage(value: unknown): string | null {
  const body = asRecord(value);
  const shared = sharedRules(body) ?? errorRule(body);
  if (shared) return shared;
  return typeof body.ageMs === 'number' && Number.isFinite(body.ageMs) && body.ageMs >= 0 ? null : AGE_TEXT;
}

export interface MemoryMessage {
  room: boolean | null;
  useMb: number | null;
  freeMb: number | null;
  error?: string;
  ageMs: number;
}

const monoMs = (): number => performance.now();

let kept: (MemoryMessage & { arrivedMs: number }) | null = null;

/** Keeps a message that passes the check; one that fails replaces nothing and is logged. */
export function keepMemoryMessage(value: unknown, log: Pick<Console, 'warn'> = console): boolean {
  const refused = checkMemoryMessage(value);
  if (refused) {
    log.warn(ignoredLine(refused));
    return false;
  }
  const m = value as MemoryMessage;
  kept = {
    room: m.room, useMb: m.useMb, freeMb: m.freeMb, ageMs: m.ageMs, arrivedMs: monoMs(),
    ...(typeof m.error === 'string' ? { error: m.error } : {}),
  };
  return true;
}

/** The kept reading as the heartbeat writes it, its age moved on by the time since it arrived; null with none. */
export function heartbeatMemory(): { room: boolean | null; freeMb: number | null; useMb: number | null; error: string | null; ageMs: number } | null {
  if (!kept) return null;
  return {
    room: kept.room, freeMb: kept.freeMb, useMb: kept.useMb, error: kept.error ?? null,
    ageMs: kept.ageMs + Math.max(monoMs() - kept.arrivedMs, 0),
  };
}

let ipcInstalled = false;

/** The bot process's and the standby's listener for 'memory:reading', installed before anything else waits. */
export function setupMemoryIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  process.on('message', (message: unknown) => {
    const m = message as { type?: unknown; data?: unknown } | null;
    if (!m || typeof m !== 'object' || m.type !== 'memory:reading') return;
    keepMemoryMessage(m.data);
  });
}

/** Tests only. */
export function _resetMemoryReading(): void {
  kept = null;
}
