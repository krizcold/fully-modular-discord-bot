// The rules for what the data layer can store on both backends (NB12): the value's form (V), the text (T), the
// size (S), the key's form (K) and the key's placement among a guild's other keys (P, KeyTree). Pure: no import from
// the data layer.

export const STORE_MAX_BYTES = 4 * 1024 * 1024;
export const SEGMENT_MAX_BYTES = 200;
export const KEY_MAX_BYTES = 1024;
export const FLUSH_STATEMENT_BYTES = 4 * 1024 * 1024;
export const FLUSH_BOUND_BYTES_PER_S = 6553;
export const FLUSH_WIRE_MAX = 8;
export const FLUSH_BASE_TIMEOUT_MS = 30_000;

const MIB = 1024 * 1024;

/** Two names this fold makes equal are one name on a case-insensitive disk (NTFS merges every pair either case mapping merges). */
export function fold(s: string): string {
  return s.toLowerCase().toUpperCase().toLowerCase();
}

const hex = (code: number): string => code.toString(16).toUpperCase().padStart(4, '0');

/** The first U+0000 or unpaired surrogate of s, as a reason; null when s has neither. */
function badCharacter(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return `it holds U+0000 at character ${i}, which the database cannot store`;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return `it holds an unpaired surrogate (U+${hex(c)}) at character ${i}, which no store keeps as written`;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return `it holds an unpaired surrogate (U+${hex(c)}) at character ${i}, which no store keeps as written`;
    }
  }
  return null;
}

/** Rule T: an append line or a raw text must be a string with no U+0000 and no unpaired surrogate. */
export function textRefusal(text: unknown, noun: 'line' | 'text' = 'line'): string | null {
  if (typeof text !== 'string') return `the ${noun} is not a string`;
  return badCharacter(text);
}

/** Rule S: at most cap bytes of UTF-8. */
export function sizeRefusal(text: string, cap = STORE_MAX_BYTES): string | null {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= cap) return null;
  const mib = Math.ceil((bytes / MIB) * 100) / 100;
  return `it is ${mib} MiB; one write holds at most ${Math.round((cap / MIB) * 100) / 100} MiB`;
}

/** Rule V: the value's JSON text, as the facade stores it, or why it has none. */
export function valueText(data: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  let text: unknown;
  try {
    text = JSON.stringify(data, null, 2);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { ok: false, reason: `the value cannot be written as JSON (${message})` };
  }
  if (typeof text !== 'string') return { ok: false, reason: 'the value has no JSON form (it is undefined, a function or a symbol)' };
  return { ok: true, text };
}

/** Bytes from outside the process (a bundle record, a file a migration reads): strict UTF-8, a BOM kept, no U+0000. */
export function decodeStorable(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'it is not valid UTF-8 text' };
  }
  const nul = text.indexOf('\u0000');
  if (nul >= 0) return { ok: false, reason: `it holds U+0000 at character ${nul}, which the database cannot store` };
  return { ok: true, text };
}

/** A guild key in path form: 'module/filename', or 'filename' for a key at the guild folder's root. */
export function pathKeyOf(module: string, filename: string): string {
  return module ? `${module}/${filename}` : filename;
}

const RESERVED = '<>:"|?*';
const DEVICES = new Set(['con', 'prn', 'aux', 'nul', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(n => [`com${n}`, `lpt${n}`])]);
const GRAVEYARD_NOTE = '.graveyard.json';

function segmentRefusal(seg: string): string | null {
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c <= 0x1f) return `the part "${printable(seg)}" holds the control character U+${hex(c)}, which a file name cannot hold`;
    if (RESERVED.includes(seg[i])) return `the part "${seg}" holds "${seg[i]}", which a Windows file name cannot hold`;
  }
  const surrogate = badCharacter(seg);
  if (surrogate) return `the part "${printable(seg)}" holds an unpaired surrogate, which no store keeps as written`;
  const bytes = Buffer.byteLength(seg, 'utf8');
  if (bytes > SEGMENT_MAX_BYTES) return `the part "${seg.slice(0, 40)}..." is ${bytes} bytes; one part of a key holds at most ${SEGMENT_MAX_BYTES}`;
  if (seg.endsWith('.')) return `the part "${seg}" ends in ".", which Windows drops from a file name`;
  if (seg.endsWith(' ')) return `the part "${seg}" ends in a space, which Windows drops from a file name`;
  if (seg.endsWith('.tmp')) return `the part "${seg}" ends in ".tmp", which marks an interrupted write`;
  const folded = fold(seg);
  const dot = folded.indexOf('.');
  const base = dot < 0 ? folded : folded.slice(0, dot);
  if (DEVICES.has(base)) return `the part "${seg}" is the Windows device name ${base.toUpperCase()}`;
  return null;
}

function printable(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c <= 0x1f || (c >= 0xd800 && c <= 0xdfff) ? `\\u${hex(c)}` : s[i];
  }
  return out;
}

/**
 * Rule K on a canonical key in path form: each part, the whole key and, for a write that names one, its kind (a save
 * never ends in .jsonl, an append always does). null when the key passes.
 */
export function keyRefusal(pathKey: string, kind?: 'save' | 'append'): string | null {
  const segments = pathKey.split('/');
  for (const seg of segments) {
    const refusal = segmentRefusal(seg);
    if (refusal) return refusal;
  }
  const bytes = Buffer.byteLength(pathKey, 'utf8');
  if (bytes > KEY_MAX_BYTES) return `the key is ${bytes} bytes; a key holds at most ${KEY_MAX_BYTES}`;
  if (fold(segments[0]) === GRAVEYARD_NOTE) return `it starts with "${segments[0]}", the name of the note a guild's retire writes`;
  const last = segments[segments.length - 1];
  if (kind === 'save' && last.endsWith('.jsonl')) return 'a .jsonl file is written by appends only';
  if (kind === 'append' && !last.endsWith('.jsonl')) return 'an appended file must end in .jsonl';
  return null;
}

/**
 * Rule K and the kind rule on a key below /data/global/ (NB6 decision 18): each part, the whole key as 'global/<rel>'
 * and, for a write that names one, its kind. null when the key passes.
 */
export function globalKeyRefusal(rel: string, kind?: 'save' | 'append'): string | null {
  const segments = rel.split('/');
  for (const seg of segments) {
    const refusal = segmentRefusal(seg);
    if (refusal) return refusal;
  }
  const bytes = Buffer.byteLength(`global/${rel}`, 'utf8');
  if (bytes > KEY_MAX_BYTES) return `the key is ${bytes} bytes; a key holds at most ${KEY_MAX_BYTES}`;
  const last = segments[segments.length - 1];
  if (kind === 'save' && last.endsWith('.jsonl')) return 'a .jsonl file is written by appends only';
  if (kind === 'append' && !last.endsWith('.jsonl')) return 'an appended file must end in .jsonl';
  return null;
}

/** Rule T for a raw text or a line of no guild, as textRefusal; its tables keep bytes, so U+0000 is named without a store's limit (NB6 C12). */
export function globalTextRefusal(text: unknown, noun: 'line' | 'text' = 'text'): string | null {
  if (typeof text !== 'string') return `the ${noun} is not a string`;
  const nul = text.indexOf('\u0000');
  const other = badCharacter(nul < 0 ? text : text.slice(0, nul));
  if (other) return other;
  return nul < 0 ? null : `it holds U+0000 at character ${nul}`;
}

/** Why a key cannot be placed beside the tree's keys, and the stored key or folder in its way. */
export interface Collision {
  reason: string;
  /** The stored spelling in the way. */
  entry: string;
  entryKind: 'file' | 'folder';
}

function foldersOf(key: string): string[] {
  const out: string[] = [];
  let at = key.indexOf('/');
  while (at >= 0) {
    out.push(key.slice(0, at));
    at = key.indexOf('/', at + 1);
  }
  return out;
}

const firstOf = <T>(set: Iterable<T>): T => set[Symbol.iterator]().next().value as T;

/**
 * Rule P's index: a guild's live keys in path form as a multiset of exact spellings. Each folded key maps to its
 * exact keys, each folded folder to its exact spellings with the number of keys below each. A folder is in it only
 * while a key lies below it.
 */
export class KeyTree {
  private readonly files = new Map<string, Set<string>>();
  private readonly folders = new Map<string, Map<string, number>>();

  get size(): number {
    let n = 0;
    for (const set of this.files.values()) n += set.size;
    return n;
  }

  has(key: string): boolean {
    return this.files.get(fold(key))?.has(key) ?? false;
  }

  /** Every exact key, for a test or a walk. */
  keys(): string[] {
    return [...this.files.values()].flatMap(set => [...set]);
  }

  /** Whether an exact folder spelling has a key below it. */
  hasFolder(folder: string): boolean {
    return this.folders.get(fold(folder))?.has(folder) ?? false;
  }

  /** Whether a key equal to this one under the fold is held, in any spelling. */
  hasFoldedKey(key: string): boolean {
    return this.files.has(fold(key));
  }

  /** Whether a folder equal to this one under the fold has a key below it, in any spelling. */
  hasFoldedFolder(folder: string): boolean {
    return this.folders.has(fold(folder));
  }

  /** Adds the key whatever it collides with; answers the collision check made before it, null for none. */
  add(key: string): Collision | null {
    if (this.has(key)) return null;
    const collision = this.check(key);
    const folded = fold(key);
    let exact = this.files.get(folded);
    if (!exact) {
      exact = new Set();
      this.files.set(folded, exact);
    }
    exact.add(key);
    for (const folder of foldersOf(key)) {
      const f = fold(folder);
      let spellings = this.folders.get(f);
      if (!spellings) {
        spellings = new Map();
        this.folders.set(f, spellings);
      }
      spellings.set(folder, (spellings.get(folder) ?? 0) + 1);
    }
    return collision;
  }

  remove(key: string): void {
    const folded = fold(key);
    const exact = this.files.get(folded);
    if (!exact?.delete(key)) return;
    if (exact.size === 0) this.files.delete(folded);
    for (const folder of foldersOf(key)) {
      const f = fold(folder);
      const spellings = this.folders.get(f);
      if (!spellings) continue;
      const left = (spellings.get(folder) ?? 0) - 1;
      if (left > 0) spellings.set(folder, left);
      else spellings.delete(folder);
      if (spellings.size === 0) this.folders.delete(f);
    }
  }

  /**
   * Rule P for a save or append of key: null when it is stored under this exact spelling (an overwrite) or fits
   * beside the tree's keys; otherwise the collision.
   */
  check(key: string): Collision | null {
    if (this.has(key)) return null;
    for (const folder of foldersOf(key)) {
      const f = fold(folder);
      const files = this.files.get(f);
      if (files?.has(folder)) return { reason: `the folder ${folder} of it is a file`, entry: folder, entryKind: 'file' };
      const spellings = this.folders.get(f);
      if (spellings?.has(folder)) continue;
      if (files) {
        const other = firstOf(files);
        return { reason: `it differs only in letter case from ${other}`, entry: other, entryKind: 'file' };
      }
      if (spellings) {
        const other = firstOf(spellings.keys());
        return { reason: `it differs only in letter case from ${other}`, entry: other, entryKind: 'folder' };
      }
    }
    const folded = fold(key);
    const spellings = this.folders.get(folded);
    if (spellings) {
      if (spellings.has(key)) return { reason: `${key} names a folder that holds other keys`, entry: key, entryKind: 'folder' };
      const other = firstOf(spellings.keys());
      return { reason: `it differs only in letter case from ${other}`, entry: other, entryKind: 'folder' };
    }
    const files = this.files.get(folded);
    if (files) {
      const other = firstOf(files);
      return { reason: `it differs only in letter case from ${other}`, entry: other, entryKind: 'file' };
    }
    return null;
  }
}

/** The flush's server bound, in ms, for a batch whose largest statement carries this many bytes of UTF-8. */
export function flushBoundMs(largestStatementBytes: number): number {
  return FLUSH_BASE_TIMEOUT_MS + 1000 * Math.ceil(Math.max(0, largestStatementBytes) / FLUSH_BOUND_BYTES_PER_S);
}

/** Cuts text into pieces of at most maxBytes of UTF-8, in order, only between code points. */
export function utf8Pieces(text: string, maxBytes = FLUSH_STATEMENT_BYTES): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const units = pair ? 2 : 1;
    const size = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + size > maxBytes && i > start) {
      pieces.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += units;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}
