// Master-side guild-data mirror authority (B4f-1; fleet master only, never
// constructed standalone). Lists this node's live guild dirs with per-file
// sha256 behind a size+mtime snapshot, so a listing a minute rehashes only
// what changed, and serves chunk reads at an offset. WHO may ask is the
// bootstrap's gate (the designated backup, in file mode); this module trusts
// its caller on that and guards only WHAT is read.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { flushGuild } from '../utils/dataManager';
import { freezeSentinelExists } from '../utils/dataBackends/fileBackend';
import { hashFileStreamed, isExcludedNamespaceName, namespaceHashOf, safeImportTarget } from '../utils/dataInterchange';
import { FLEET_DIR, MIRROR_DOC_NAMES, MIRROR_REVISION_FILENAME, SYNC_CHUNK_BYTES } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { assertSyncableSize } from './syncManifest';
import { MSG, MirrorGuildEntry, MirrorListReply, MirrorReadReply, MirrorReadRequest, SyncFileEntry } from './protocol';

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface PersistedMirrorRevision {
  revision: number;
  overallHash: string;
  updatedAt: number;
}

export interface MirrorAuthorityHooks {
  nodeId: string;
  nodeName: string;
  getTerm: () => number;
  /**
   * The placement documents as the CONTROL STORE holds them now, by their
   * fleet-dir names: a file-mode fleet on a Postgres control store keeps stale
   * files under /data/global/fleet, so the files are never read for this.
   */
  documents: () => Promise<{ name: string; body: string }[]>;
  /** Whether this master's stored plan may not place every shard as it serves them. */
  placementPending: () => boolean;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isMirrorRequest(type: string): boolean {
  return type === MSG.MIRROR_LIST || type === MSG.MIRROR_READ;
}

export function serveMirrorRequest(authority: MirrorAuthority, type: string, data: any): Promise<any> {
  switch (type) {
    case MSG.MIRROR_LIST:
      return authority.list();
    case MSG.MIRROR_READ:
      return authority.read(data as MirrorReadRequest);
    default:
      return Promise.reject(new Error(`unknown mirror request: ${type}`));
  }
}

function byPath(a: SyncFileEntry, b: SyncFileEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// The listing must never mistake a disk it cannot read for a master with
// nothing on it: the backup deletes what the listing lacks. So every read
// error but "vanished" (ENOENT) aborts the listing, and the backup's tick
// ends degraded with its copy untouched. The facade's listGuilds swallows
// errors into an empty list, which is exactly the wrong answer here.
async function listGuildDirsStrict(): Promise<string[]> {
  const entries = await fs.promises.readdir(DATA_ROOT, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name).sort();
}

async function* walkStrict(base: string, rel = ''): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rel ? path.join(base, ...rel.split('/')) : base, { withFileTypes: true });
  } catch (error) {
    if (isGone(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (isExcludedNamespaceName(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkStrict(base, childRel);
    else if (entry.isFile()) yield childRel;
  }
}

export class MirrorAuthority {
  private readonly snapshot = new Map<string, FileSnapshot>();
  /** The documents of the last listing, served by MIRROR_READ exactly as listed. */
  private documentBodies = new Map<string, Buffer>();
  private revision: number;
  private overallHash: string | null;
  private listing: Promise<MirrorListReply> | null = null;

  constructor(private readonly hooks: MirrorAuthorityHooks) {
    const stored = this.load();
    this.revision = stored?.revision ?? 0;
    this.overallHash = stored?.overallHash ?? null;
  }

  getRevision(): number {
    return this.revision;
  }

  /**
   * Single-flight: a listing already running answers every concurrent caller.
   * One that joins it reads the plan as pending: that listing began before
   * its request, so it says nothing of the plan since.
   */
  list(): Promise<MirrorListReply> {
    if (this.listing) return this.listing.then(listing => ({ ...listing, placementPending: true }));
    this.listing = this.buildListing().finally(() => { this.listing = null; });
    return this.listing;
  }

  async read(req: MirrorReadRequest): Promise<MirrorReadReply> {
    const offset = Number(req?.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid offset: ${String(req?.offset)}`);
    if (req?.kind === 'document') return this.readDocument(req, offset);
    const file = this.resolveGuildReadTarget(req);
    // Size and eof come from the open descriptor, never from a stat by path: an
    // atomic replace landing between a stat and the open would otherwise serve
    // the first old-size bytes of the new file as a whole one.
    let chunk: Buffer;
    let size: number;
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error(`mirror path is not a file: ${req.path}`);
      assertSyncableSize(req.path, stat.size);
      size = stat.size;
      const buffer = Buffer.alloc(Math.min(SYNC_CHUNK_BYTES, Math.max(0, size - offset)));
      const bytesRead = buffer.length > 0 ? fs.readSync(fd, buffer, 0, buffer.length, offset) : 0;
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
    const eof = offset + chunk.length >= size;
    if (!eof) return { dataB64: chunk.toString('base64'), eof };
    // The hash of the file as served, for a file the master rewrites between
    // the listing and this read (a hot file would otherwise never land): exact
    // for a file that fits one chunk, the whole file as it is now otherwise,
    // which a pull torn across chunks fails and retries next tick.
    const sha256 = offset === 0 ? sha256Of(chunk) : (await hashFileStreamed(file)).sha256;
    return { dataB64: chunk.toString('base64'), eof, sha256 };
  }

  private readDocument(req: MirrorReadRequest, offset: number): MirrorReadReply {
    if (typeof req.path !== 'string' || !(MIRROR_DOC_NAMES as readonly string[]).includes(req.path)) {
      throw new Error(`mirror document not served: ${String(req?.path)}`);
    }
    const body = this.documentBodies.get(req.path);
    if (!body) throw new Error(`mirror document not listed: ${req.path}`);
    const chunk = body.subarray(offset, Math.min(body.length, offset + SYNC_CHUNK_BYTES));
    const eof = offset + chunk.length >= body.length;
    return eof ? { dataB64: chunk.toString('base64'), eof, sha256: sha256Of(body) } : { dataB64: chunk.toString('base64'), eof };
  }

  private resolveGuildReadTarget(req: MirrorReadRequest): string {
    if (req?.kind !== 'guild') throw new Error(`unknown mirror read kind: ${String(req?.kind)}`);
    if (typeof req.guildId !== 'string' || !/^\d+$/.test(req.guildId)) throw new Error(`invalid mirror guild: ${String(req.guildId)}`);
    const target = safeImportTarget(path.resolve(DATA_ROOT, req.guildId), req.path);
    if (!target) throw new Error(`mirror path escapes the guild dir: ${String(req.path)}`);
    if (req.path.split('/').some(segment => isExcludedNamespaceName(segment))) {
      throw new Error(`mirror path is a node-local sidecar: ${req.path}`);
    }
    return target;
  }

  private async buildListing(): Promise<MirrorListReply> {
    // Read first: a plan settled before this point is what the documents
    // read below hold.
    const placementPending = this.hooks.placementPending();
    const guilds: MirrorGuildEntry[] = [];
    const frozen: string[] = [];
    const keep = new Set<string>();
    for (const guildId of await listGuildDirsStrict()) {
      if (freezeSentinelExists(guildId)) {
        // Mid-migration bytes are no copy worth taking: the backup keeps its
        // last one, and the snapshot keeps these hashes for the next listing.
        frozen.push(guildId);
        for (const key of this.snapshot.keys()) if (key.startsWith(`${guildId}/`)) keep.add(key);
        continue;
      }
      await flushGuild(guildId);
      const base = path.join(DATA_ROOT, guildId);
      const files: SyncFileEntry[] = [];
      for await (const relPath of walkStrict(base)) {
        const file = path.join(base, ...relPath.split('/'));
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(file);
        } catch (error) {
          if (isGone(error)) continue;
          throw error;
        }
        if (!stat.isFile()) continue;
        const key = `${guildId}/${relPath}`;
        const prev = this.snapshot.get(key);
        let sha256: string;
        if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
          sha256 = prev.sha256;
        } else {
          try {
            sha256 = (await hashFileStreamed(file)).sha256;
          } catch (error) {
            if (isGone(error)) continue;
            throw error;
          }
          this.snapshot.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
        }
        keep.add(key);
        files.push({ path: relPath, size: stat.size, sha256 });
      }
      files.sort(byPath);
      const hash = namespaceHashOf(files.map(f => ({ relPath: f.path, size: f.size, sha256: f.sha256 }))).namespaceHash;
      guilds.push({ guildId, hash, files });
    }
    for (const key of this.snapshot.keys()) if (!keep.has(key)) this.snapshot.delete(key);

    const documents: SyncFileEntry[] = [];
    const bodies = new Map<string, Buffer>();
    for (const doc of await this.hooks.documents()) {
      if (!(MIRROR_DOC_NAMES as readonly string[]).includes(doc.name)) continue;
      const body = Buffer.from(doc.body, 'utf-8');
      bodies.set(doc.name, body);
      documents.push({ path: doc.name, size: body.length, sha256: sha256Of(body) });
    }
    this.documentBodies = bodies;

    const overall = createHash('sha256');
    for (const guild of guilds) overall.update(`${guild.guildId}\n${guild.hash}\n`);
    for (const doc of documents) overall.update(`${doc.path}\n${doc.sha256}\n`);
    const overallHash = overall.digest('hex');
    if (overallHash !== this.overallHash) {
      this.revision += 1;
      this.overallHash = overallHash;
      this.persist();
    }
    return {
      revision: this.revision,
      sourceNodeId: this.hooks.nodeId,
      sourceNodeName: this.hooks.nodeName,
      sourceTerm: this.hooks.getTerm(),
      listedAt: Date.now(),
      guilds,
      frozen,
      documents,
      placementPending,
    };
  }

  private file(): string {
    return dataPath('global', FLEET_DIR, MIRROR_REVISION_FILENAME);
  }

  private load(): PersistedMirrorRevision | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf-8')) as PersistedMirrorRevision;
      if (!Number.isInteger(parsed?.revision) || parsed.revision < 0 || typeof parsed.overallHash !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(): void {
    const record: PersistedMirrorRevision = { revision: this.revision, overallHash: this.overallHash ?? '', updatedAt: Date.now() };
    try {
      atomicWriteFileSync(this.file(), JSON.stringify(record, null, 2));
    } catch (error) {
      console.warn('[Fleet] Mirror revision persist failed:', error instanceof Error ? error.message : error);
    }
  }
}
