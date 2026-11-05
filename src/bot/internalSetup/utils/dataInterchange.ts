// Namespace interchange: export/import a guild's data as a stream of verified
// file records, the namespace content hash, and an on-disk bundle format.
//
// Bytes, not parsed JSON, are hashed: both sides hold identical bytes after a
// copy, so no canonical-JSON normalization is needed.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DATA_ROOT } from '../../../utils/dataRoot';
import { flushGuild } from './dataManager';
import { checkWriterLock, configureWriterLock, deposedHolder, holderWords, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from './writerLock';
import type { TakeResult } from './processLock';
import { MIGRATION_FILE, readDataFacts } from './dataBackends/recognitionGuard';
import { resolveDataBackend, type DataBackendKind } from '../../../utils/envLoader';
import { canonicalGuildKey, GuildKeyError } from './dataKeys';
import { decodeStorable, keyRefusal, KeyTree, pathKeyOf } from './storableData';

export interface FileRecord {
  guildId: string;
  relPath: string; // forward-slash normalized, relative to the guild dir
  size: number;
  sha256: string; // hex of the raw bytes
  bytes: Buffer;
}

// Interrupted atomic writes, never part of the namespace.
export function isExcludedNamespaceName(name: string): boolean {
  return name.endsWith('.tmp');
}

/**
 * Why a bundle cannot carry this record, or null: its key breaks a write rule, its bytes are not storable text, or
 * it collides with a record before it (tree holds those, and takes this one when it passes).
 */
function bundleRecordRefusal(relPath: string, bytes: Buffer, tree: KeyTree): string | null {
  let key: string;
  try {
    const canonical = canonicalGuildKey('', relPath);
    key = pathKeyOf(canonical.module, canonical.filename);
  } catch (error) {
    if (error instanceof GuildKeyError) return error.message.replace(/^\[Data\] /, '');
    throw error;
  }
  const refusal = keyRefusal(key);
  if (refusal) return refusal;
  const decoded = decodeStorable(bytes);
  if (!decoded.ok) return decoded.reason;
  const collision = tree.check(key);
  if (collision) return collision.reason;
  tree.add(key);
  return null;
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Streamed file hash for verify walks: bounded memory, and the event loop
 * yields between chunks, so hashing a large file cannot starve the process
 * the way a whole-file read + single-shot update does.
 */
export function hashFileStreamed(filePath: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ size, sha256: hash.digest('hex') }));
  });
}

// Resolve a record's relPath under destRoot, or null when it fails the guard
// (absolute / drive-letter / backslash / empty or '..' segment / escapes root).
export function safeImportTarget(destResolved: string, relPath: unknown): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (path.isAbsolute(relPath) || relPath.includes('\\') || /^[a-zA-Z]:/.test(relPath)) return null;
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  const resolved = path.resolve(destResolved, ...segments);
  if (resolved !== destResolved && !resolved.startsWith(destResolved + path.sep)) return null;
  return resolved;
}

// Recursive walk yielding forward-slash relative paths under `base`, applying
// the exclusion list at every level.
async function* walkFiles(base: string, rel: string = ''): AsyncGenerator<string> {
  const dir = rel ? path.join(base, rel) : base;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(base, childRel);
    } else if (entry.isFile() && !isExcludedNamespaceName(entry.name)) {
      yield childRel;
    }
  }
}

/**
 * Stream a guild's namespace as verified file records. Flushes this process's
 * write queue for the guild first; another process's queue (a running bot seen
 * from the CLI) is not reached, which is why the bundle verbs refuse a live bot.
 */
export async function* exportNamespace(guildId: string): AsyncGenerator<FileRecord> {
  await flushGuild(guildId);
  const base = path.join(DATA_ROOT, guildId);
  for await (const relPath of walkFiles(base)) {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(path.join(base, relPath));
    } catch {
      continue; // file vanished mid-walk
    }
    yield { guildId, relPath, size: bytes.length, sha256: sha256Hex(bytes), bytes };
  }
}

/**
 * Write records into a destination dir (a bundle import's staging dir),
 * verifying each record's sha256 while streaming to disk. Throws on a hash
 * mismatch.
 */
export async function importNamespace(
  guildId: string,
  records: AsyncGenerator<FileRecord> | Iterable<FileRecord>,
  destDir: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const destResolved = path.resolve(destDir);
  let fileCount = 0;
  let totalBytes = 0;
  const tree = new KeyTree();
  for await (const record of records as AsyncGenerator<FileRecord>) {
    const actual = sha256Hex(record.bytes);
    if (actual !== record.sha256) {
      throw new Error(`[DataInterchange] Hash mismatch for ${guildId}/${record.relPath}: expected ${record.sha256}, got ${actual}`);
    }
    const target = safeImportTarget(destResolved, record.relPath);
    if (!target) {
      throw new Error(`[DataInterchange] Rejected out-of-scope relPath for ${guildId}: ${record.relPath}`);
    }
    const refusal = bundleRecordRefusal(record.relPath, record.bytes, tree);
    if (refusal) throw new Error(`[DataInterchange] ${guildId}/${record.relPath}: ${refusal}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, record.bytes);
    fileCount += 1;
    totalBytes += record.size;
  }
  return { fileCount, totalBytes };
}

export interface NamespaceHashResult {
  namespaceHash: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Content hash of a guild dir at any root; a missing dir hashes as empty. A
 * verify-only walk: streamed per-file hashes, never whole-file buffers.
 */
export async function hashNamespaceAt(base: string): Promise<NamespaceHashResult> {
  const files: { relPath: string; size: number; sha256: string }[] = [];
  for await (const relPath of walkFiles(base)) {
    try {
      const { size, sha256 } = await hashFileStreamed(path.join(base, relPath));
      files.push({ relPath, size, sha256 });
    } catch { /* file vanished mid-walk */ }
  }
  return namespaceHashOf(files);
}

/**
 * The namespace hash of a listed file set. Canonical order: relPath sorted by
 * raw UTF-8 byte order. Hash = sha256(concat over sorted files of:
 * relPath + '\n' + decimalSize + '\n' + fileSha256Hex + '\n').
 */
export function namespaceHashOf(files: { relPath: string; size: number; sha256: string }[]): NamespaceHashResult {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf-8'), Buffer.from(b.relPath, 'utf-8')));
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const f of sorted) {
    hash.update(`${f.relPath}\n${f.size}\n${f.sha256}\n`);
    totalBytes += f.size;
  }
  return { namespaceHash: hash.digest('hex'), fileCount: sorted.length, totalBytes };
}

// ============================================================================
// On-disk bundle (DBEX1): magic + repeated [4B BE headerLen][headerJSON][payload]
// terminated by [4B 0][summary JSON].
// ============================================================================

const BUNDLE_MAGIC = 'DBEX1\n';

interface BundleRecordHeader {
  g: string; // guildId
  p: string; // relPath
  s: number; // size
  h: string; // sha256 hex
}

interface BundleSummary {
  t: 'summary';
  fileCount: number;
  totalBytes: number;
  namespaceHash: string;
}

const GUILD_ID = /^\d+$/;

/**
 * Why a bundle export or import of this guild must not run, or null. The bundle
 * reads and writes /data/<guild> directly, so it is only true to its word for a
 * file-routed guild with no bot process beside it.
 */
export function bundleRefusal(guildId: string, botRunning: 'yes' | 'no' | 'unknown', migrating: 'yes' | 'no' | 'unknown' = 'no'): string | null {
  if (!GUILD_ID.test(guildId)) return `"${guildId}" is not a guild id`;
  const facts = readDataFacts();
  if (!facts.ok) return facts.reason;
  if (migrating === 'yes') return 'a data migration is running; run the bundle once it ends';
  const marker = facts.marker;
  let route: DataBackendKind;
  try {
    route = marker ? marker.live : resolveDataBackend();
  } catch (error) {
    return `could not confirm which backend serves guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (route === 'postgres') {
    return `guild ${guildId} is served from postgres; its files under ${DATA_ROOT} are not its data, so a bundle would read or write the wrong copy`;
  }
  if (botRunning === 'yes') return 'the bot is running; stop it first, a bundle beside it would miss its queued writes or be overwritten by them';
  if (botRunning === 'unknown') return 'could not confirm the bot is stopped (the panel did not answer or gave no clear reply); start the panel (/webui start) or stop the bot first';
  if (migrating === 'unknown') return 'could not confirm that no data migration is running (the panel gave no clear reply)';
  return null;
}

/** The marker and the journal as they are on disk, to tell whether a migration touched them during an import. */
function storeRecords(): string {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch (error) {
      return `[${(error as NodeJS.ErrnoException)?.code ?? 'unreadable'}]`;
    }
  };
  return `${read(path.join(DATA_ROOT, '.backend.json'))}\n${read(MIGRATION_FILE)}`;
}

function encodeSummary(files: { relPath: string; size: number; sha256: string }[]): BundleSummary {
  const { namespaceHash, fileCount, totalBytes } = namespaceHashOf(files);
  return { t: 'summary', fileCount, totalBytes, namespaceHash };
}

/**
 * Write a guild's namespace to an on-disk DBEX1 bundle. The bundle is written
 * beside the target as '<file>.partial', synced, read back against its summary
 * and only then renamed over the target, so a failure leaves any previous file
 * there untouched. A guild with no data dir is refused, never exported empty.
 */
export async function writeBundle(guildId: string, filePath: string): Promise<BundleSummary> {
  const guildDir = path.join(DATA_ROOT, guildId);
  const stat = await fs.promises.stat(guildDir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`[DataInterchange] Guild ${guildId} has no data dir at ${guildDir}; nothing exported`);

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.partial`;
  try {
    const out = fs.createWriteStream(partial);
    const write = (chunk: Buffer | string): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(chunk, err => (err ? reject(err) : resolve()));
      });
    const opened = new Promise<void>((resolve, reject) => {
      out.once('open', () => resolve());
      out.once('error', reject);
    });
    await opened;

    await write(BUNDLE_MAGIC);
    const files: { relPath: string; size: number; sha256: string }[] = [];
    const tree = new KeyTree();
    const refused: string[] = [];
    for await (const record of exportNamespace(guildId)) {
      const refusal = bundleRecordRefusal(record.relPath, record.bytes, tree);
      if (refusal) refused.push(`${record.relPath}: ${refusal}`);
      if (refused.length > 0) continue;
      const header: BundleRecordHeader = { g: record.guildId, p: record.relPath, s: record.size, h: record.sha256 };
      const headerJson = Buffer.from(JSON.stringify(header), 'utf-8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(headerJson.length, 0);
      await write(len);
      await write(headerJson);
      await write(record.bytes);
      files.push({ relPath: record.relPath, size: record.size, sha256: record.sha256 });
    }
    if (refused.length > 0) {
      throw new Error(`[DataInterchange] Guild ${guildId} holds ${refused.length} file(s) a bundle cannot carry: ${refused.slice(0, 10).join('; ')}; move their content to an allowed name or delete them, then export again`);
    }

    const summary = encodeSummary(files);
    const terminator = Buffer.alloc(4);
    terminator.writeUInt32BE(0, 0);
    await write(terminator);
    await write(Buffer.from(JSON.stringify(summary), 'utf-8'));
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    const fh = await fs.promises.open(partial, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }

    let readBack: BundleSummary | null = null;
    for await (const record of readBundle(partial, s => { readBack = s; })) {
      if (record.guildId !== guildId) throw new Error(`[DataInterchange] Bundle read back names guild ${record.guildId}, not ${guildId}`);
    }
    const back = readBack as BundleSummary | null;
    if (!back || back.fileCount !== summary.fileCount || back.totalBytes !== summary.totalBytes || back.namespaceHash !== summary.namespaceHash) {
      throw new Error('[DataInterchange] Bundle read back does not match what was written');
    }
    await fs.promises.rename(partial, filePath);
    return summary;
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Read a DBEX1 bundle as a stream of file records. After the last record it
 * reads the summary and throws unless it is present and matches the records
 * read, so a truncated or altered bundle never ends as a clean stream.
 */
export async function* readBundle(filePath: string, onSummary?: (summary: BundleSummary) => void): AsyncGenerator<FileRecord> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let pos = 0;
    const magic = Buffer.alloc(BUNDLE_MAGIC.length);
    await readExact(fh, magic, pos);
    pos += magic.length;
    if (magic.toString('utf-8') !== BUNDLE_MAGIC) {
      throw new Error('[DataInterchange] Not a DBEX1 bundle');
    }
    const files: { relPath: string; size: number; sha256: string }[] = [];
    for (;;) {
      const lenBuf = Buffer.alloc(4);
      await readExact(fh, lenBuf, pos);
      pos += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      if (headerLen === 0) break;
      const headerBuf = Buffer.alloc(headerLen);
      await readExact(fh, headerBuf, pos);
      pos += headerLen;
      const header = JSON.parse(headerBuf.toString('utf-8')) as BundleRecordHeader;
      const payload = Buffer.alloc(header.s);
      await readExact(fh, payload, pos);
      pos += header.s;
      const actual = sha256Hex(payload);
      if (actual !== header.h) {
        throw new Error(`[DataInterchange] Bundle hash mismatch for ${header.g}/${header.p}`);
      }
      files.push({ relPath: header.p, size: header.s, sha256: header.h });
      yield { guildId: header.g, relPath: header.p, size: header.s, sha256: header.h, bytes: payload };
    }
    const { size } = await fh.stat();
    if (size <= pos) throw new Error('[DataInterchange] Bundle has no summary; it is incomplete');
    const summaryBuf = Buffer.alloc(size - pos);
    await readExact(fh, summaryBuf, pos);
    let summary: BundleSummary;
    try {
      summary = JSON.parse(summaryBuf.toString('utf-8')) as BundleSummary;
    } catch {
      throw new Error('[DataInterchange] Bundle summary is unreadable; it is incomplete');
    }
    const expected = encodeSummary(files);
    if (summary?.t !== 'summary' || summary.fileCount !== expected.fileCount || summary.totalBytes !== expected.totalBytes
      || summary.namespaceHash !== expected.namespaceHash) {
      throw new Error('[DataInterchange] Bundle summary does not match its records');
    }
    onSummary?.(summary);
  } finally {
    await fh.close();
  }
}

export interface BundleImportResult {
  guildId: string;
  destDir: string;
  fileCount: number;
  totalBytes: number;
  namespaceHash: string;
  replaced: string | null; // where the guild dir it replaced now lies, or null when there was none
}

/**
 * Restore a bundle into its guild's dir. The records land in a staging dir,
 * which is hashed against the bundle's summary; only then is the current guild
 * dir moved to _graveyard and the staging dir renamed into its place. Any failure before the swap leaves the
 * live dir as it was; a failed swap puts the old dir back.
 */
/**
 * Imports a bundle holding the data files' writer lock (role import) for the whole import, so a bot started meanwhile
 * waits for it; refused at once while another live process holds the lock.
 */
export async function importBundle(filePath: string): Promise<BundleImportResult> {
  if (writerLockDepth() === 0) configureWriterLock('import');
  const taken = takeWriterLock();
  if (taken.kind !== 'taken') throw new Error(`[DataInterchange] ${importLockRefusal(taken)}`);
  try {
    return await importBundleHeld(filePath);
  } finally {
    releaseWriterLock();
  }
}

function importLockRefusal(taken: Exclude<TakeResult, { kind: 'taken' }>): string {
  switch (taken.kind) {
    case 'held':
      return taken.holder
        ? `the data files are held by ${holderWords(taken.holder)} (pid ${taken.holder.pid}); run the import once it has stopped`
        : 'another process is taking the data files at this moment; run the import once it has stopped';
    case 'contended':
      return 'another process is taking over the data files at this moment; run the import again in a moment';
    case 'unreadable':
      return `can't confirm which process holds the data files (${writerLockPath()}: ${taken.errno}); nothing was imported`;
    case 'unwritable':
      return `the data disk does not take writes (${writerLockPath()}: ${taken.errno}); nothing was imported`;
  }
}

/** Throws when another process took the data files from this import: no guild dir is moved after that. */
function refuseIfDeposed(): void {
  const check = checkWriterLock();
  const holder = check.kind === 'deposed' ? check.holder : deposedHolder();
  if (holder) throw new Error(`[DataInterchange] Another process (${holderWords(holder)}, pid ${holder.pid}) took the data files during the import`);
}

async function importBundleHeld(filePath: string): Promise<BundleImportResult> {
  let summary: BundleSummary | null = null;
  const gen = readBundle(filePath, s => { summary = s; });
  const first = await gen.next();
  if (first.done) throw new Error('[DataInterchange] Bundle is empty; nothing to import');
  const firstRecord = first.value;
  const guildId = firstRecord.guildId;
  if (!GUILD_ID.test(guildId)) {
    await gen.return(undefined);
    throw new Error(`[DataInterchange] Bundle names "${guildId}", which is not a guild id`);
  }
  async function* records(): AsyncGenerator<FileRecord> {
    yield firstRecord;
    for await (const record of gen) {
      if (record.guildId !== guildId) throw new Error(`[DataInterchange] Bundle mixes guilds ${guildId} and ${record.guildId}`);
      yield record;
    }
  }

  const liveDir = path.join(DATA_ROOT, guildId);
  const recordsAtCheck = storeRecords();
  const staging = path.join(DATA_ROOT, `.bundle-import-${guildId}-${Date.now()}`);
  let moved: string | null = null;
  let swapping = false;
  try {
    const written = await importNamespace(guildId, records(), staging);
    const bundled = summary as BundleSummary | null;
    const staged = await hashNamespaceAt(staging);
    if (!bundled || staged.fileCount !== written.fileCount || staged.fileCount !== bundled.fileCount
      || staged.namespaceHash !== bundled.namespaceHash) {
      throw new Error('[DataInterchange] Staged import does not match the bundle summary');
    }
    if (storeRecords() !== recordsAtCheck) {
      throw new Error('[DataInterchange] /data/.backend.json or /data/.migration.json changed while the import ran, so a data migration may have started');
    }

    const live = await fs.promises.stat(liveDir).catch(() => null);
    if (live) {
      const graveyardRoot = path.join(DATA_ROOT, '_graveyard');
      await fs.promises.mkdir(graveyardRoot, { recursive: true });
      const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);
      refuseIfDeposed();
      await fs.promises.rename(liveDir, dest);
      swapping = true;
      moved = dest;
      try {
        await fs.promises.rename(staging, liveDir);
      } catch (error) {
        try {
          await fs.promises.rename(dest, liveDir);
        } catch (restoreError) {
          throw new Error(`[DataInterchange] Swap failed (${error instanceof Error ? error.message : String(error)}) and the old guild dir could not be put back; it lies at ${dest}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        throw new Error(`[DataInterchange] Swap failed; the old guild dir was put back: ${error instanceof Error ? error.message : String(error)}`);
      }
      await fs.promises.writeFile(path.join(dest, '.graveyard.json'), JSON.stringify({ guildId, reason: 'replaced by bundle import', ts: Date.now() }, null, 2), 'utf-8')
        .catch(() => undefined);
    } else {
      refuseIfDeposed();
      swapping = true;
      await fs.promises.rename(staging, liveDir);
    }
    return { guildId, destDir: liveDir, fileCount: staged.fileCount, totalBytes: staged.totalBytes, namespaceHash: staged.namespaceHash, replaced: moved };
  } catch (error) {
    if (swapping) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the live guild dir was not touched`);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readExact(fh: fs.promises.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await fh.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error('[DataInterchange] Unexpected end of bundle');
    offset += bytesRead;
  }
}
