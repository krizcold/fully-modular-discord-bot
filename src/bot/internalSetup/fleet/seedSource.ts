// The backup's side of the seed of a new master (B4f-3, PLAN_REPLICATION
// 20.20): what copy this node can offer a master holding to be seeded (its
// mirror of a master, or its own live guild data after a mastership), and the
// push of that copy over the transfer channel once the operator confirmed.

import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR, MIRROR_DOC_NAMES, XFER_DELTA_THRESHOLD_FILES, XFER_DIAL_RETRY_MS, XFER_DIAL_RETRY_WINDOW_MS, XFER_MAX_ROUNDS } from './constants';
import type { PersistedFleetConfig, PersistedMigrations, PersistedPlan, PersistedTerm } from './controlStore';
import { migrationsHoldTogether } from './controlStore';
import { adoptStarted, readOwnerNodeId, recordsOfAnotherPlan } from './fileFailover';
import { readHolderSighting } from './holderSighting';
import { mirrorDocsDir, mirrorGuildDir, mirrorRoot, readMirrorManifest } from './mirrorEngine';
import { dialTransfer, TransferSender } from './migration/transferChannel';
import { MSG, SeedAbortPayload, SeedOffer, SeedOfferGuild, SeedPushPayload, SeedReportPayload } from './protocol';
import { hashNamespaceAt } from '../utils/dataInterchange';
import { flushGuild } from '../utils/dataManager';

const isGuildId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function fleetFile(name: string): string {
  return dataPath('global', FLEET_DIR, name);
}

function listNumericDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && isGuildId(e.name)).map(e => e.name).sort();
  } catch {
    return [];
  }
}

/** Bytes of the files a copy ships (the sidecars .owner, .freeze and *.tmp are not part of the namespace). */
function sizeOfDir(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name === '.owner' || entry.name === '.freeze' || entry.name.endsWith('.tmp')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOfDir(full);
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* vanished */ }
    }
  }
  return total;
}

/**
 * The documents a copy carries, as text. Null when the plan or the fleet
 * config is missing or does not parse, or the migration records do not
 * parse, do not hold together or were listed with another plan: the pin
 * needs all three.
 */
function readDocuments(dir: string): Record<string, string> | null {
  const documents: Record<string, string> = {};
  for (const name of MIRROR_DOC_NAMES) {
    try {
      documents[name] = fs.readFileSync(path.join(dir, name), 'utf-8');
    } catch (error) {
      // An unreadable pause document still counts, as the store reads it: a
      // marker pauses, a proposal is one the pin names unreadable.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (name === 'reshard-pending.json') documents[name] = '{}';
        if (name === 'redistribute-proposal.json') documents[name] = '';
      }
    }
  }
  const plan = documents['leases.json'] === undefined ? null : readJsonText<PersistedPlan>(documents['leases.json']);
  const config = documents['fleet-config.json'] === undefined ? null : readJsonText<PersistedFleetConfig>(documents['fleet-config.json']);
  if (!plan || !Array.isArray(plan.assignments) || !config || !Array.isArray(config.masterCandidates)) return null;
  if (documents['migrations.json'] !== undefined) {
    const records = readJsonText<{ planSha256?: unknown }>(documents['migrations.json']);
    if (records === null || !migrationsHoldTogether(records as PersistedMigrations) || recordsOfAnotherPlan(records, documents['leases.json']!)) return null;
  }
  return documents;
}

function readJsonText<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * The term of this node's own mastership, from a term.json that names it; 0
 * when it never minted one, or when that row is older than `notBefore` (the
 * last registration with another master: terms are per node in file mode,
 * so a mastership counts by WHEN it was, never by its number against others').
 */
export function ownMastershipTerm(selfNodeId: string, notBefore = 0): number {
  const term = readJson<PersistedTerm>(fleetFile('term.json'));
  if (!term || term.nodeId !== selfNodeId || !Number.isFinite(term.term)) return 0;
  if (notBefore > 0 && !(Number.isFinite(term.updatedAt) && term.updatedAt > notBefore)) return 0;
  return term.term;
}

export interface SeedOfferOutcome {
  offer: SeedOffer | null;
  /** Why nothing is offered, in the words the holding master shows beside this node. */
  reason: string | null;
}

/**
 * The copy this node can seed a new master from. Its mirror of another master
 * comes first: a complete copy, with the placement documents the pin needs.
 * Otherwise its own live guild data, offered only when this node's last
 * mastership is the latest holding it knows of (its term.json names it, and no
 * master it registered with since held a higher term), so an old mastership's
 * leftovers never pose as the fleet's data.
 */
export function buildSeedOffer(selfNodeId: string, selfNodeName: string): SeedOfferOutcome {
  const now = Date.now();
  // A promote of this node is adopting its copy (running or parked): what it
  // moved into the live tree has left the mirror, and a seed would ship the
  // rest as partial. Cancel it or let it finish first.
  if (adoptStarted()) return { offer: null, reason: 'a promote of this node is adopting its copy (running or parked), so it offers no copy; Demote the holding master first if this node is registered with one, then Continue the promote on this node\'s Fleet tab' };
  const manifest = readMirrorManifest();
  if (manifest && manifest.sourceNodeId !== null && manifest.sourceNodeId !== selfNodeId) {
    const sourceName = manifest.sourceNodeName ?? manifest.sourceNodeId.slice(0, 8);
    if (manifest.completedAt === null) {
      return { offer: null, reason: `this node's copy of ${sourceName}'s guild data was never complete (its Backup copy line names the last failed attempt, if one ran since this node started)` };
    }
    // A copy of a previous master (this node registered with a later one since,
    // the foreign-copy hold of B4f-2): seeding from it would lose that master's
    // whole tenure, as a promote of it would, so neither takes it.
    const sighting = readHolderSighting();
    if (sighting && sighting.nodeId !== selfNodeId && sighting.nodeId !== manifest.sourceNodeId) {
      return { offer: null, reason: `this node's copy is of ${sourceName}'s guild data, but the master it last registered with is node ${sighting.nodeId.slice(0, 8)} (term ${sighting.term}), which held the fleet after ${sourceName}: a copy of a previous master seeds no new master, as it promotes none; drop it once registered with a serving master` };
    }
    const documents = readDocuments(mirrorDocsDir());
    if (!documents) return { offer: null, reason: `this node's copy of ${sourceName}'s guild data carries no usable placement documents (leases.json, fleet-config.json) or its migration records (migrations.json) do not parse, do not hold together or were listed with another plan, so a master seeded from it could not pin the shard plan` };
    // A migration moved guilds of this copy onto this node and no settled
    // pass has run since (B4f-4): its plan may not yet place them on this
    // node, where their data is, so a seed would serve them empty.
    if (manifest.droppedAt != null) return { offer: null, reason: `a migration moved guild(s) of this node's copy of ${sourceName}'s guild data onto this node's live tree, and no complete pass has run since with ${sourceName}'s plan settled (no migration, reshard or unconfirmed grant under way there, and its migration records readable), so the copy's plan may not yet place them on this node; the copy is whole again after such a pass while ${sourceName} serves (with unreadable records, once ${sourceName} restarts with them readable). If ${sourceName} is gone, Demote the holding master first if this node is registered with one, then Promote this node from its Fleet tab instead (the promote keeps the guilds moved here), and seed the new master from it afterwards` };
    const guilds: SeedOfferGuild[] = [];
    let partialCount = 0;
    let totalBytes = 0;
    const torn: string[] = [];
    for (const guildId of Object.keys(manifest.guilds).filter(isGuildId).sort()) {
      const record = manifest.guilds[guildId];
      // A guild dir the copy no longer holds was moved into this node's live
      // tree by a promote's adopt (cancelled or parked): the copy is torn, and
      // a seed from it would land that guild empty.
      if (!fs.existsSync(mirrorGuildDir(guildId))) {
        torn.push(guildId);
        continue;
      }
      const hash = record.hash;
      if (hash === null) partialCount += 1;
      const bytes = sizeOfDir(mirrorGuildDir(guildId));
      totalBytes += bytes;
      guilds.push({ guildId, hash, bytes });
    }
    if (torn.length > 0) {
      return { offer: null, reason: `this node's copy of ${sourceName}'s guild data is torn: ${torn.length} guild(s) were moved into this node's live tree by a promote of this node, so it seeds no other master; Demote the holding master first if this node is registered with one, then Promote this node again (it adopts the rest of the copy), or drop the copy once registered with a serving master (under the copy's own master it heals by itself)` };
    }
    return {
      offer: {
        kind: 'mirror',
        sourceNodeId: manifest.sourceNodeId,
        sourceNodeName: sourceName,
        sourceTerm: manifest.sourceTerm ?? 0,
        completedAt: manifest.completedAt,
        ageMs: Math.max(0, now - manifest.completedAt),
        guilds,
        partialCount,
        totalBytes,
        documents,
      },
      reason: null,
    };
  }
  const ownAny = ownMastershipTerm(selfNodeId);
  if (ownAny <= 0) {
    return { offer: null, reason: 'this node holds no complete copy of a master\'s guild data and has never been a master itself' };
  }
  const sighting = readHolderSighting();
  const ownTerm = ownMastershipTerm(selfNodeId, sighting && sighting.nodeId !== selfNodeId ? sighting.seenAt : 0);
  if (ownTerm <= 0) {
    return { offer: null, reason: `this node's own mastership (term ${ownAny}) is older than its last registration with another master (node ${sighting!.nodeId.slice(0, 8)} at term ${sighting!.term}), so its live guild data is not the fleet's latest` };
  }
  const documents = readDocuments(fleetFile(''));
  if (!documents) return { offer: null, reason: `this node was a master (term ${ownTerm}) but its fleet directory carries no usable placement documents from that mastership, or its migration records do not parse, do not hold together or were listed with another plan` };
  const guilds: SeedOfferGuild[] = [];
  let totalBytes = 0;
  for (const guildId of listNumericDirs(DATA_ROOT)) {
    const owner = readOwnerNodeId(path.join(DATA_ROOT, guildId));
    if (owner !== null && owner !== selfNodeId) continue;
    const bytes = sizeOfDir(path.join(DATA_ROOT, guildId));
    totalBytes += bytes;
    guilds.push({ guildId, hash: null, bytes });
  }
  if (guilds.length === 0) return { offer: null, reason: `this node was a master (term ${ownTerm}) but holds no guild data of its own` };
  return {
    offer: {
      kind: 'live',
      sourceNodeId: selfNodeId,
      sourceNodeName: selfNodeName,
      sourceTerm: ownTerm,
      completedAt: null,
      ageMs: null,
      guilds,
      partialCount: 0,
      totalBytes,
      documents,
    },
    reason: null,
  };
}

export type SeedPushPhase = 'dialing' | 'copying' | 'sent' | 'failed';

/** The co-worker's view of the push it runs for a holding master. */
export interface SeedPushView {
  seedId: string;
  phase: SeedPushPhase;
  round: number;
  filesSent: number;
  bytesSent: number;
  startedAt: number;
  /** When the final round and the hashes went out; the backup's own file promote waits on it. */
  sentAt: number | null;
  /** The master that asked for the push; a seeded master keeps its node id. */
  masterNodeId: string | null;
  /** When this node registered with that master serving, after the push was sent: the seed landed. */
  landedAt: number | null;
  error: string | null;
}

/** What this node last answered a holding master's offer ask with (B4f-3), for its own Fleet tab. */
export interface SeedOfferView {
  at: number;
  offered: boolean;
  reason: string | null;
}

export interface SeedSourceHooks {
  selfNodeId: string;
  selfNodeName: string;
  getTerm: () => number;
  /** The master this node last registered with. */
  masterNodeId: () => string | null;
  sendToMaster: (type: string, data: any) => void;
  onChanged: () => void;
}

/**
 * Answers the holding master's requests: SEED_OFFER with what this node holds,
 * SEED_PUSH by dialing the master's transfer endpoint with the single-use token
 * and streaming the copy (bulk round, delta rounds to convergence, a final
 * round), then reporting the hashes of what it shipped. One push at a time.
 */
export class SeedSource {
  private push: SeedPushView | null = null;
  private lastOffer: SeedOfferView | null = null;
  private ws: WebSocket | null = null;
  private lastFinal: { seedId: string; guildHashes: Record<string, string> } | null = null;

  constructor(private readonly hooks: SeedSourceHooks) {}

  getView(): SeedPushView | null {
    return this.push;
  }

  getOfferView(): SeedOfferView | null {
    return this.lastOffer;
  }

  /** The master this node pushed to registers it as a serving master: the seed landed. */
  noteServingMaster(masterNodeId: string): void {
    const view = this.push;
    if (!view || view.phase !== 'sent' || view.landedAt !== null || view.masterNodeId !== masterNodeId) return;
    view.landedAt = Date.now();
    this.hooks.onChanged();
  }

  async handle(type: string, data: any): Promise<any> {
    if (type === MSG.SEED_OFFER) {
      const outcome = buildSeedOffer(this.hooks.selfNodeId, this.hooks.selfNodeName);
      this.lastOffer = { at: Date.now(), offered: outcome.offer !== null, reason: outcome.reason };
      this.hooks.onChanged();
      return { ok: true, offer: outcome.offer, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    }
    if (type === MSG.SEED_PUSH) return this.startPush(data as SeedPushPayload);
    if (type === MSG.SEED_ABORT) return this.abort(data as SeedAbortPayload);
    return { ok: false, reason: `unknown-seed:${type}` };
  }

  private startPush(payload: SeedPushPayload): { ok: boolean; reason?: string } {
    if (!payload || typeof payload.seedId !== 'string' || payload.seedId === '' || typeof payload.token !== 'string' || payload.token === '' || typeof payload.peerUrl !== 'string' || payload.peerUrl === '') {
      return { ok: false, reason: 'malformed seed push' };
    }
    if (payload.kind !== 'mirror' && payload.kind !== 'live') return { ok: false, reason: 'unknown copy kind' };
    if (!Array.isArray(payload.guilds) || !payload.guilds.every(isGuildId)) return { ok: false, reason: 'malformed guild list' };
    if (this.push && (this.push.phase === 'dialing' || this.push.phase === 'copying')) {
      return { ok: false, reason: `a push is already running (${this.push.seedId})` };
    }
    // The copy must still be what was offered: the master decided on it.
    const outcome = buildSeedOffer(this.hooks.selfNodeId, this.hooks.selfNodeName);
    if (!outcome.offer || outcome.offer.kind !== payload.kind) {
      return { ok: false, reason: outcome.offer ? `this node now offers its ${outcome.offer.kind} copy, not the ${payload.kind} one the seed named; ask for the offer again` : (outcome.reason ?? 'nothing to offer') };
    }
    const offered = new Set(outcome.offer.guilds.map(g => g.guildId));
    const missing = payload.guilds.filter(g => !offered.has(g));
    if (missing.length > 0) return { ok: false, reason: `the copy no longer holds guild(s) ${missing.slice(0, 5).join(', ')}; ask for the offer again` };
    this.push = { seedId: payload.seedId, phase: 'dialing', round: 0, filesSent: 0, bytesSent: 0, startedAt: Date.now(), sentAt: null, masterNodeId: this.hooks.masterNodeId(), landedAt: null, error: null };
    this.hooks.onChanged();
    void this.runPush(payload);
    return { ok: true };
  }

  private report(seedId: string, extra: Partial<SeedReportPayload> = {}): void {
    const view = this.push;
    if (!view || view.seedId !== seedId) return;
    const payload: SeedReportPayload = {
      term: this.hooks.getTerm(),
      seedId,
      round: view.round,
      filesSent: view.filesSent,
      bytesSent: view.bytesSent,
      ...extra,
    };
    this.hooks.sendToMaster(MSG.SEED_REPORT, payload);
    this.hooks.onChanged();
  }

  /**
   * A final report sent while the control channel was down is lost, and the
   * master would fail a healthy push for want of its hashes: every
   * registration resends it while the push stands as sent.
   */
  resendFinal(): void {
    const view = this.push;
    if (!view || view.phase !== 'sent' || !this.lastFinal || this.lastFinal.seedId !== view.seedId) return;
    this.report(view.seedId, { final: { guildHashes: this.lastFinal.guildHashes } });
  }

  /** The holding master's lane failed after this node's push: the view says so instead of sent forever. */
  private abort(data: SeedAbortPayload): { ok: boolean; reason?: string } {
    const view = this.push;
    if (!view || !data || typeof data.seedId !== 'string' || view.seedId !== data.seedId) return { ok: false, reason: 'no such push' };
    if (view.phase === 'failed') return { ok: true };
    view.phase = 'failed';
    view.sentAt = null;
    view.error = `the master's seed failed: ${typeof data.reason === 'string' && data.reason !== '' ? data.reason : 'no reason given'}`;
    try { this.ws?.terminate(); } catch { /* closing */ }
    this.ws = null;
    console.warn(`[Fleet] Seed push ${view.seedId}: ${view.error}`);
    this.hooks.onChanged();
    return { ok: true };
  }

  private fail(seedId: string, reason: string): void {
    const view = this.push;
    if (!view || view.seedId !== seedId || view.phase === 'failed' || view.phase === 'sent') return;
    view.phase = 'failed';
    view.error = reason;
    console.warn(`[Fleet] Seed push ${seedId} failed: ${reason}`);
    this.report(seedId, { error: reason });
    try { this.ws?.terminate(); } catch { /* closing */ }
    this.ws = null;
  }

  private dial(payload: SeedPushPayload): Promise<WebSocket> {
    // The master binds its transfer listener before it hands the token over,
    // so a refused dial is a transient fault and is retried inside the window.
    const deadline = Date.now() + XFER_DIAL_RETRY_WINDOW_MS;
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        const ws = dialTransfer(payload.peerUrl, payload.token);
        let opened = false;
        ws.once('open', () => {
          opened = true;
          resolve(ws);
        });
        ws.once('error', (error: Error) => {
          if (opened) return;
          if (Date.now() < deadline) {
            setTimeout(attempt, XFER_DIAL_RETRY_MS).unref();
            return;
          }
          reject(new Error(`dial to ${payload.peerUrl} failed: ${error.message}`));
        });
      };
      attempt();
    });
  }

  private async runPush(payload: SeedPushPayload): Promise<void> {
    const { seedId } = payload;
    const view = this.push!;
    try {
      const ws = await this.dial(payload);
      this.ws = ws;
      view.phase = 'copying';
      this.hooks.onChanged();
      const rootDir = payload.kind === 'mirror' ? mirrorRoot() : DATA_ROOT;
      const sender = new TransferSender(ws, { migrationId: seedId, legId: 'copy', guilds: () => payload.guilds, rootDir });
      // Bulk round, then delta rounds until the copy converges (a copy nobody
      // writes converges on its first delta), then the final round the master
      // verifies against the hashes reported below.
      let round = 0;
      for (;;) {
        const progress = await sender.sendRound(round);
        view.round = round;
        view.filesSent += progress.filesSent;
        view.bytesSent += progress.bytesSent;
        this.report(seedId);
        if (round > 0 && progress.filesSent <= XFER_DELTA_THRESHOLD_FILES) break;
        if (round >= XFER_MAX_ROUNDS - 1) break;
        round += 1;
      }
      const finalRound = round + 1;
      const progress = await sender.sendRound(finalRound);
      view.round = finalRound;
      view.filesSent += progress.filesSent;
      view.bytesSent += progress.bytesSent;
      sender.finish(finalRound);
      const guildHashes: Record<string, string> = {};
      for (const guildId of payload.guilds) {
        if (payload.kind === 'live') await flushGuild(guildId);
        guildHashes[guildId] = (await hashNamespaceAt(path.join(rootDir, guildId))).namespaceHash;
      }
      // An abort or a failure landed while the hashes were computed (the phase
      // moves under the awaits, past the narrowing): it stands.
      if ((view.phase as SeedPushPhase) === 'failed') return;
      view.phase = 'sent';
      view.sentAt = Date.now();
      this.lastFinal = { seedId, guildHashes };
      this.report(seedId, { final: { guildHashes } });
      console.log(`[Fleet] Seed push ${seedId}: ${payload.guilds.length} guild(s) shipped in ${finalRound + 1} round(s), ${view.filesSent} file(s), hashes reported`);
    } catch (error) {
      this.fail(seedId, error instanceof Error ? error.message : String(error));
    }
  }
}
