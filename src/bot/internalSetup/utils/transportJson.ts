// One serializer for every answer that leaves a bot process (NB15 decision 10): the IPC listeners and the holder's
// answer write. A BigInt is written as its decimal string and a value that is one of its own ancestors as
// "[Circular]"; an answer that still cannot be serialized, or is over the limit, loses its payload with the reason.

export const ANSWER_LIMIT_BYTES = 256 * 1024;
const STRING_MAX = 2000;
const CUT_FIELDS = ['error', 'handlerError', 'note'];
const PAYLOAD_FIELDS = ['data', 'channels', 'roles', 'panels', 'guilds'];

export type DropReason = 'too-large' | 'not-serializable';

function replacer(): (this: any, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: any, _key: string, value: unknown) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);
    return value;
  };
}

export function transportStringify(value: unknown): string {
  return JSON.stringify(value, replacer()) ?? 'null';
}

/** A string field cut to 2000 characters, as every kept answer field is. */
export const cutString = (text: string): string => (text.length > STRING_MAX ? `${text.slice(0, STRING_MAX - 3)}...` : text);

function cutStrings(answer: Record<string, unknown>): Record<string, unknown> {
  const out = { ...answer };
  for (const field of CUT_FIELDS) if (typeof out[field] === 'string') out[field] = cutString(out[field] as string);
  return out;
}

/** The answer without its payload: only strings, numbers and booleans, and the record of what was dropped. */
function shrink(answer: Record<string, unknown>, bytes: number, reason: DropReason): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys: string[] = [];
  try {
    keys = Object.keys(answer);
  } catch { /* an answer whose keys cannot be read keeps only the drop record */ }
  for (const key of keys) {
    let value: unknown;
    try {
      value = answer[key];
    } catch {
      continue;
    }
    if (typeof value === 'string') out[key] = cutString(value);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') out[key] = value;
  }
  let captured: unknown;
  try {
    captured = answer.captured;
  } catch {
    captured = undefined;
  }
  if (captured !== undefined) {
    out.capturedOmitted = { count: Array.isArray(captured) ? captured.length : 0, bytes, reason };
  } else {
    out.oversize = { bytes, reason };
  }
  if (typeof out.success !== 'boolean') out.success = false;
  return out;
}

/**
 * The answer as an object that serializes without a throw, with its serialized text. limit: the most UTF-8 bytes the
 * text may hold (none for the IPC listeners).
 */
export function toTransport(answer: unknown, limit: number | null = null): { answer: Record<string, unknown>; text: string } {
  if (!answer || typeof answer !== 'object') {
    const text = transportStringify({ success: false, error: 'The bot gave no answer.' });
    return { answer: JSON.parse(text), text };
  }
  const source = answer as Record<string, unknown>;
  let text: string | null = null;
  let reason: DropReason = 'not-serializable';
  let bytes = 0;
  try {
    text = transportStringify(cutStrings(source));
    bytes = Buffer.byteLength(text, 'utf8');
    if (limit !== null && bytes > limit) {
      reason = 'too-large';
      text = null;
    }
  } catch {
    text = null;
  }
  if (text !== null) return { answer: JSON.parse(text), text };
  const kept: Record<string, unknown> = {};
  let keys: string[] = [];
  try {
    keys = Object.keys(source);
  } catch { /* nothing kept */ }
  for (const key of keys) if (!PAYLOAD_FIELDS.includes(key)) {
    try {
      kept[key] = source[key];
    } catch { /* a getter that throws is dropped */ }
  }
  const small = shrink(kept, bytes, reason);
  const smallText = JSON.stringify(small);
  return { answer: JSON.parse(smallText), text: smallText };
}
