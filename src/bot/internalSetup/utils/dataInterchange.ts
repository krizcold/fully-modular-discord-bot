// Namespace interchange (Phase 3 / P4): export/import a guild's data as a
// stream of verified file records, plus the content hash used by the migration
// verify step and an on-disk bundle format (backup + interim manual bridge).
//
// Bytes, not parsed JSON, are hashed: both sides hold identical bytes after a
// copy, so no canonical-JSON normalization is needed.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DATA_ROOT } from '../../../utils/dataRoot';
import { flushGuild } from './dataManager';

export interface FileRecord {
  guildId: string;
  relPath: string; // forward-slash normalized, relative to the guild dir
  size: number;
  sha256: string; // hex of the raw bytes
  bytes: Buffer;
}

// Files that are node-local sidecars, never part of the transferable namespace.
const EXCLUDED_NAMES = new Set(['.owner', '.freeze']);
function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.endsWith('.tmp');
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Resolve a record's relPath under destRoot, or null when it fails the guard
// (absolute / drive-letter / backslash / empty or '..' segment / escapes root).
// Mirrors the Stage 3/4 resolveScopeFile traversal idiom.
function safeImportTarget(destResolved: string, relPath: unknown): string | null {
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
    if (isExcluded(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(base, childRel);
    } else if (entry.isFile()) {
      yield childRel;
    }
  }
}

/**
 * Stream a guild's namespace as verified file records. Flushes the guild first
 * so the queue is on disk before enumeration.
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
 * Write records into an arbitrary destination root (the live guild dir for the
 * manual bridge, or _incoming staging for a migration), verifying each
 * record's sha256 while streaming to disk. Throws on a hash mismatch.
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
  for await (const record of records as AsyncGenerator<FileRecord>) {
    const actual = sha256Hex(record.bytes);
    if (actual !== record.sha256) {
      throw new Error(`[DataInterchange] Hash mismatch for ${guildId}/${record.relPath}: expected ${record.sha256}, got ${actual}`);
    }
    const target = safeImportTarget(destResolved, record.relPath);
    if (!target) {
      throw new Error(`[DataInterchange] Rejected out-of-scope relPath for ${guildId}: ${record.relPath}`);
    }
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
 * Content hash of a guild namespace. Canonical order: relPath sorted by raw
 * UTF-8 byte order. Hash = sha256(concat over sorted files of:
 * relPath + '\n' + decimalSize + '\n' + fileSha256Hex + '\n').
 */
export async function hashNamespace(guildId: string): Promise<NamespaceHashResult> {
  const files: { relPath: string; size: number; sha256: string }[] = [];
  for await (const record of exportNamespace(guildId)) {
    files.push({ relPath: record.relPath, size: record.size, sha256: record.sha256 });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf-8'), Buffer.from(b.relPath, 'utf-8')));
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const f of files) {
    hash.update(`${f.relPath}\n${f.size}\n${f.sha256}\n`);
    totalBytes += f.size;
  }
  return { namespaceHash: hash.digest('hex'), fileCount: files.length, totalBytes };
}

/**
 * Per-guild content hashes plus a single migration-leg hash =
 * sha256 of guild hashes concatenated in guildId order.
 */
export async function hashLeg(guildIds: string[]): Promise<{ guildHashes: Record<string, string>; legHash: string }> {
  const guildHashes: Record<string, string> = {};
  for (const guildId of guildIds) {
    guildHashes[guildId] = (await hashNamespace(guildId)).namespaceHash;
  }
  const legHash = crypto.createHash('sha256');
  for (const guildId of [...guildIds].sort()) {
    legHash.update(guildHashes[guildId]);
  }
  return { guildHashes, legHash: legHash.digest('hex') };
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

/**
 * Write a guild's namespace to an on-disk DBEX1 bundle.
 */
export async function writeBundle(guildId: string, filePath: string): Promise<BundleSummary> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath);
  const write = (chunk: Buffer | string): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(chunk, err => (err ? reject(err) : resolve()));
    });

  await write(BUNDLE_MAGIC);

  const files: { relPath: string; size: number; sha256: string }[] = [];
  let totalBytes = 0;
  for await (const record of exportNamespace(guildId)) {
    const header: BundleRecordHeader = { g: record.guildId, p: record.relPath, s: record.size, h: record.sha256 };
    const headerJson = Buffer.from(JSON.stringify(header), 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(headerJson.length, 0);
    await write(len);
    await write(headerJson);
    await write(record.bytes);
    files.push({ relPath: record.relPath, size: record.size, sha256: record.sha256 });
    totalBytes += record.size;
  }

  files.sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf-8'), Buffer.from(b.relPath, 'utf-8')));
  const nsHash = crypto.createHash('sha256');
  for (const f of files) nsHash.update(`${f.relPath}\n${f.size}\n${f.sha256}\n`);

  const summary: BundleSummary = { t: 'summary', fileCount: files.length, totalBytes, namespaceHash: nsHash.digest('hex') };
  const summaryJson = Buffer.from(JSON.stringify(summary), 'utf-8');
  const terminator = Buffer.alloc(4);
  terminator.writeUInt32BE(0, 0);
  await write(terminator);
  await write(summaryJson);

  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return summary;
}

/**
 * Read a DBEX1 bundle as a stream of file records. Stops at the terminator.
 */
export async function* readBundle(filePath: string): AsyncGenerator<FileRecord> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let pos = 0;
    const magic = Buffer.alloc(BUNDLE_MAGIC.length);
    await readExact(fh, magic, pos);
    pos += magic.length;
    if (magic.toString('utf-8') !== BUNDLE_MAGIC) {
      throw new Error('[DataInterchange] Not a DBEX1 bundle');
    }
    for (;;) {
      const lenBuf = Buffer.alloc(4);
      await readExact(fh, lenBuf, pos);
      pos += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      if (headerLen === 0) break; // terminator; summary follows but the stream ends here
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
      yield { guildId: header.g, relPath: header.p, size: header.s, sha256: header.h, bytes: payload };
    }
  } finally {
    await fh.close();
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
