// Backup-side guild-data mirror engine (B4f-1): a designated backup's pull of
// a file-mode master's guild dirs into the shadow tree DATA_ROOT/_mirror, one
// tick a minute plus one after every registration. Changed files only, each
// verified by sha256 in staging before its rename; a tick that could not
// verify everything ends degraded and never stamps a complete copy. The
// manifest is the truth of what the copy holds. Live guild dirs are never
// touched here: the boot residue sweep would graveyard a foreign one.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT } from '../../../utils/dataRoot';
import { resolveDataBackend } from '../../../utils/envLoader';
import { hashFileStreamed, namespaceHashOf, safeImportTarget } from '../utils/dataInterchange';
import { MIRROR_DIRNAME, MIRROR_DOC_NAMES, MIRROR_LIST_TIMEOUT_MS, MIRROR_TICK_MS, SYNC_MAX_FILE_BYTES } from './constants';
import { atomicWriteFileSync, renameWithRetry } from './fileControlStore';
import { readHolderSighting } from './holderSighting';
import { MSG, MirrorListReply, MirrorReadKind, MirrorReport, MirrorStatus, SyncFileEntry } from './protocol';

const STAGING_DIRNAME = '.staging';
const DOCS_DIRNAME = 'fleet';
const MANIFEST_FILENAME = 'manifest.json';
const ADOPT_MARKER_FILENAME = 'adopt.json';

export interface MirrorFileRecord {
  size: number;
  sha256: string;
}

export interface MirrorGuildRecord {
  /** The listing's namespace hash once every file matched it; null while this guild's copy is partial. */
  hash: string | null;
  files: Record<string, MirrorFileRecord>;
}

export interface MirrorManifest {
  sourceNodeId: string | null;
  sourceNodeName: string | null;
  sourceTerm: number | null;
  /** The master's mirror revision of the last COMPLETE copy. */
  revision: number | null;
  listedAt: number | null;
  /** When the last COMPLETE copy finished, this node's clock; null when never. */
  completedAt: number | null;
  guilds: Record<string, MirrorGuildRecord>;
  /** Guilds the master held frozen at the last listing; their records above are the last copy taken. */
  frozen: string[];
  documents: Record<string, MirrorFileRecord>;
  /**
   * When a migration last committed guilds of this copy onto this node's
   * live tree (B4f-4): the copy's plan still places them with the master
   * until a pass begun after that completes, so no seed is offered from it.
   */
  droppedAt?: number | null;
}

export interface MirrorEngineHooks {
  request: (type: string, data: any, timeoutMs?: number) => Promise<any>;
  getTerm: () => number;
  masterKnown: () => boolean;
  onChanged: () => void;
}

export function mirrorRoot(): string {
  return path.join(DATA_ROOT, MIRROR_DIRNAME);
}

export function mirrorGuildDir(guildId: string): string {
  return path.join(mirrorRoot(), guildId);
}

export function mirrorDocsDir(): string {
  return path.join(mirrorRoot(), DOCS_DIRNAME);
}

export function mirrorManifestFile(): string {
  return path.join(mirrorRoot(), MANIFEST_FILENAME);
}

/** The adopt's commit-intent marker (B4f-2): while it exists the copy is being moved into the live tree and no tick touches it. */
export function adoptMarkerFile(): string {
  return path.join(mirrorRoot(), ADOPT_MARKER_FILENAME);
}

function emptyManifest(): MirrorManifest {
  return { sourceNodeId: null, sourceNodeName: null, sourceTerm: null, revision: null, listedAt: null, completedAt: null, guilds: {}, frozen: [], documents: {} };
}

export function readMirrorManifest(): MirrorManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorManifestFile(), 'utf-8')) as MirrorManifest;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.guilds !== 'object' || parsed.guilds === null
      || !Array.isArray(parsed.frozen) || typeof parsed.documents !== 'object' || parsed.documents === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isGuildId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isFileEntry(value: unknown): value is SyncFileEntry {
  const entry = value as SyncFileEntry;
  return !!entry && typeof entry.path === 'string' && typeof entry.sha256 === 'string' && Number.isInteger(entry.size) && entry.size >= 0;
}

/** Remove directories left empty under root (never root itself): the listing carries files, not directories. */
function pruneEmptyDirs(root: string, rel = ''): boolean {
  const dir = rel ? path.join(root, rel) : root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (pruneEmptyDirs(root, childRel)) fs.rmSync(path.join(root, childRel), { recursive: true, force: true });
      else empty = false;
    } else {
      empty = false;
    }
  }
  return empty && rel !== '';
}

/** Every regular file under dir, forward-slash relative; empty when absent. */
function listLocalFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listLocalFiles(dir, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

interface ApplyOutcome {
  complete: boolean;
  changed: number;
  error?: string;
}

/** The namespace hash of a guild record, over what the copy holds (the formula of hashNamespace). */
function recordHash(files: Record<string, MirrorFileRecord>): string {
  return namespaceHashOf(Object.entries(files).map(([relPath, f]) => ({ relPath, size: f.size, sha256: f.sha256 }))).namespaceHash;
}

/** Whether names differing only by case land on one file here (a Windows backup of a Linux master); null when the probe could not run. */
function probeCaseInsensitive(root: string): boolean | null {
  const probe = path.join(root, '.CaseProbe');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(probe, '');
    return fs.existsSync(path.join(root, '.caseprobe'));
  } catch {
    return null;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** Case fold per character: a whole-string toLowerCase is context-sensitive (a final Greek sigma) where the filesystem's fold is not. */
function foldName(rel: string): string {
  return [...rel].map(c => c.toLowerCase()).join('');
}

/** Every path a listed file occupies: its directory prefixes and itself. */
function pathPrefixes(rel: string): string[] {
  const segments = rel.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * The listed files whose names, or whose directories, differ from another's
 * only by case (every file under either spelling, whatever the listing order),
 * and the first such pair.
 */
function caseCollisions(paths: string[]): { files: Set<string>; pair: [string, string] | null } {
  const spellings = new Map<string, Set<string>>();
  for (const rel of paths) {
    for (const prefix of pathPrefixes(rel)) {
      const lower = foldName(prefix);
      const seen = spellings.get(lower);
      if (seen) seen.add(prefix);
      else spellings.set(lower, new Set([prefix]));
    }
  }
  const files = new Set<string>();
  let pair: [string, string] | null = null;
  for (const rel of paths) {
    for (const prefix of pathPrefixes(rel)) {
      const seen = spellings.get(foldName(prefix))!;
      if (seen.size < 2) continue;
      files.add(rel);
      if (pair === null) {
        const [first, second] = [...seen];
        pair = [first, second];
      }
    }
  }
  return { files, pair };
}

/**
 * Guilds a migration committed onto this node's live tree (B4f-4), with the
 * time: their live dirs hold the newest data, so the copy of them is spent
 * and must never be adopted over them. A pass that started before the
 * commit still names them and leaves them out of what it writes.
 */
const committedHere = new Map<string, number>();
let activeEngine: MirrorEngine | null = null;

/** A migration committed these guilds onto this node: dropped from the copy now (the engine and the disk alike). Never throws. */
export function noteGuildsCommittedHere(guildIds: string[]): void {
  try {
    const at = Date.now();
    const ids = guildIds.filter(isGuildId);
    if (ids.length === 0) return;
    // Only a running engine has a pass that may still name them.
    if (activeEngine) for (const guildId of ids) committedHere.set(guildId, at);
    let dropped = ids.filter(guildId => fs.existsSync(mirrorGuildDir(guildId)));
    const onDisk = readMirrorManifest();
    if (onDisk && ids.some(guildId => onDisk.guilds[guildId] || onDisk.frozen.includes(guildId))) {
      dropped = [...new Set([...dropped, ...ids.filter(guildId => onDisk.guilds[guildId] || onDisk.frozen.includes(guildId))])];
      for (const guildId of ids) delete onDisk.guilds[guildId];
      onDisk.frozen = onDisk.frozen.filter(guildId => !ids.includes(guildId));
      onDisk.droppedAt = at;
      atomicWriteFileSync(mirrorManifestFile(), JSON.stringify(onDisk, null, 2));
    }
    for (const guildId of ids) fs.rmSync(mirrorGuildDir(guildId), { recursive: true, force: true });
    activeEngine?.forgetGuilds(ids, at);
    if (dropped.length > 0) console.log(`[Fleet] Mirror: guild(s) ${dropped.join(', ')} committed onto this node by a migration leave the copy (the live data is the newest); no seed is offered from the copy until its next pass`);
  } catch (error) {
    console.warn('[Fleet] Mirror: dropping guilds a migration committed here from the copy failed; the next pass trims them:', error instanceof Error ? error.message : error);
  }
}

export class MirrorEngine {
  private manifest: MirrorManifest;
  private status: MirrorStatus = 'idle';
  private lastError: string | undefined;
  private degradedError: string | undefined;
  private attemptedAt: number | null = null;
  private running = false;
  private dropPending: string | null = null;
  private diskVerified = false;
  private caseInsensitive: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stagingCounter = 0;

  constructor(private readonly hooks: MirrorEngineHooks) {
    this.manifest = readMirrorManifest() ?? emptyManifest();
    activeEngine = this;
  }

  /** The in-memory copy forgets guilds a migration committed here; a pass running drops them as it writes. */
  forgetGuilds(guildIds: string[], at: number): void {
    if (this.running) return;
    const next = { ...this.manifest, guilds: { ...this.manifest.guilds }, frozen: this.manifest.frozen.filter(guildId => !guildIds.includes(guildId)), droppedAt: at };
    for (const guildId of guildIds) delete next.guilds[guildId];
    this.manifest = next;
    this.hooks.onChanged();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), MIRROR_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick now (after a registration); a tick already running is left to finish. */
  tickNow(): void {
    void this.tick();
  }

  /** The tick as a promise, for a caller that waits on it. */
  runOnce(): Promise<void> {
    return this.tick();
  }

  getManifest(): MirrorManifest {
    return this.manifest;
  }

  /** Null off file mode: the database standby is the copy there, and the Fleet tab shows that line instead. */
  getReport(): MirrorReport | null {
    if (resolveDataBackend() !== 'file') return null;
    const manifest = this.manifest;
    let guildCount = 0;
    let totalBytes = 0;
    for (const guild of Object.values(manifest.guilds)) {
      if (guild.hash === null) continue;
      guildCount += 1;
      for (const file of Object.values(guild.files)) totalBytes += file.size;
    }
    // A held copy of a master that no longer answers: what held it (a seed
    // hold, another master) may be gone, so the line says what is known.
    // Registered with nobody, what the copy is still good for depends on who
    // held the fleet last: a hold replacing its own master, or a promote of
    // this node, adopts it; a later master makes it a previous master's.
    const unregisteredHold = this.status === 'held' && !this.hooks.masterKnown();
    const sighting = unregisteredHold ? readHolderSighting() : null;
    const later = sighting && manifest.sourceNodeId !== null && sighting.nodeId !== manifest.sourceNodeId ? sighting : null;
    const error = unregisteredHold
      ? (manifest.completedAt === null
        ? (Object.keys(manifest.guilds).length === 0
          ? 'this node is registered with no master now; it holds no copy yet, and the mirror starts once a master answers'
          : 'this node is registered with no master now; the copy is incomplete (it seeds and promotes nothing): the mirror resumes under the copy\'s own master, and under any other it is held for the operator to drop')
        : later
          ? `this node is registered with no master now; the copy is a previous master's (node ${later.nodeId.slice(0, 8)} held the fleet after it, at term ${later.term}), so it seeds and promotes nothing and is for the operator to drop once a serving master answers`
          : 'this node is registered with no master now; the copy is kept as it stood: a hold replacing its master adopts it by a seed, a promote of this node adopts it, and any other master holds it for a drop')
      : this.lastError;
    const now = Date.now();
    return {
      status: this.status,
      completedAgoMs: manifest.completedAt === null ? null : Math.max(0, now - manifest.completedAt),
      attemptedAgoMs: this.attemptedAt === null ? null : Math.max(0, now - this.attemptedAt),
      revision: manifest.revision,
      sourceNodeId: manifest.sourceNodeId,
      sourceNodeName: manifest.sourceNodeName,
      sourceTerm: manifest.sourceTerm,
      guildCount,
      totalBytes,
      frozenCount: manifest.frozen.length,
      ...(error ? { error } : {}),
    };
  }

  private async tick(): Promise<void> {
    if (this.running || !this.hooks.masterKnown() || resolveDataBackend() !== 'file' || fs.existsSync(adoptMarkerFile())) return;
    this.running = true;
    this.attemptedAt = Date.now();
    try {
      const reply = await this.hooks.request(MSG.MIRROR_LIST, { term: this.hooks.getTerm() }, MIRROR_LIST_TIMEOUT_MS);
      if (!reply || reply.ok === false) {
        // The gate's own answers (mirror-*) are refusals; anything else (a disk
        // fault in the listing, a stale term, a store error) is a failed attempt.
        const reason = String(reply?.reason ?? 'no reply');
        // A master holding to be seeded (B4f-3) copies nothing yet; the copy
        // this node holds is what it may adopt, so it stays and the line says so.
        if (reason.startsWith('mirror-seed-hold')) {
          const incomplete = this.manifest.completedAt === null && this.degradedError ? `; this node's copy was never complete: ${this.degradedError}` : '';
          this.finish('held', `the master holds to be seeded and copies nothing yet; its Fleet tab lists what this node offers it, or why nothing, and takes the confirm${incomplete}`);
          return;
        }
        this.finish(reason.startsWith('mirror-') ? 'refused' : 'degraded', reason);
        return;
      }
      const listing = reply as MirrorListReply;
      if (!Array.isArray(listing.guilds) || !Array.isArray(listing.frozen) || !Array.isArray(listing.documents)) {
        this.finish('degraded', 'malformed mirror listing');
        return;
      }
      const hold = this.foreignCopyHold(listing);
      if (hold) {
        this.finish('held', hold);
        return;
      }
      this.status = 'copying';
      this.lastError = undefined;
      this.hooks.onChanged();
      const outcome = await this.apply(listing);
      if (outcome.complete) {
        this.finish('complete');
        if (outcome.changed > 0) {
          console.log(`[Fleet] Mirror complete: revision ${listing.revision}, ${listing.guilds.length} guild(s), ${outcome.changed} file(s) changed${listing.frozen.length > 0 ? `, ${listing.frozen.length} frozen kept` : ''}`);
        }
      } else {
        this.finish('degraded', outcome.error ?? 'incomplete copy');
        console.warn(`[Fleet] Mirror incomplete at revision ${listing.revision}: ${outcome.error ?? 'incomplete copy'}`);
      }
    } catch (error) {
      // Files may have landed before the throw while the manifest still names
      // the old bytes, so the next tick checks the disk again.
      this.diskVerified = false;
      this.finish('degraded', error instanceof Error ? error.message : String(error));
      console.warn(`[Fleet] Mirror tick failed: ${this.lastError}`);
    } finally {
      this.running = false;
      if (this.dropPending !== null) {
        const sourceNodeId = this.dropPending;
        this.dropPending = null;
        this.dropCopyOf(sourceNodeId);
      }
    }
  }

  /**
   * The copy taken from that master seeded the fleet's new master (B4f-3), so
   * it is spent: the tree goes, and the next tick copies the master this node
   * is registered with. A tick in flight finishes first (it holds, since the
   * new master lists under another id, so it writes nothing meanwhile).
   */
  dropCopyOf(sourceNodeId: string): void {
    if (this.running) {
      this.dropPending = sourceNodeId;
      return;
    }
    if (this.manifest.sourceNodeId !== sourceNodeId || fs.existsSync(adoptMarkerFile())) return;
    fs.rmSync(mirrorRoot(), { recursive: true, force: true });
    this.manifest = emptyManifest();
    this.diskVerified = false;
    this.finish('idle');
    console.warn(`[Fleet] Mirror copy of node ${sourceNodeId.slice(0, 8)} dropped: it seeded the new master, which this node mirrors from its next tick`);
  }

  private finish(status: MirrorStatus, error?: string): void {
    this.status = status;
    this.lastError = error;
    // The cause of a failed attempt outlives a hold that follows it: the held
    // line names why the copy was never complete.
    if (status === 'degraded') this.degradedError = error;
    else if (status === 'complete' || status === 'idle') this.degradedError = undefined;
    this.hooks.onChanged();
  }

  /**
   * A copy taken from one master is never overwritten or trimmed by another's
   * listing: a fresh master lists nothing, and the copy of the dead one is the
   * data the later stages adopt, seed from or retire (20.20). The tick holds
   * instead, retrying each minute, until the manifest's source is served again
   * or the copy is taken off this node by one of those lanes.
   */
  private foreignCopyHold(listing: MirrorListReply): string | undefined {
    const previous = this.manifest;
    if (previous.sourceNodeId === null || previous.sourceNodeId === listing.sourceNodeId) return undefined;
    if (Object.keys(previous.guilds).length === 0) return undefined;
    const kept = previous.sourceNodeName ?? previous.sourceNodeId;
    const serving = typeof listing.sourceNodeName === 'string' ? listing.sourceNodeName : String(listing.sourceNodeId);
    return `the copy taken from ${kept} is kept; ${serving} serves now and is not mirrored until that copy is dropped (a previous master's copy seeds and promotes nothing)`;
  }

  /**
   * Once per boot, the manifest is checked against the bytes on disk: a crash
   * between a rename and the manifest write leaves a record that names other
   * bytes than the file holds, and the skip below trusts the record. Records
   * that do not match are dropped, so the tick refetches them.
   */
  private async verifyAgainstDisk(manifest: MirrorManifest): Promise<void> {
    const matches = async (target: string | null, record: MirrorFileRecord): Promise<boolean> => {
      if (!target) return false;
      try {
        const { size, sha256 } = await hashFileStreamed(target);
        return size === record.size && sha256 === record.sha256;
      } catch {
        return false;
      }
    };
    for (const [guildId, guild] of Object.entries(manifest.guilds)) {
      const dirResolved = path.resolve(mirrorGuildDir(guildId));
      for (const [rel, record] of Object.entries(guild.files)) {
        if (await matches(safeImportTarget(dirResolved, rel), record)) continue;
        delete guild.files[rel];
        guild.hash = null;
      }
    }
    const docsResolved = path.resolve(mirrorDocsDir());
    for (const [name, record] of Object.entries(manifest.documents)) {
      if (await matches(safeImportTarget(docsResolved, name), record)) continue;
      delete manifest.documents[name];
    }
  }

  private async apply(listing: MirrorListReply): Promise<ApplyOutcome> {
    fs.mkdirSync(mirrorRoot(), { recursive: true });
    fs.rmSync(this.stagingRoot(), { recursive: true, force: true });
    const previous = this.manifest;
    if (!this.diskVerified) {
      await this.verifyAgainstDisk(previous);
      this.diskVerified = true;
    }
    // Unknown reads as insensitive: the conservative answer until the probe runs.
    if (this.caseInsensitive === null) this.caseInsensitive = probeCaseInsensitive(mirrorRoot());
    const foldCase = this.caseInsensitive !== false;
    const fold = (rel: string): string => (foldCase ? foldName(rel) : rel);
    const next: MirrorManifest = {
      sourceNodeId: typeof listing.sourceNodeId === 'string' ? listing.sourceNodeId : null,
      sourceNodeName: typeof listing.sourceNodeName === 'string' ? listing.sourceNodeName : null,
      sourceTerm: Number.isInteger(listing.sourceTerm) ? listing.sourceTerm : null,
      revision: previous.revision,
      listedAt: Number.isInteger(listing.listedAt) ? listing.listedAt : null,
      completedAt: previous.completedAt,
      guilds: {},
      frozen: [],
      documents: {},
      droppedAt: previous.droppedAt ?? null,
    };
    let changed = 0;
    let failures = 0;
    let firstError: string | undefined;
    const fail = (message: string): void => {
      failures += 1;
      if (firstError === undefined) firstError = message;
    };

    for (const guild of listing.guilds) {
      if (!isGuildId(guild?.guildId) || !Array.isArray(guild.files) || typeof guild.hash !== 'string') {
        fail('malformed guild entry in the listing');
        continue;
      }
      const dir = mirrorGuildDir(guild.guildId);
      const dirResolved = path.resolve(dir);
      fs.mkdirSync(dir, { recursive: true });
      const record: MirrorGuildRecord = { hash: null, files: { ...(previous.guilds[guild.guildId]?.files ?? {}) } };
      let guildOk = true;
      const wanted = new Set<string>();
      // Two names that differ only by case (a file, or a directory on its way)
      // are one entry here, so the copy could never hold both faithfully: none
      // of the files involved is taken, what the copy already holds of them is
      // kept as after a failed fetch, and the guild stays partial and says why,
      // rather than complete and short.
      const collisions = foldCase ? caseCollisions(guild.files.filter(isFileEntry).map(f => f.path)) : null;
      for (const file of guild.files) {
        const target = isFileEntry(file) ? safeImportTarget(dirResolved, file.path) : null;
        if (!target || !isFileEntry(file)) {
          guildOk = false;
          fail(`malformed file entry in guild ${guild.guildId}`);
          continue;
        }
        wanted.add(file.path);
        if (collisions && collisions.files.has(file.path)) {
          guildOk = false;
          fail(`${guild.guildId}: ${collisions.pair![0]} and ${collisions.pair![1]} differ only by case, which this filesystem cannot hold`);
          continue;
        }
        const have = record.files[file.path];
        if (have && have.sha256 === file.sha256 && have.size === file.size && fs.existsSync(target)) continue;
        try {
          record.files[file.path] = await this.fetchFile('guild', guild.guildId, file, target);
          changed += 1;
        } catch (error) {
          // The old bytes, if any, are intact: staging verified before the rename.
          guildOk = false;
          fail(`${guild.guildId}/${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // What the master no longer has, and anything the manifest never knew, leaves
      // the copy. Compared case-folded where the disk folds case: the name on disk
      // (or in an old record) may spell a wanted file differently, and removing it
      // by that spelling would remove the file that just landed.
      const wantedFolded = new Set([...wanted].map(fold));
      for (const rel of new Set([...Object.keys(record.files), ...listLocalFiles(dir)])) {
        if (wanted.has(rel)) continue;
        if (!wantedFolded.has(fold(rel))) {
          const target = safeImportTarget(dirResolved, rel);
          if (target) fs.rmSync(target, { force: true });
        }
        if (record.files[rel]) changed += 1;
        delete record.files[rel];
      }
      pruneEmptyDirs(dir);
      // Over what landed, not the listing's figure: a file that changed between
      // the listing and its read lands with the hash of the bytes served.
      record.hash = guildOk ? recordHash(record.files) : null;
      next.guilds[guild.guildId] = record;
    }

    for (const guildId of listing.frozen) {
      if (!isGuildId(guildId) || next.guilds[guildId]) continue;
      next.frozen.push(guildId);
      if (previous.guilds[guildId]) next.guilds[guildId] = previous.guilds[guildId];
    }

    // Guild dirs neither listed nor frozen: the master no longer holds them.
    let localDirs: fs.Dirent[] = [];
    try {
      localDirs = fs.readdirSync(mirrorRoot(), { withFileTypes: true });
    } catch { /* created above */ }
    for (const entry of localDirs) {
      if (!entry.isDirectory() || !isGuildId(entry.name) || next.guilds[entry.name]) continue;
      fs.rmSync(mirrorGuildDir(entry.name), { recursive: true, force: true });
      changed += 1;
    }

    const docsDir = mirrorDocsDir();
    const docsResolved = path.resolve(docsDir);
    fs.mkdirSync(docsDir, { recursive: true });
    const wantedDocs = new Set<string>();
    for (const doc of listing.documents) {
      if (!isFileEntry(doc) || !(MIRROR_DOC_NAMES as readonly string[]).includes(doc.path)) {
        fail('unexpected document in the listing');
        continue;
      }
      wantedDocs.add(doc.path);
      const target = path.join(docsDir, doc.path);
      const have = previous.documents[doc.path];
      if (have && have.sha256 === doc.sha256 && have.size === doc.size && fs.existsSync(target)) {
        next.documents[doc.path] = have;
        continue;
      }
      try {
        next.documents[doc.path] = await this.fetchFile('document', undefined, doc, target);
        changed += 1;
      } catch (error) {
        if (have) next.documents[doc.path] = have;
        fail(`${doc.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const rel of listLocalFiles(docsDir)) {
      if (wantedDocs.has(rel)) continue;
      const target = safeImportTarget(docsResolved, rel);
      if (target) fs.rmSync(target, { force: true });
    }

    // Guilds a migration committed here since this pass began: the listing
    // predates the commit, and the live dirs are the newest data.
    const passStartedAt = this.attemptedAt ?? 0;
    for (const [guildId, at] of committedHere) {
      if (at < passStartedAt) {
        committedHere.delete(guildId);
        continue;
      }
      delete next.guilds[guildId];
      next.frozen = next.frozen.filter(id => id !== guildId);
      fs.rmSync(mirrorGuildDir(guildId), { recursive: true, force: true });
      next.droppedAt = Math.max(next.droppedAt ?? 0, at);
    }

    const complete = failures === 0;
    // A complete pass begun after the last commit makes the copy whole again.
    if (complete && next.droppedAt != null && next.droppedAt < passStartedAt) next.droppedAt = null;
    if (complete) {
      next.completedAt = Date.now();
      next.revision = Number.isInteger(listing.revision) ? listing.revision : null;
    }
    atomicWriteFileSync(mirrorManifestFile(), JSON.stringify(next, null, 2));
    this.manifest = next;
    fs.rmSync(this.stagingRoot(), { recursive: true, force: true });
    const error = firstError === undefined ? undefined : failures > 1 ? `${firstError} (+${failures - 1} more)` : firstError;
    return { complete, changed, ...(error === undefined ? {} : { error }) };
  }

  private stagingRoot(): string {
    return path.join(mirrorRoot(), STAGING_DIRNAME);
  }

  /**
   * Pull one file in chunks into staging, verify sha256, rename into place.
   * The bytes must hash to the listing's figure or to the hash the master
   * served at eof (the file as it was when read, for a file rewritten in
   * between); the record returned names the bytes that landed.
   */
  private async fetchFile(kind: MirrorReadKind, guildId: string | undefined, entry: SyncFileEntry, targetAbs: string): Promise<MirrorFileRecord> {
    if (entry.size > SYNC_MAX_FILE_BYTES) throw new Error(`file exceeds the mirror size cap (${entry.size} bytes)`);
    fs.mkdirSync(this.stagingRoot(), { recursive: true });
    const stagingFile = path.join(this.stagingRoot(), `dl-${process.pid}-${++this.stagingCounter}.tmp`);
    const hash = createHash('sha256');
    let offset = 0;
    let served: string | undefined;
    const fd = fs.openSync(stagingFile, 'w');
    try {
      for (;;) {
        const reply = await this.hooks.request(MSG.MIRROR_READ, { term: this.hooks.getTerm(), kind, guildId, path: entry.path, offset });
        if (!reply || reply.ok === false) throw new Error(reply?.reason ? `read refused: ${reply.reason}` : 'read failed');
        if (typeof reply.dataB64 !== 'string') throw new Error('malformed read reply');
        const chunk = Buffer.from(reply.dataB64, 'base64');
        if (chunk.length > 0) {
          fs.writeSync(fd, chunk);
          hash.update(chunk);
          offset += chunk.length;
        }
        if (offset > SYNC_MAX_FILE_BYTES) throw new Error('read overran the mirror size cap');
        if (reply.eof) {
          if (typeof reply.sha256 === 'string') served = reply.sha256;
          break;
        }
        if (chunk.length === 0) throw new Error('read stalled');
      }
    } finally {
      fs.closeSync(fd);
    }
    const got = hash.digest('hex');
    if (got !== entry.sha256 && got !== served) {
      fs.rmSync(stagingFile, { force: true });
      throw new Error('sha256 mismatch (the bytes match neither the listing nor the file as served)');
    }
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    renameWithRetry(stagingFile, targetAbs);
    return { size: offset, sha256: got };
  }
}
