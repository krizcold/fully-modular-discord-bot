// The mirror of the shared docs on a Postgres bot (NB6 decisions 9, 11, 14, 21, 29, 30 and 49; C24, C25, D4, E3): the
// pass that brings each mirror file to its row, run at the boot, every 60 s, when the listener connects and for each
// key another process changed; the boot's wait for it; and the stop step that ends the pass and the listener. The
// records are sharedRecords.ts's; the flush's own mirror write is sharedStore.ts's, under the same per-key mutex.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { resolveDataBackend } from '../../../utils/envLoader';
import { getGuildDataBackend, isStopping, runSharedAppliedHooks } from './dataManager';
import { atomicReplace } from './dataBackends/fileBackend';
import { databaseView, mainTagOf } from './dataBackends/mainDatabase';
import { PostgresBackend } from './dataBackends/postgresBackend';
import { atomicWriteFileSync } from './atomicWrite';
import { docRecordPath, readDocRecord, readStoreRecord, storeRecordPath, writeDocRecord, writeStoreRecord, type DocEntry, type DocRecord, type RecordRead } from './sharedRecords';
import { startSharedListener, stopSharedListener } from './sharedListener';
import { dropOwedStoreDoc, isLinesKey, mirrorPathOf, onRowKeySettled, ROOT_CONFIG_KEY, rowBackend, rowQueue, setCheckedKeyApplier, shaOf, sharedKeyFor, STORE_MUTEX_MS, storeLandingOf, withMirrorLock } from './sharedStore';

const READ_BOUND_MS = 10_000;
const PASS_EVERY_MS = 60_000;
const REHASH_EVERY = 60;
const BOOT_RETRY_MS = 5000;
const BOOT_LOG_MS = 30_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const RACY_MS = 2000;

const LIST_SQL = 'SELECT key, sha FROM smdb_data.shared_docs';
const LIST_KEYS_SQL = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const BODY_SQL = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const PRUNE_SQL = "DELETE FROM smdb_data.shared_ops WHERE at < now() - interval '7 days'";

/** answered: every read of the pass got the database's answer; cause: the last read's failure. */
export interface PassResult {
  answered: boolean;
  cause: string | null;
  /** The cause is this machine's own write of a record file, not the database's. */
  local?: true;
}

/**
 * Part 16's module step of the pass, for every module or for the named ones only; it answers false, or the read's
 * cause, when a read of the database failed.
 */
export type ModulePassStep = (pass: { tag0: string | null; rehash: boolean; at: number; modules?: string[] }) => Promise<boolean | { cause: string }>;

/** What a pass reads with: the bot's data pool, or the web UI's reader pool while its local chain holds the lock. */
interface PassSource {
  sharedSelect(text: string, values: unknown[], boundMs: number): Promise<{ rows: any[] }>;
  /** The main tag of the database it reads now. */
  tag(): string | null;
}

interface PassContext {
  backend: PassSource;
  tag0: string | null;
  generation: number | null;
  machine: string | null;
  /** The <ms> of this pass's folder under _superseded. */
  at: number;
  rehash: boolean;
  /** The listing: each key's stored sha. */
  listed: Map<string, string>;
  /** Set when refreshShared's bound answered for this pass: it writes nothing after that. */
  cut: { on: boolean };
}

let stopMark = false;
let passTimer: NodeJS.Timeout | null = null;
let passCount = 0;
let passRun: Promise<PassResult> | null = null;
let lastPruneAt: number | null = null;
let pruneRun: Promise<void> | null = null;
let bootDone = false;
let bootCause: string | null = null;
let bootCauseLocal = false;
let bootWake: (() => void) | null = null;
let unsettle: (() => void) | null = null;
let moduleStep: ModulePassStep | null = null;
/** Decision 40: premium's journal read, run after every answered full pass of the bot (bootShared's included). */
export type LinesPassStep = () => Promise<{ ok: true } | { ok: false; cause: string }>;
let linesStep: LinesPassStep | null = null;
const skipped = new Set<string>();
/** Decision 10: the last apply of each key, so every pass applies a key after the one before it ended. */
const keyRuns = new Map<string, Promise<void>>();
const keyRequests = new Set<string>();
const keyAgain = new Set<string>();
const moduleRequests = new Set<string>();
const moduleAgain = new Set<string>();
const readLogged = new Map<string, string>();
const writeLogged = new Map<string, string>();
const moveLogged = new Map<string, string>();
const stopLogged = new Set<string>();

const stopped = (): boolean => stopMark || isStopping();

function pgBackend(): PostgresBackend | null {
  const backend = getGuildDataBackend();
  return backend instanceof PostgresBackend ? backend : null;
}

function mainTag(): string | null {
  const view = databaseView();
  return view && view.generation !== null ? mainTagOf(view.generation, view.machine) : null;
}

function passSource(): PassSource | null {
  const pg = pgBackend();
  if (pg) return { sharedSelect: (text, values, boundMs) => pg.sharedSelect(text, values, boundMs), tag: mainTag };
  const rows = rowBackend();
  if (!rows?.sharedSelect) return null;
  return { sharedSelect: (text, values, boundMs) => rows.sharedSelect!(text, values, boundMs), tag: () => rows.mainTag?.() ?? null };
}

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errnoOf = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? causeOf(error);

/** Once per subject and cause: a read of the database that failed (rows 33 and 45). */
function noteReadFailed(subject: string, cause: string): void {
  if (readLogged.get(subject) === cause) return;
  readLogged.set(subject, cause);
  const what = subject === '' ? 'the shared files' : subject;
  console.error(`[Shared] Could not check ${what} against the database (${cause}); the next pass tries again`);
}

// ============================================================================
// THE PASS (decisions 21 and 49)
// ============================================================================

/** Decision 49's stamp of a file: `<mtimeMs>:<ctimeMs>:<size>:<ino>`. */
const stampText = (st: fs.Stats): string => `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

/** A mirror's content sha ('absent', 'unreadable'), from its stamp when that equals the entry's, else from its bytes. */
function contentOf(file: string, entry: DocEntry | undefined, rehash: boolean): { sha: string; stamp: string | null } {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    return { sha: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable', stamp: null };
  }
  const stamp = stampText(before);
  if (!rehash && entry?.stamp && entry.stamp === stamp) return { sha: entry.sha, stamp };
  const sha = hashOf(file);
  if (sha === 'absent' || sha === 'unreadable') return { sha, stamp: null };
  // Git's racy-clean rule: a stamp is kept only when the file did not change during the hash and is 2 s old.
  const now = Date.now();
  let after: fs.Stats | null = null;
  try {
    after = fs.lstatSync(file);
  } catch {
    after = null;
  }
  const settled = after !== null && stampText(after) === stamp && before.mtimeMs <= now - RACY_MS && before.ctimeMs <= now - RACY_MS;
  return { sha, stamp: settled ? stamp : null };
}

/** The sha of a file's bytes, read now ('absent' for none, 'unreadable' on any other error). */
function hashOf(file: string): string {
  try {
    return shaOf(fs.readFileSync(file));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/** Moves a mirror into this pass's _superseded folder by a rename; null when the rename failed (logged). */
function moveAside(file: string, key: string, ctx: PassContext): string | null {
  let dest = dataPath('_superseded', `shared-${ctx.at}`, ...key.split('/'));
  for (let n = 1; fs.existsSync(dest); n++) dest = dataPath('_superseded', `shared-${ctx.at}-${n}`, ...key.split('/'));
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    moveLogged.delete(file);
    return dest;
  } catch (error) {
    const errno = errnoOf(error);
    if (moveLogged.get(file) !== errno) {
      moveLogged.set(file, errno);
      console.error(`[Shared] Could not move ${file} aside (${errno}); left it as it is and will try again at the next pass`);
    }
    return null;
  }
}

/** T11's head of a move aside: (a) for a mirror that changed, (b) for one taken from the main before a switch. */
function movedHead(file: string, dest: string, kind: 'a' | 'b', ctx: PassContext): string {
  return kind === 'a'
    ? `[Shared] Moved ${file} to ${dest}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); `
    : `[Shared] Moved ${file} to ${dest}: it held the version this machine took from the database before the switch to ${ctx.machine ?? ''} (generation ${ctx.generation ?? 0}); `;
}

const T11_WRITTEN = "the database's version is back in its place";
const T11_NO_ROW = 'the database holds no such file, so nothing was put back';
const T11_TAG_CHANGED = 'the main database changed during this pass, so the next pass puts its version in place';
const t11WriteFailed = (errno: string): string => `the database's version could not be written (${errno}); the next pass tries again`;

/**
 * The doc record. One that cannot be read or parsed is moved into _superseded and a new, empty record is started, so
 * the pass writes every entry again (or moves a differing mirror aside); when the move fails it answers why.
 */
function docRecord(): RecordRead<DocRecord> {
  const read = readDocRecord();
  if (read.ok) return read;
  const file = docRecordPath();
  const at = Date.now();
  let dest = dataPath('_superseded', `shared-${at}`, path.basename(file));
  for (let n = 1; fs.existsSync(dest); n++) dest = dataPath('_superseded', `shared-${at}-${n}`, path.basename(file));
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
  } catch (error) {
    return { ok: false, reason: `${read.reason}, and it could not be moved aside (${errnoOf(error)})` };
  }
  readLogged.delete('record');
  const prefix = `${file} could not be read (`;
  const cause = read.reason.startsWith(prefix) ? read.reason.slice(prefix.length, -1) : `it ${read.reason.slice(file.length + 1)}`;
  console.error(`[Shared] The record of the shared files (${file}) could not be read (${cause}); it was moved to ${dest} and a new record was started`);
  return { ok: true, record: { docs: {} } };
}

/** A record file's write that threw, logged by row 34's line; the key's apply answers unanswered. */
class RecordWriteFailed extends Error {}

/** Row 34 for a record file: logs the failed write once per path and errno, then throws RecordWriteFailed. */
function recordWrite(file: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    noteWriteFailed(file, error);
    throw new RecordWriteFailed(causeOf(error));
  }
  writeLogged.delete(file);
}

/** Writes one entry of the doc record (null drops it); false when the record cannot be read. */
function setEntry(key: string, entry: DocEntry | null): boolean {
  const record = docRecord();
  if (!record.ok) {
    noteRecordFailed(record.reason);
    return false;
  }
  const docs = { ...record.record.docs };
  if (entry === null) delete docs[key];
  else docs[key] = entry;
  recordWrite(docRecordPath(), () => writeDocRecord({ ...record.record, docs }));
  return true;
}

function noteRecordFailed(reason: string): void {
  if (readLogged.get('record') === reason) return;
  readLogged.set('record', reason);
  console.error(`[Shared] Did not bring the shared files up to date: ${reason}; the next pass tries again`);
}

async function readRow(ctx: PassContext, key: string): Promise<{ body: Buffer; sha: string } | null> {
  const res = await ctx.backend.sharedSelect(BODY_SQL, [key], READ_BOUND_MS);
  readLogged.delete(key);
  const row = res.rows[0];
  if (!row) return null;
  const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(String(row.body ?? ''), 'utf8');
  return { body, sha: String(row.sha) };
}

/** cause null: the stop or refreshShared's bound ended the key's apply before it wrote; local: a record write failed. */
type KeyOutcome = { readFailed: false } | { readFailed: true; cause: string | null; local?: true };
const DONE: KeyOutcome = { readFailed: false };
const HALTED: KeyOutcome = { readFailed: true, cause: null };

function readFailed(key: string, error: unknown): KeyOutcome {
  const cause = causeOf(error);
  noteReadFailed(key, cause);
  return { readFailed: true, cause };
}

/** Decision 49's steps for one doc key, once the key's apply before it ended (decision 10: one apply per key at a time). */
function applyKey(key: string, ctx: PassContext): Promise<KeyOutcome> {
  const before = keyRuns.get(key) ?? Promise.resolve();
  const run = before.then(() => applyKeyNow(key, ctx));
  const tail = run.then(() => undefined, () => undefined);
  keyRuns.set(key, tail);
  void tail.then(() => { if (keyRuns.get(key) === tail) keyRuns.delete(key); });
  return run;
}

async function applyKeyNow(key: string, ctx: PassContext): Promise<KeyOutcome> {
  const halted = (): boolean => stopped() || ctx.cut.on;
  if (halted()) return HALTED;
  // Step 1: the op's settle runs the key again.
  if (rowQueue.ops(key).length > 0) {
    skipped.add(key);
    return DONE;
  }
  const file = mirrorPathOf(key);
  const listedSha = ctx.listed.get(key);
  const known = docRecord();
  if (!known.ok) {
    noteRecordFailed(known.reason);
    return DONE;
  }
  const knownSha = known.record.docs[key]?.sha;
  let row: { body: Buffer; sha: string } | null | undefined;
  if (listedSha !== undefined && listedSha !== knownSha) {
    try {
      row = await readRow(ctx, key);
    } catch (error) {
      return readFailed(key, error);
    }
  }
  let changed = false;
  let outcome: KeyOutcome;
  try {
    outcome = await lockedApply();
  } catch (error) {
    if (!(error instanceof RecordWriteFailed)) throw error;
    outcome = { readFailed: true, cause: error.message, local: true };
  }
  if (changed) runSharedAppliedHooks(key);
  return outcome;

  function lockedApply(): Promise<KeyOutcome> {
    return withMirrorLock(key, async (): Promise<KeyOutcome> => {
      if (halted()) return HALTED;
      if (rowQueue.ops(key).length > 0) {
        skipped.add(key);
        return DONE;
      }
      let record = docRecord();
      if (!record.ok) {
        noteRecordFailed(record.reason);
        return DONE;
      }
      // The entry moved while the row was read (this process's op, or another pass): the row is read again here.
      if (record.record.docs[key]?.sha !== knownSha) {
        try {
          row = await readRow(ctx, key);
        } catch (error) {
          return readFailed(key, error);
        }
        if (halted()) return HALTED;
        record = docRecord();
        if (!record.ok) {
          noteRecordFailed(record.reason);
          return DONE;
        }
      }
      const entry = record.record.docs[key];
      const recSha = entry?.sha ?? 'absent';
      let rowSha = row !== undefined ? row?.sha ?? 'absent' : listedSha ?? 'absent';
      let head: string | null = null;
      const log = (tail: string) => { if (head !== null) console.warn(head + tail); };
      const tagChanged = (): boolean => {
        if (ctx.backend.tag() === ctx.tag0) return false;
        log(T11_TAG_CHANGED);
        return true;
      };

      // Step 2: the content against the entry.
      const seen = contentOf(file, entry, ctx.rehash);
      let E: string;
      if (seen.sha === recSha) {
        E = recSha;
        // Step 3: the main tag the entry came from.
        if (entry && entry.main !== ctx.tag0 && rowSha !== E) {
          const dest = moveAside(file, key, ctx);
          if (dest === null) return DONE;
          head = movedHead(file, dest, 'b', ctx);
          changed = true;
          E = 'absent';
        } else if (entry && (entry.main !== ctx.tag0 || (seen.stamp !== null && seen.stamp !== entry.stamp))) {
          if (tagChanged()) return DONE;
          setEntry(key, { ...entry, main: ctx.tag0, stamp: seen.stamp ?? entry.stamp });
        }
      } else if (seen.sha === rowSha) {
        if (tagChanged()) return DONE;
        setEntry(key, rowSha === 'absent' ? null : { sha: rowSha, stamp: seen.stamp, main: ctx.tag0 });
        return DONE;
      } else {
        if (seen.sha !== 'absent') {
          const dest = moveAside(file, key, ctx);
          if (dest === null) return DONE;
          head = movedHead(file, dest, 'a', ctx);
          changed = true;
        }
        E = 'absent';
      }

      // Step 5: E against the row.
      if (E === rowSha) {
        if (E === 'absent') {
          const drop = entry !== undefined && !tagChanged();
          log(T11_NO_ROW);
          if (drop) setEntry(key, null);
        }
        return DONE;
      }
      if (rowSha === 'absent' || row === undefined) {
        try {
          row = await readRow(ctx, key);
        } catch (error) {
          log(t11WriteFailed(causeOf(error)));
          return readFailed(key, error);
        }
        // A mirror moved aside before the read still gets its row back.
        if (head === null && halted()) return HALTED;
      }
      if (row && row.sha === E) return DONE;
      if (tagChanged()) return DONE;
      const held = hashOf(file);
      if (held !== E && held !== 'absent') {
        const dest = moveAside(file, key, ctx);
        if (dest === null) return DONE;
        if (head === null) head = movedHead(file, dest, 'a', ctx);
        changed = true;
      }
      if (!row) {
        if (held === E && E !== 'absent') {
          try {
            fs.unlinkSync(file);
            changed = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              noteWriteFailed(file, error);
              return DONE;
            }
          }
        }
        log(T11_NO_ROW);
        setEntry(key, null);
        return DONE;
      }
      try {
        await atomicReplace(file, row.body);
      } catch (error) {
        if (head !== null) log(t11WriteFailed(errnoOf(error)));
        else noteWriteFailed(file, error);
        return DONE;
      }
      writeLogged.delete(file);
      changed = true;
      log(T11_WRITTEN);
      setEntry(key, { sha: row.sha, stamp: null, main: ctx.tag0 });
      return DONE;
    });
  }
}

/** Row 34: a mirror write that failed with no move aside before it, logged once per path and errno. */
function noteWriteFailed(file: string, error: unknown): void {
  const errno = errnoOf(error);
  if (writeLogged.get(file) === errno) return;
  writeLogged.set(file, errno);
  console.error(`[Shared] Could not write ${file} (${errno}); retrying`);
}

/** The keys a pass visits besides the record's and the rows': the doc files of the shared set on this machine. */
function walkKeys(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (sharedKeyFor(path.join(abs, 'x')) !== null) visit(abs);
      } else if (e.isFile() && !e.name.endsWith('.tmp')) {
        const key = sharedKeyFor(abs);
        if (key !== null) out.push(key);
      }
    }
  };
  visit(path.join(DATA_ROOT, 'global'));
  if (fs.existsSync(mirrorPathOf(ROOT_CONFIG_KEY))) out.push(ROOT_CONFIG_KEY);
  return out;
}

// App Store keys are applied by storeKeysPass, under the store lock with the store's record (decision 31); lines keys
// have no mirror (decision 8).
const isDocKey = (key: string): boolean => !isLinesKey(key) && key !== 'global/appstore' && !key.startsWith('global/appstore/');

/**
 * R5-B1: every entry point of the pass and its steps runs through here, so none rejects. A throw answers unanswered,
 * local when it is a file-system error of this machine; its line is logged once per message until a pass answers.
 */
async function passBoundary(run: () => Promise<PassResult>): Promise<PassResult> {
  let result: PassResult;
  try {
    result = await run();
  } catch (error) {
    const cause = causeOf(error);
    const fsError = error as NodeJS.ErrnoException;
    // fd-based writes and fsyncs carry no path; a database socket error carries a syscall too, so a syscall is not enough.
    const local = typeof fsError?.path === 'string' || ['ENOSPC', 'EDQUOT', 'EROFS', 'EIO'].includes(String(fsError?.code));
    // A temp file's name changes at every try, so a file-system error is keyed by its errno and call, not its message.
    const key = local ? `${fsError.code}:${fsError.syscall}` : cause;
    if (!stopLogged.has(key)) {
      stopLogged.add(key);
      console.error(`[Shared] The pass over the shared files stopped (${cause}); it tries again at the next pass`);
    }
    return local ? { answered: false, cause, local: true } : { answered: false, cause };
  }
  if (result.answered) stopLogged.clear();
  return result;
}

/** A pass that the stop or refreshShared's bound ended before it visited every key. */
const CUT_SHORT: PassResult = { answered: false, cause: null };

async function pass(keys: string[] | null, rehash: boolean, quiet: boolean, onListed?: () => void, cut: { on: boolean } = { on: false }): Promise<PassResult> {
  const backend = passSource();
  if (!backend) return { answered: false, cause: "this process has no connection to the bot's database" };
  if (stopped()) return CUT_SHORT;
  const view = databaseView();
  const ctx: PassContext = {
    backend,
    tag0: backend.tag(),
    generation: view?.generation ?? null,
    machine: view?.machine ?? null,
    at: Date.now(),
    rehash,
    listed: new Map(),
    cut,
  };
  const halted = (): boolean => stopped() || cut.on;
  try {
    const res = keys
      ? await backend.sharedSelect(LIST_KEYS_SQL, [keys], READ_BOUND_MS)
      : await backend.sharedSelect(LIST_SQL, [], READ_BOUND_MS);
    for (const row of res.rows) ctx.listed.set(String(row.key), String(row.sha));
    readLogged.delete('');
  } catch (error) {
    const cause = causeOf(error);
    if (!quiet) noteReadFailed('', cause);
    return { answered: false, cause };
  }
  onListed?.();
  const visit = new Set<string>(keys ?? []);
  if (!keys) {
    const record = docRecord();
    if (record.ok) for (const key of Object.keys(record.record.docs)) visit.add(key);
    for (const key of ctx.listed.keys()) visit.add(key);
    for (const key of walkKeys()) visit.add(key);
    if (pgBackend()) {
      const store = readStoreRecord();
      if (store.ok) for (const key of Object.keys(store.record.docs)) visit.add(key);
    }
  }
  let result: PassResult = { answered: true, cause: null };
  for (const key of [...visit].filter(isDocKey).sort()) {
    if (halted()) return CUT_SHORT;
    const outcome = await applyKey(key, ctx);
    if (outcome.readFailed && outcome.cause === null) return CUT_SHORT;
    if (outcome.readFailed) result = outcome.local ? { answered: false, cause: outcome.cause, local: true } : { answered: false, cause: outcome.cause };
  }
  // Only the bot applies App Store keys here; the web UI applies them in runStoreDocsPass (decision 31).
  const storeKeys = [...visit].filter(isStoreKey).sort();
  if (storeKeys.length > 0 && pgBackend()) {
    if (halted()) return CUT_SHORT;
    result = await botStoreKeys(storeKeys, ctx, result);
  }
  // Module folders are the bot's (decisions 31 and 44): the web UI's passes never apply a module.
  if (!keys && moduleStep && pgBackend()) {
    if (halted()) return CUT_SHORT;
    const step = await moduleStep({ tag0: ctx.tag0, rehash, at: ctx.at });
    if (step !== true) result = typeof step === 'object' ? { answered: false, cause: step.cause } : { ...result, answered: false };
  }
  return result;
}

/** Decision 24: the bot's pass deletes shared_ops rows over 7 days old, at most once an hour. */
function prune(backend: PostgresBackend): void {
  const now = Date.now();
  if (pruneRun || stopped() || (lastPruneAt !== null && now - lastPruneAt < PRUNE_EVERY_MS)) return;
  lastPruneAt = now;
  pruneRun = backend.sharedTx({ check: null, statements: () => [{ text: PRUNE_SQL, values: [] }] })
    .then(outcome => { if (outcome.kind !== 'committed') lastPruneAt = null; }, () => { lastPruneAt = null; })
    .finally(() => { pruneRun = null; });
}

async function fullPass(rehash: boolean, quiet: boolean, onListed?: () => void): Promise<PassResult> {
  passCount += 1;
  const result = await pass(null, rehash || passCount % REHASH_EVERY === 0, quiet, onListed);
  const backend = pgBackend();
  if (result.answered && backend) prune(backend);
  if (result.answered && backend && linesStep) {
    const read = await linesStep();
    if (!read.ok) return { answered: false, cause: read.cause };
  }
  return result;
}

/** One pass over every key; a call while one runs waits for it and runs one more. */
export async function runSharedPass(opts: { rehash?: boolean } = {}): Promise<PassResult> {
  while (passRun) await passRun;
  const run = passBoundary(() => fullPass(opts.rehash === true, false));
  passRun = run;
  try {
    return await run;
  } finally {
    if (passRun === run) passRun = null;
  }
}

/** The pass for some keys only: a notification's key, a settled op's key, refreshShared's keys. */
export function applySharedKeys(keys: string[]): Promise<PassResult> {
  return passBoundary(() => pass(keys, false, false));
}

/** Decision 10: one apply per key at a time; a notification during an apply runs one more after it. */
function requestKey(key: string): void {
  if (stopped()) return;
  if (keyRequests.has(key)) {
    keyAgain.add(key);
    return;
  }
  keyRequests.add(key);
  void applySharedKeys([key]).then(() => undefined, () => undefined).finally(() => {
    keyRequests.delete(key);
    if (keyAgain.delete(key)) requestKey(key);
  });
}

setCheckedKeyApplier(requestKey);

/** Another machine's 'module' notice: the module step for that module, in the pass's turn; one more after a run. */
function requestModule(module: string): void {
  if (stopped()) return;
  if (moduleRequests.has(module)) {
    moduleAgain.add(module);
    return;
  }
  moduleRequests.add(module);
  void applySharedModule(module).then(() => undefined, () => undefined).finally(() => {
    moduleRequests.delete(module);
    if (moduleAgain.delete(module)) requestModule(module);
  });
}

async function applySharedModule(module: string): Promise<void> {
  while (passRun) await passRun;
  const step = moduleStep;
  if (stopped() || !step || !pgBackend()) return;
  const run = passBoundary(async (): Promise<PassResult> => {
    const answer = await step({ tag0: mainTag(), rehash: false, at: Date.now(), modules: [module] });
    return answer === true ? { answered: true, cause: null } : { answered: false, cause: typeof answer === 'object' ? answer.cause : null };
  });
  passRun = run;
  try {
    await run;
  } finally {
    if (passRun === run) passRun = null;
  }
}

/**
 * Decision 13: brings the given keys' mirrors up to the rows before an op reads them, within 10 s; null brings every
 * key (decision 16's reconcile at the web UI chain's first op after a take). A JSON bot has nothing to bring up to date.
 * passEnd is given the promise that settles when the pass ends: a key whose mirror was moved aside before the cut is
 * still written after the answer (R2-B1), so the web UI's chain waits for it before it releases its lock.
 */
export async function refreshShared(
  keys: string[] | null,
  passEnd?: (end: Promise<void>) => void,
): Promise<{ ok: true } | { ok: false; cause: string; local?: true }> {
  if (resolveDataBackend() !== 'postgres') return { ok: true };
  let timer: NodeJS.Timeout | undefined;
  // Decision 25: once the bound answered, the pass writes nothing more but a moved-aside key's write.
  const cut = { on: false };
  const bound = new Promise<PassResult>(resolve => {
    timer = setTimeout(() => {
      cut.on = true;
      resolve({ answered: false, cause: `no answer within ${READ_BOUND_MS / 1000} s` });
    }, READ_BOUND_MS);
    timer.unref?.();
  });
  try {
    const run = passBoundary(() => pass(keys, false, false, undefined, cut));
    passEnd?.(run.then(() => undefined, () => undefined));
    const res = await Promise.race([run, bound]);
    if (res.answered) return { ok: true };
    return res.local ? { ok: false, cause: res.cause ?? '', local: true } : { ok: false, cause: res.cause ?? 'the bot process is stopping' };
  } catch (error) {
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// THE STORE DOCS' PASS (decision 31)
// ============================================================================

const isStoreKey = (key: string): boolean => key.startsWith('global/appstore/');

/** The App Store doc files on this machine: the shared keys under /data/global/appstore (its cache is local). */
function storeWalkKeys(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (sharedKeyFor(path.join(abs, 'x')) !== null) visit(abs);
      } else if (e.isFile() && !e.name.endsWith('.tmp')) {
        const key = sharedKeyFor(abs);
        if (key !== null && isStoreKey(key)) out.push(key);
      }
    }
  };
  visit(path.join(DATA_ROOT, 'global', 'appstore'));
  return out;
}

/**
 * Decision 21's steps for one App Store key, against the store record, in one synchronous section under the store
 * lock (decision 53's writer form, C10). row is the stored version, null for none; its body is null when the pass did
 * not read it (the mirror held it then). True when the mirror changed. A store record write that throws is logged by
 * row 34's line and answered to onRecordFailed.
 */
function applyStoreKey(key: string, row: { body: Buffer | null; sha: string } | null, ctx: PassContext, onRecordFailed: (cause: string) => void): boolean {
  if (rowQueue.ops(key).length > 0) return false;
  const record = readStoreRecord();
  if (!record.ok) {
    noteRecordFailed(record.reason);
    return false;
  }
  const file = mirrorPathOf(key);
  const entry = record.record.docs[key];
  const rowSha = row?.sha ?? 'absent';
  const held = hashOf(file);
  if (held === 'unreadable') {
    noteWriteFailed(file, new Error('unreadable'));
    return false;
  }
  const setEntry = (next: DocEntry | null) => {
    const docs = { ...record.record.docs };
    if (next === null) delete docs[key];
    else docs[key] = next;
    try {
      recordWrite(storeRecordPath(), () => writeStoreRecord({ ...record.record, docs }));
    } catch (error) {
      if (!(error instanceof RecordWriteFailed)) throw error;
      onRecordFailed(error.message);
    }
  };
  if (held === rowSha) {
    dropOwedStoreDoc(key);
    if (rowSha === 'absent') {
      if (entry) setEntry(null);
    } else if (entry?.sha !== rowSha || entry.main !== ctx.tag0) {
      setEntry({ sha: rowSha, stamp: null, main: ctx.tag0 });
    }
    return false;
  }
  // The mirror changed after the pass compared it: the next pass reads the row.
  if (row && row.body === null) return false;
  let head: string | null = null;
  const recSha = entry?.sha ?? 'absent';
  if (held !== 'absent' && (held !== recSha || (entry !== undefined && entry.main !== ctx.tag0))) {
    const dest = moveAside(file, key, ctx);
    if (dest === null) return false;
    head = movedHead(file, dest, held !== recSha ? 'a' : 'b', ctx);
  }
  try {
    if (row) atomicWriteFileSync(file, row.body!);
    else if (head === null) fs.unlinkSync(file);
  } catch (error) {
    if (head !== null) console.warn(head + t11WriteFailed(errnoOf(error)));
    else noteWriteFailed(file, error);
    return head !== null;
  }
  writeLogged.delete(file);
  dropOwedStoreDoc(key);
  if (head !== null) console.warn(head + (row ? T11_WRITTEN : T11_NO_ROW));
  setEntry(row ? { sha: row.sha, stamp: null, main: ctx.tag0 } : null);
  return true;
}

/** runStoreDocsPass's cause when the main tag changed during the pass: the database answered. */
export const STORE_DOCS_TAG_CHANGED = 'the main database changed during the pass';

/**
 * Decision 31: the web UI's pass of the App Store docs while no bot child runs, its rows read on the reader pool. The
 * caller holds the store mutex; locked runs a synchronous section under the store lock. Answers the first failed read's
 * cause; a key whose read failed is left as it is.
 */
export async function runStoreDocsPass(locked: <T>(fn: () => T) => T): Promise<{ ok: true } | { ok: false; cause: string; local?: true }> {
  const done: { out?: { ok: true } | { ok: false; cause: string; local?: true } } = {};
  const res = await passBoundary(async () => {
    const out = await storeDocsPass(locked);
    done.out = out;
    return out.ok ? { answered: true, cause: null } : { answered: false, cause: out.cause };
  });
  if (done.out) return done.out;
  return res.local ? { ok: false, cause: res.cause ?? '', local: true } : { ok: false, cause: res.cause ?? '' };
}

async function storeDocsPass(locked: <T>(fn: () => T) => T): Promise<{ ok: true } | { ok: false; cause: string; local?: true }> {
  const backend = passSource();
  if (!backend) return { ok: false, cause: "this process has no connection to the bot's database" };
  const view = databaseView();
  const ctx: PassContext = {
    backend,
    tag0: backend.tag(),
    generation: view?.generation ?? null,
    machine: view?.machine ?? null,
    at: Date.now(),
    rehash: true,
    listed: new Map(),
    cut: { on: false },
  };
  try {
    const res = await backend.sharedSelect(LIST_SQL, [], READ_BOUND_MS);
    for (const row of res.rows) ctx.listed.set(String(row.key), String(row.sha));
  } catch (error) {
    return { ok: false, cause: causeOf(error) };
  }
  const visit = new Set<string>([...ctx.listed.keys()].filter(isStoreKey));
  const record = readStoreRecord();
  if (record.ok) for (const key of Object.keys(record.record.docs)) visit.add(key);
  for (const key of storeWalkKeys()) visit.add(key);
  let failed: { ok: false; cause: string; local?: true } | null = null;
  const end = await storeKeysPass(
    [...visit].filter(isStoreKey).sort(),
    ctx,
    locked,
    error => { failed ??= { ok: false, cause: causeOf(error) }; },
    cause => { failed ??= { ok: false, cause, local: true }; },
  );
  if (end === 'tag-changed') return { ok: false, cause: STORE_DOCS_TAG_CHANGED };
  return failed ?? { ok: true };
}

/**
 * Decision 31's steps for these App Store keys, in order; the caller holds the store mutex. A key with an op of this
 * process is left to the op; a key whose read failed is left as it is. 'tag-changed' when the main tag changed.
 */
async function storeKeysPass(
  keys: string[],
  ctx: PassContext,
  locked: <T>(fn: () => T) => T,
  onReadFailed: (error: unknown, key: string) => void,
  onRecordFailed: (cause: string, key: string) => void,
): Promise<'done' | 'tag-changed'> {
  for (const key of keys) {
    if (rowQueue.ops(key).length > 0) {
      skipped.add(key);
      continue;
    }
    const listedSha = ctx.listed.get(key);
    let row: { body: Buffer | null; sha: string } | null = null;
    if (listedSha !== undefined && listedSha !== hashOf(mirrorPathOf(key))) {
      try {
        row = await readRow(ctx, key);
      } catch (error) {
        onReadFailed(error, key);
        continue;
      }
    } else if (listedSha !== undefined) {
      row = { body: null, sha: listedSha };
    }
    if (ctx.backend.tag() !== ctx.tag0) return 'tag-changed';
    if (locked(() => applyStoreKey(key, row, ctx, cause => onRecordFailed(cause, key)))) runSharedAppliedHooks(key);
  }
  return 'done';
}

/**
 * Decision 31's half in the bot: the pass's App Store keys under the store mutex and the store lock (36). A mutex
 * busy past its bound leaves them to the next pass.
 */
async function botStoreKeys(keys: string[], ctx: PassContext, result: PassResult): Promise<PassResult> {
  const landing = storeLandingOf();
  const hold = landing ? await landing.acquire(STORE_MUTEX_MS) : null;
  if (landing && !hold) return result;
  let out = result;
  try {
    const locked = <T>(fn: () => T): T => (landing ? landing.locked(fn) : fn());
    await storeKeysPass(keys, ctx, locked, (error, key) => {
      const failed = readFailed(key, error);
      if (failed.readFailed) out = { answered: false, cause: failed.cause };
    }, cause => {
      out = { answered: false, cause, local: true };
    });
  } finally {
    hold?.release();
  }
  return out;
}

/** PremiumManager sets its journal read here (decision 40); null removes it. */
export function setSharedLinesPassStep(step: LinesPassStep | null): void {
  linesStep = step;
}

/** Part 16 adds the pass's module step here. */
export function setSharedModulePassStep(step: ModulePassStep | null): void {
  moduleStep = step;
}

// ============================================================================
// THE BOOT, THE TIMER AND THE STOP (decision 14, C24, C25, D9, E3)
// ============================================================================

/**
 * Decision 14: the boot's pass, after bootShards and before the populate. While the database does not answer it logs
 * at once and every 30 s and tries again every 5 s, with no bound; a stop ends the wait.
 */
export async function bootShared(): Promise<'done' | 'stopped'> {
  if (!pgBackend()) {
    bootDone = true;
    return 'done';
  }
  let loggedAt: number | null = null;
  for (;;) {
    if (stopped()) return 'stopped';
    const res = await passBoundary(() => fullPass(true, true, () => { bootCause = null; }));
    if (stopped()) return 'stopped';
    if (res.answered) {
      bootCause = null;
      bootCauseLocal = false;
      bootDone = true;
      return 'done';
    }
    if (res.cause !== null) bootCauseLocal = res.local === true;
    bootCause = res.cause ?? bootCause;
    const now = Date.now();
    if (loggedAt === null || now - loggedAt >= BOOT_LOG_MS) {
      loggedAt = now;
      console.error(bootCauseLocal
        ? `[Shared] Waiting for this machine to write the shared files (${bootCause}); modules start once they are up to date`
        : `[Shared] Waiting for the database to bring the shared files up to date (${bootCause}); modules start once they are`);
    }
    await new Promise<void>(resolve => {
      const wait = setTimeout(resolve, BOOT_RETRY_MS);
      bootWake = () => {
        clearTimeout(wait);
        resolve();
      };
    });
    bootWake = null;
  }
}

/** C24: the child serves shared ops once bootShared ended; a JSON bot at once. */
export function sharedBootDone(): boolean {
  return bootDone || resolveDataBackend() !== 'postgres';
}

/** D9 and E3: the cause of bootShared's last try while it failed; null once a try got the database's answer. */
export function sharedBootCause(): string | null {
  return bootDone ? null : bootCause;
}

/** R5-B2: whether sharedBootCause is this machine's own write of the shared files, not the database's. */
export function sharedBootCauseLocal(): boolean {
  return !bootDone && bootCause !== null && bootCauseLocal;
}

/**
 * After the boot (decision 29): the pass every 60 s whatever the listener's state, the listener, and the run of a key
 * once its last op of this process settled. guildRequests asks NB7's sweep for a pass.
 */
export function startSharedPass(opts: { guildRequests?: () => void } = {}): void {
  const backend = pgBackend();
  if (!backend || passTimer || stopped()) return;
  unsettle = onRowKeySettled((key, last) => {
    if (stopped()) return;
    const refused = last.state === 'refused' || last.state === 'unconfirmed';
    if (skipped.delete(key) || refused) requestKey(key);
  });
  passTimer = setInterval(() => {
    if (!stopped() && !passRun) void runSharedPass();
  }, PASS_EVERY_MS);
  passTimer.unref?.();
  startSharedListener({
    entry: () => pgBackend()?.chosenEntry() ?? null,
    onDoc: requestKey,
    onModule: requestModule,
    onConnected: () => {
      if (stopped()) return;
      void runSharedPass();
      opts.guildRequests?.();
    },
    onGuildRequest: () => opts.guildRequests?.(),
    onDatabaseChanged: cb => backend.onDatabaseChanged(() => cb()),
  });
}

/** C25 and D4's stop step: clears the timer, sets the stop mark, ends the listener; nothing starts after it. */
export function stopSharedPass(): void {
  stopMark = true;
  if (passTimer) clearInterval(passTimer);
  passTimer = null;
  stopSharedListener();
  unsettle?.();
  unsettle = null;
  bootWake?.();
}

/** Tests start each case from a process that never ran a pass. */
export function _resetSharedMirror(): void {
  stopSharedPass();
  stopMark = false;
  passCount = 0;
  passRun = null;
  lastPruneAt = null;
  pruneRun = null;
  bootDone = false;
  bootCause = null;
  bootCauseLocal = false;
  moduleStep = null;
  skipped.clear();
  keyRuns.clear();
  keyRequests.clear();
  keyAgain.clear();
  moduleRequests.clear();
  moduleAgain.clear();
  readLogged.clear();
  writeLogged.clear();
  moveLogged.clear();
  stopLogged.clear();
}
