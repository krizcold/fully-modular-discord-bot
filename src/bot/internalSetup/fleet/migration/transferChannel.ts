// Node-to-node data transfer for migration (P5). WebSocket, reusing the ws
// dep and the controlServer dial/auth idiom: an x-transfer-token header
// checked timing-safe at the upgrade, single-use, bound to (migrationId,
// legId), TTL-expired. The master relays CONTROL only and never sees data
// bytes; direction is declarative by advertised transferUrl (target advertises
// -> push [source dials]; else source advertises -> pull [target dials]).
//
// Framing: text JSON control frames {t: 'hello'|'round'|'round-end'|'file-fail'|'bye'};
// binary frames = one file record [4B BE headerLen][headerJSON][raw bytes],
// chunked above XFER_CHUNK_BYTES via header o/tot. The receiver hashes while
// writing into _incoming/{migrationId}/{legId}/{g}/{p}; a mismatch triggers a
// file-fail (resend next round), 3 strikes aborts the leg. The sender awaits
// each send callback and pauses while bufferedAmount exceeds the high water.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { exportNamespace, FileRecord } from '../../utils/dataInterchange';
import { XFER_CHUNK_BYTES, XFER_HIGH_WATER_BYTES } from '../constants';

const INCOMING_DIR = '_incoming';
const FILE_STRIKE_LIMIT = 3;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tokenMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  try {
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

interface ControlFrame {
  t: 'hello' | 'round' | 'round-end' | 'file-fail' | 'bye';
  mode?: 'push' | 'pull';
  round?: number;
  final?: boolean;
  files?: number;
  bytes?: number;
  g?: string;
  p?: string;
  reason?: string;
}

interface RecordHeader {
  g: string;
  p: string;
  s: number;
  h: string;
  o?: number;
  tot?: number;
}

export interface RoundProgress {
  round: number;
  filesSent: number;
  bytesSent: number;
  guildsTotal: number;
  guildsDone: number;
  deltaFiles: number;
}

// ============================================================================
// Listener (this node is the side the peer dials).
// ============================================================================

export interface TransferServerHooks {
  /** Resolve a token to its leg context; null when unknown/expired/spent. */
  authorize: (token: string) => { migrationId: string; legId: string; role: 'source' | 'target' } | null;
  /** A pull peer (a target dialing a source) connected; the source begins streaming. */
  onPullConnected?: (legId: string, socket: WebSocket) => void;
  /** A push peer (a source dialing a target) connected; the target receives. */
  onPushConnected?: (legId: string, socket: WebSocket) => void;
}

export class TransferServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private refs = 0;

  constructor(private readonly hooks: TransferServerHooks) {}

  /** Idempotent lazy bind (ref-counted): started at the first prepare that needs to listen. */
  start(port: number): Promise<void> {
    this.refs += 1;
    if (this.httpServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('transfer channel: websocket upgrade required');
      });
      this.wss = new WebSocketServer({ noServer: true });
      this.httpServer.on('upgrade', (req, socket, head) => {
        const ctx = this.hooks.authorize(String(req.headers['x-transfer-token'] ?? ''));
        if (!ctx) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, ws => {
          if (ctx.role === 'source') this.hooks.onPullConnected?.(ctx.legId, ws);
          else this.hooks.onPushConnected?.(ctx.legId, ws);
        });
      });
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, () => {
        this.httpServer!.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** Ref-counted close: the last leg to finish tears the listener down. */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.stop();
  }

  stop(): void {
    this.refs = 0;
    try { this.wss?.close(); } catch { /* closing */ }
    try { this.httpServer?.close(); } catch { /* closing */ }
    this.wss = null;
    this.httpServer = null;
  }
}

// ============================================================================
// Sender (source side): streams bulk round 0 then delta rounds. Works over an
// already-open socket (a listening source got the pull dial; a push source
// dialed the target).
// ============================================================================

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface SenderOptions {
  migrationId: string;
  legId: string;
  guilds: () => string[];
  /** Extra dirtiness signal: a path with a pending facade op is treated as changed. */
  isDirty?: (guildId: string, relPath: string) => boolean;
}

/**
 * Drives one leg's send side over an open socket. sendRound() ships every file
 * that changed since the last round (round 0 ships all); returns the count so
 * the caller decides convergence. Per-file NACK ('file-fail') is collected and
 * the failing path is re-shipped next round; 3 strikes throws.
 */
export class TransferSender {
  private readonly snapshot = new Map<string, FileSnapshot>(); // key: g/p
  private readonly strikes = new Map<string, number>();
  private readonly failed = new Set<string>(); // keys the receiver NACKed since the last round
  private closed = false;

  constructor(private readonly ws: WebSocket, private readonly opts: SenderOptions) {
    ws.on('message', raw => this.onMessage(raw));
    ws.on('close', () => { this.closed = true; });
  }

  private onMessage(raw: unknown): void {
    // Only control frames come back from the receiver (file-fail).
    let frame: ControlFrame | null = null;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame?.t === 'file-fail' && typeof frame.g === 'string' && typeof frame.p === 'string') {
      this.failed.add(`${frame.g}/${frame.p}`);
    }
  }

  /** Ship one round; returns the number of files sent. round 0 ships everything. */
  async sendRound(round: number): Promise<RoundProgress> {
    if (this.closed) throw new Error('transfer socket closed');
    const guilds = this.opts.guilds();
    let filesSent = 0;
    let bytesSent = 0;
    const seen = new Set<string>();
    // Re-strike NACKed files carried over from the prior round.
    for (const key of this.failed) {
      const n = (this.strikes.get(key) ?? 0) + 1;
      this.strikes.set(key, n);
      if (n > FILE_STRIKE_LIMIT) throw new Error(`file ${key} failed verification ${FILE_STRIKE_LIMIT} times`);
    }
    const nacked = new Set(this.failed);
    this.failed.clear();

    for (const guildId of guilds) {
      for await (const record of exportNamespace(guildId)) {
        const key = `${record.guildId}/${record.relPath}`;
        seen.add(key);
        const prev = this.snapshot.get(key);
        const dirtyByOp = this.opts.isDirty?.(record.guildId, record.relPath) === true;
        const changed = round === 0 || !prev || prev.sha256 !== record.sha256 || nacked.has(key) || dirtyByOp;
        // Refresh the snapshot every round so the next delta compares against
        // the freshest bytes even when we did not resend this round.
        let mtimeMs = 0;
        try { mtimeMs = (await fs.promises.stat(path.join(DATA_ROOT, record.guildId, ...record.relPath.split('/')))).mtimeMs; } catch { /* vanished */ }
        this.snapshot.set(key, { size: record.size, mtimeMs, sha256: record.sha256 });
        if (!changed) continue;
        await this.sendFile(record);
        filesSent += 1;
        bytesSent += record.size;
      }
    }
    // A path that disappeared from the source set is simply not re-shipped; the
    // receiver keeps its last copy (namespace deletes are rare and handled by
    // the commit-time graveyard of the whole stale live dir).
    for (const key of [...this.snapshot.keys()]) {
      if (!seen.has(key)) this.snapshot.delete(key);
    }
    this.sendControl({ t: 'round', round, files: filesSent, bytes: bytesSent });
    return {
      round,
      filesSent,
      bytesSent,
      guildsTotal: guilds.length,
      guildsDone: guilds.length,
      deltaFiles: filesSent,
    };
  }

  /** Signal the final round is done so the receiver hashes and verifies. */
  finish(round: number): void {
    this.sendControl({ t: 'round-end', round, final: true });
  }

  private async sendFile(record: FileRecord): Promise<void> {
    const total = record.size;
    if (total <= XFER_CHUNK_BYTES) {
      await this.sendBinary(this.frameRecord({ g: record.guildId, p: record.relPath, s: total, h: record.sha256 }, record.bytes));
      return;
    }
    for (let offset = 0; offset < total; offset += XFER_CHUNK_BYTES) {
      const slice = record.bytes.subarray(offset, Math.min(total, offset + XFER_CHUNK_BYTES));
      const header: RecordHeader = { g: record.guildId, p: record.relPath, s: slice.length, h: sha256Hex(slice), o: offset, tot: total };
      await this.sendBinary(this.frameRecord(header, slice));
    }
  }

  private frameRecord(header: RecordHeader, payload: Buffer): Buffer {
    const headerJson = Buffer.from(JSON.stringify(header), 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(headerJson.length, 0);
    return Buffer.concat([len, headerJson, payload]);
  }

  private sendBinary(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('transfer socket closed'));
      const flush = () => {
        this.ws.send(buf, err => (err ? reject(err) : resolve()));
      };
      // Backpressure: wait for the buffer to drain below the high water.
      if (this.ws.bufferedAmount > XFER_HIGH_WATER_BYTES) {
        const poll = setInterval(() => {
          if (this.closed || this.ws.readyState !== WebSocket.OPEN) { clearInterval(poll); return reject(new Error('transfer socket closed')); }
          if (this.ws.bufferedAmount <= XFER_HIGH_WATER_BYTES) { clearInterval(poll); flush(); }
        }, 25);
        return;
      }
      flush();
    });
  }

  private sendControl(frame: ControlFrame): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(frame)); } catch { /* closing */ }
  }
}

// ============================================================================
// Receiver (target side): hashes each record into _incoming staging, NACKs a
// mismatch, and reassembles chunked records by offset.
// ============================================================================

export interface ReceiverEvents {
  /** A 'round' control frame arrived (one copy round finished on the sender). */
  onRound?: (round: number) => void;
  /** The 'round-end' final frame arrived; the caller should verify staging. */
  onFinal?: (round: number) => void;
  onClose?: () => void;
}

export class TransferReceiver {
  private readonly baseDir: string;
  private readonly baseResolved: string;
  private readonly allowGuilds: Set<string>;
  private readonly openChunks = new Map<string, fs.promises.FileHandle>();
  private readonly chunkHash = new Map<string, ReturnType<typeof createHash>>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly migrationId: string,
    private readonly legId: string,
    private readonly events: ReceiverEvents,
    guilds: string[] = [],
  ) {
    this.baseDir = path.join(DATA_ROOT, INCOMING_DIR, migrationId, legId);
    this.baseResolved = path.resolve(this.baseDir);
    this.allowGuilds = new Set(guilds);
    ws.on('message', (raw, isBinary) => void this.onMessage(raw, isBinary));
    ws.on('close', () => { this.closed = true; this.events.onClose?.(); });
  }

  private async onMessage(raw: any, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    if (!isBinary) {
      let frame: ControlFrame | null = null;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame?.t === 'round' && Number.isInteger(frame.round)) this.events.onRound?.(frame.round!);
      else if (frame?.t === 'round-end' && Number.isInteger(frame.round)) this.events.onFinal?.(frame.round!);
      return;
    }
    const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    try {
      await this.writeRecord(buf);
    } catch (error) {
      console.warn(`[Transfer] Receive error on ${this.migrationId}/${this.legId}:`, error instanceof Error ? error.message : error);
    }
  }

  private async writeRecord(buf: Buffer): Promise<void> {
    if (buf.length < 4) return;
    const headerLen = buf.readUInt32BE(0);
    const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf-8')) as RecordHeader;
    const payload = buf.subarray(4 + headerLen);
    const target = this.safeTarget(header.g, header.p);
    if (!target) {
      // Peer-controlled guild/relPath failed the traversal/allowlist guard: a
      // compromised peer (or a token-capturing MITM) must never write outside
      // this leg's staging dir. Drop the record; the per-record sha256 check is
      // no defense because the attacker computes it over its own bytes.
      console.warn(`[Transfer] Rejected out-of-scope record on ${this.migrationId}/${this.legId}: g=${String(header.g)} p=${String(header.p)}`);
      return;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const key = `${header.g}/${header.p}`;

    if (header.tot === undefined) {
      // Whole file in one record.
      if (sha256Hex(payload) !== header.h) {
        this.nack(header.g, header.p);
        return;
      }
      await fs.promises.writeFile(target, payload);
      return;
    }

    // Chunked record: append at offset, hash incrementally, close on the last chunk.
    let fh = this.openChunks.get(key);
    if (!fh || header.o === 0) {
      if (fh) await fh.close().catch(() => undefined);
      fh = await fs.promises.open(target, 'w');
      this.openChunks.set(key, fh);
      this.chunkHash.set(key, createHash('sha256'));
    }
    if (sha256Hex(payload) !== header.h) {
      this.nack(header.g, header.p);
      return;
    }
    await fh.write(payload, 0, payload.length, header.o);
    this.chunkHash.get(key)!.update(payload);
    if ((header.o ?? 0) + header.s >= (header.tot ?? 0)) {
      await fh.close().catch(() => undefined);
      this.openChunks.delete(key);
      this.chunkHash.delete(key);
    }
  }

  // Resolve a peer-controlled (guildId, relPath) to an absolute path, or null
  // when it fails the guard: the guild must be a plain numeric id in the leg's
  // allowlist, and the relPath must have no absolute/traversal/backslash/empty
  // segment. The resolved path must stay under this leg's staging dir. Mirrors
  // the Stage 3/4 resolveScopeFile idiom (path.resolve + prefix assertion).
  private safeTarget(g: unknown, p: unknown): string | null {
    if (typeof g !== 'string' || !/^\d{5,20}$/.test(g)) return null;
    if (this.allowGuilds.size > 0 && !this.allowGuilds.has(g)) return null;
    if (typeof p !== 'string' || p.length === 0) return null;
    if (path.isAbsolute(p) || p.includes('\\') || /^[a-zA-Z]:/.test(p)) return null;
    const segments = p.split('/');
    for (const seg of segments) {
      if (seg === '' || seg === '.' || seg === '..') return null;
    }
    const resolved = path.resolve(this.baseResolved, g, ...segments);
    if (resolved !== this.baseResolved && !resolved.startsWith(this.baseResolved + path.sep)) return null;
    return resolved;
  }

  private nack(g: string, p: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ t: 'file-fail', g, p } as ControlFrame)); } catch { /* closing */ }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const fh of this.openChunks.values()) await fh.close().catch(() => undefined);
    this.openChunks.clear();
  }
}

/** Dial a peer's transfer endpoint with the single-use token header. */
export function dialTransfer(peerUrl: string, token: string): WebSocket {
  return new WebSocket(peerUrl, { headers: { 'x-transfer-token': token } });
}

/** Staging dir for a leg's received bytes. */
export function incomingLegDir(migrationId: string, legId: string): string {
  return path.join(DATA_ROOT, INCOMING_DIR, migrationId, legId);
}
