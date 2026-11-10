// The records of what each mirror holds (NB6 decisions 21, 43 and 49, C23's main tag): the writer lock holder's record
// of the shared docs, and the store's record of the App Store docs and modules, kept under the store lock. Each is
// local to its machine and written whole after each entry changes.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { atomicWriteFileSync } from './atomicWrite';

/** A doc mirror's entry: the row version this machine last applied, the file's stamp, and the main tag it came from. */
export interface DocEntry {
  sha: string;
  /** `<mtimeMs>:<ctimeMs>:<size>:<ino>`, written only by the racy-clean rule of decision 49; null makes the next pass hash. */
  stamp: string | null;
  /** `"<generation>:<machine>"`, or "0" at generation 0; null when the web UI wrote it with no tag (C23). */
  main: string | null;
}

/** A module apply under way (decisions 43, 58 and 66): written before any folder is touched, cleared by its last write. */
export interface ApplyingIntent {
  from: string;
  to: string;
  /** Where step 3 moved the live source folder; null when there was none. */
  backup: string | null;
  displaced: 'backups' | 'superseded' | 'orphan';
  /** The change's main tag: every entry the apply writes takes it. */
  tag: string | null;
  /** The `shared_modules` row's version and updated_by for `to`; null for a removal. */
  version: string | null;
  updatedBy: string | null;
}

/** Decision 59: the module sha the dist was compiled from, and the image build it was compiled on. */
export interface BuiltMark {
  sha: string;
  buildId: string | null;
}

/** Decision 83: a `shared_module_status` upsert not yet answered. */
export interface PendingStatus {
  state: 'applied' | 'failed';
  sha: string;
  error: string | null;
  at: string;
  seq: number;
}

export interface ModuleEntry {
  sha: string;
  stamp: string | null;
  files: Record<string, { stamp: string | null; sha: string }>;
  main: string | null;
  /** null forces a compile (decision 59's `builtCurrent`). */
  built: BuiltMark | null;
  /** T19: the sha and image build on which the module's own files did not compile; the boot compiles it again when either changes. */
  noCompile?: (BuiltMark & { error: string }) | null;
  failedSha: string | null;
  /** Date.now() before which the pass leaves the module alone, after a compile that failed naming no file. */
  retryAt: number | null;
  /** Decision 80: a version held back in place after it stopped the bot twice while it started. */
  heldSha?: string | null;
  status?: PendingStatus | null;
  applying?: ApplyingIntent | null;
}

export interface DocRecord {
  docs: Record<string, DocEntry>;
}

export interface StoreRecord {
  docs: Record<string, DocEntry>;
  modules: Record<string, ModuleEntry>;
  /** Decision 83: raised by every entry write that sets a status; absent reads 0. */
  statusSeq?: number;
}

export const docRecordPath = (): string => dataPath('.shared-mirror.json');
export const storeRecordPath = (): string => dataPath('global', 'appstore', 'cache', '.shared-mirror.json');

/** A record read whole: an absent file is an empty record; one that cannot be read or parsed answers why. */
export type RecordRead<R> = { ok: true; record: R } | { ok: false; reason: string };

function readRecord<R>(file: string, empty: () => R, shape: (parsed: any) => boolean): RecordRead<R> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: true, record: empty() };
    return { ok: false, reason: `${file} could not be read (${code ?? String(error)})` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${file} is not JSON` };
  }
  if (!shape(parsed)) return { ok: false, reason: `${file} does not hold a record` };
  return { ok: true, record: parsed as R };
}

const isMap = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

export function readDocRecord(): RecordRead<DocRecord> {
  return readRecord(docRecordPath(), () => ({ docs: {} }), parsed => isMap(parsed) && isMap(parsed.docs));
}

export function writeDocRecord(record: DocRecord): void {
  atomicWriteFileSync(docRecordPath(), JSON.stringify(record, null, 2), undefined, { chain: false });
}

export function readStoreRecord(): RecordRead<StoreRecord> {
  return readRecord(storeRecordPath(), () => ({ docs: {}, modules: {} }), parsed => isMap(parsed) && isMap(parsed.docs) && isMap(parsed.modules));
}

export function writeStoreRecord(record: StoreRecord): void {
  atomicWriteFileSync(storeRecordPath(), JSON.stringify(record, null, 2), undefined, { chain: false });
}
