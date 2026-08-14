// Node-side transformation duties: TRANSFORM_GUILD (freeze -> flush -> export
// -> staged import -> hash-verify -> ownership claim -> per-guild route flip
// -> unfreeze) and BACKEND_FLIP (default swap + own marker write). Idempotent:
// a re-issued guild hashes both sides first and short-circuits on match.

import { MSG, TransformGuildPayload, TransformGuildAckPayload, BackendFlipPayload, BackendFlipAckPayload } from '../protocol';
import { DataBackendKind } from '../../../../utils/envLoader';
import {
  flushGuildOutcome,
  freezeGuildWrites,
  unfreezeGuildWrites,
  fenceFromOwnerInfo,
  stampOwner,
  getGuildDataBackend,
} from '../../utils/dataManager';
import { getWorkingSet } from '../../utils/dataBackends/workingSet';
import {
  writeFreezeSentinel,
  removeFreezeSentinel,
  graveyardGuildDir,
  dropPendingForGuild,
  guildDirExists,
} from '../../utils/dataBackends/fileBackend';
import { setRouteOverride } from '../../utils/dataBackends/routeResolver';
import { getActiveBackendUrl, applyBackendFlip, ensureRuntimeWith } from '../../utils/dataBackends/boot';
import { PostgresBackend } from '../../utils/dataBackends/postgresBackend';
import { importNamespace } from '../../utils/dataInterchange';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import * as fs from 'fs';
import * as path from 'path';
import {
  collectFileRecords,
  collectDirRecords,
  recordsFromRows,
  hashRecords,
  importRecordsToPostgres,
  claimGuildOwnership,
  commitStagedFileDir,
  stagingDirFor,
  sweepTransformStaging,
} from './convertEngine';

const SOURCE_FLUSH_DEADLINE_MS = 30000;
const RUNTIME_READY_WAIT_MS = 15000;

export interface TransformationExecutorOptions {
  getTerm: () => number;
  /** Fired after a BACKEND_FLIP applies (co-workers refresh their capability). */
  onFlipped?: (backend: DataBackendKind) => void;
}

export class TransformationExecutor {
  private sweptFor: string | null = null;
  private inFlight = 0;

  constructor(private readonly opts: TransformationExecutorOptions) { }

  /** Live TRANSFORM_GUILD/BACKEND_FLIP work on this node; feeds the promote precheck. */
  isBusy(): boolean {
    return this.inFlight > 0;
  }

  async handle(type: string, data: any): Promise<any> {
    this.inFlight++;
    try {
      if (type === MSG.TRANSFORM_GUILD) return await this.handleTransformGuild(data as TransformGuildPayload);
      if (type === MSG.BACKEND_FLIP) return await this.handleBackendFlip(data as BackendFlipPayload);
      return { ok: false, reason: `unknown-type:${type}` };
    } finally {
      this.inFlight--;
    }
  }

  private async handleTransformGuild(payload: TransformGuildPayload): Promise<TransformGuildAckPayload> {
    const { transformationId, term, guildId, direction } = payload;
    if (term !== this.opts.getTerm()) return { ok: false, reason: 'stale-term' };
    if (payload.phase === 'retire-source') return this.retireSource(payload);

    const sourceIsFile = direction === 'file-to-postgres';
    // Either direction needs the postgres runtime: as the destination it must
    // be able to serve the guild the moment its route flips; as the source it
    // must be readable to export. A node whose env never carried the URL
    // constructs it from the payload-delivered one.
    if (getActiveBackendUrl() === null && payload.url) ensureRuntimeWith(payload.url);
    const url = getActiveBackendUrl();
    if (!url) return { ok: false, reason: 'postgres-runtime-not-ready' };
    if (!(await this.waitPostgresReady(RUNTIME_READY_WAIT_MS))) return { ok: false, reason: 'database-unreachable' };
    const backend = getGuildDataBackend() as PostgresBackend;
    const fence = fenceFromOwnerInfo(guildId);
    if (!fence) return { ok: false, reason: 'no-fence' };

    if (this.sweptFor !== transformationId) {
      await sweepTransformStaging(transformationId);
      this.sweptFor = transformationId;
    }

    freezeGuildWrites(guildId);
    if (sourceIsFile) await writeFreezeSentinel(guildId);
    try {
      const flushed = await flushGuildOutcome(guildId, SOURCE_FLUSH_DEADLINE_MS);
      if (flushed !== 'ok') return { ok: false, reason: `source flush ${flushed}` };

      const sourceRecords = sourceIsFile
        ? await collectFileRecords(guildId)
        : recordsFromRows(guildId, await backend.readGuildRecords(guildId));
      const { namespaceHash } = hashRecords(sourceRecords);
      const destRecords = sourceIsFile
        ? recordsFromRows(guildId, await backend.readGuildRecords(guildId))
        : await collectDirRecords(guildId, path.join(DATA_ROOT, guildId));
      const destAlreadyMatches = hashRecords(destRecords).namespaceHash === namespaceHash;

      if (sourceIsFile) {
        if (!destAlreadyMatches) {
          const res = await importRecordsToPostgres(url, guildId, sourceRecords, fence, namespaceHash);
          if (!res.ok) return { ok: false, reason: res.reason };
        } else {
          // Crash re-issue (or an empty namespace): the rows are already
          // there, but the catalog claim must still exist.
          const claim = await claimGuildOwnership(url, guildId, fence);
          if (!claim.ok) return { ok: false, reason: claim.reason };
        }
        setRouteOverride(guildId, 'postgres');
      } else {
        if (!destAlreadyMatches) {
          const staging = stagingDirFor(transformationId, guildId);
          await fs.promises.rm(staging, { recursive: true, force: true });
          await importNamespace(guildId, sourceRecords, staging);
          const stagedHash = hashRecords(await collectDirRecords(guildId, staging)).namespaceHash;
          if (stagedHash !== namespaceHash) {
            await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
            return { ok: false, reason: `staged verify mismatch: ${stagedHash} != ${namespaceHash}` };
          }
          const committed = await commitStagedFileDir(guildId, staging, `transform-${transformationId}-replaced`);
          if (!committed.ok) return { ok: false, reason: committed.reason };
        }
        setRouteOverride(guildId, 'file');
        getWorkingSet()?.evict(guildId);
        stampOwner(guildId);
      }
      return { ok: true, namespaceHash };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (sourceIsFile) await removeFreezeSentinel(guildId);
      unfreezeGuildWrites(guildId);
    }
  }

  /** RETIRING pass: graveyard the source-side data this node still holds for a converted guild. */
  private async retireSource(payload: TransformGuildPayload): Promise<TransformGuildAckPayload> {
    const { transformationId, guildId, direction } = payload;
    const reason = `transform-${transformationId}-source-retired`;
    try {
      if (direction === 'file-to-postgres') {
        dropPendingForGuild(guildId);
        await removeFreezeSentinel(guildId);
        if (!guildDirExists(guildId)) return { ok: true };
        const moved = await graveyardGuildDir(guildId, reason);
        return moved ? { ok: true } : { ok: false, reason: 'graveyard rename failed' };
      }
      // A node that flipped to file may never have constructed the runtime
      // (offline at the broadcast); the retire message carries the URL.
      if (getActiveBackendUrl() === null && payload.url) ensureRuntimeWith(payload.url);
      if (!(await this.waitPostgresReady(RUNTIME_READY_WAIT_MS))) return { ok: false, reason: 'postgres-runtime-not-ready' };
      const backend = getGuildDataBackend() as PostgresBackend;
      const fence = fenceFromOwnerInfo(guildId);
      if (!fence) return { ok: false, reason: 'no-fence' };
      const res = await backend.retireGuild(guildId, reason, fence);
      if (!res.ok) return { ok: false, reason: res.reason };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleBackendFlip(payload: BackendFlipPayload): Promise<BackendFlipAckPayload> {
    if (payload.term !== this.opts.getTerm()) return { ok: false };
    if (payload.backend === 'postgres' && getActiveBackendUrl() === null && payload.url) {
      ensureRuntimeWith(payload.url);
    }
    applyBackendFlip(payload.backend);
    this.opts.onFlipped?.(payload.backend);
    await sweepTransformStaging(null);
    return { ok: true };
  }

  private async waitPostgresReady(boundMs: number): Promise<boolean> {
    const deadline = Date.now() + boundMs;
    for (; ;) {
      const backend = getGuildDataBackend();
      if (backend && getWorkingSet() && backend.healthy()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 500).unref());
    }
  }
}
