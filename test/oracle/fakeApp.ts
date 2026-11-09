import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import type { Pool } from 'pg';

// A stand-in for a bot node's web UI, speaking the routes and answers the
// oracle relies on (routes/config.ts data/update, data/delete, data/get and
// sendHopReply), stored in real Postgres. Faults are injected per request, so
// a test knows exactly which docs each verdict must name.

export type WriteFault =
  | 'normal'
  | 'held'               // applied, answered 202
  | 'ambiguous'          // applied, answered 503 'guild temporarily unavailable'
  | 'refuse'             // not applied, answered 503 frozen
  | 'hang'               // applied, never answered
  | 'ack-no-write'       // answered 200, never applied: LOST
  | 'held-no-write'      // answered 202, never applied: HELD-MISSING
  | 'refuse-but-write'   // applied, answered 503 frozen: PHANTOM
  | 'corrupt';           // applied with other bytes, answered 200: WRONG-CONTENT

export type DeleteFault = 'normal' | 'ack-noop';

export interface FakeAppOptions {
  pools: Pool[];
  /** Which pool takes this key's writes (default: the first). */
  route?: (key: string) => number;
  writeFault?: (key: string, data: any) => WriteFault;
  deleteFault?: (key: string) => DeleteFault;
  /** Serve an earlier version of the doc: a stale read. */
  staleRead?: (key: string) => boolean;
  fleetState?: () => unknown;
  /** The web UI's token bucket (webui/server.ts): 10 at once, then one per 500 ms per address. */
  rateLimit?: boolean;
  /** Reads answer this late. */
  readDelayMs?: number;
  /**
   * NB6: this machine's data folder. With it, a read or write with no guildId is a shared file: read from the mirror
   * (<folder>/global/<id>), stored in smdb_data.shared_docs of the first pool, then written to the mirror.
   */
  sharedMirror?: string;
  /** false: a shared save is stored over whatever the row holds, never compared with its base (SHARED-OVERWRITE). */
  sharedCompare?: boolean;
}

// express.json({ limit: '10kb' }) in webui/server.ts; the app's own error
// handler there answers it 500, never 413.
const BODY_LIMIT = 10 * 1024;
export const TOO_LARGE = { error: 'An error occurred', message: 'request entity too large' };

export const FAKE_SCHEMA = [
  'CREATE SCHEMA IF NOT EXISTS smdb_data',
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_data (
     guild_id text NOT NULL, module text NOT NULL, filename text NOT NULL, doc text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (guild_id, module, filename))`,
  // NB6's shared_docs as postgresBackend.ts provisions it.
  'CREATE SEQUENCE IF NOT EXISTS smdb_data.shared_rev_seq',
  `CREATE TABLE IF NOT EXISTS smdb_data.shared_docs (
     key text PRIMARY KEY, body bytea NOT NULL, sha text NOT NULL, rev bigint NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL)`,
];

// The flush's statements (sharedStore.ts LOCK_SQL, CHECKED_SQL and UPSERT_SQL), and T22's refusal (replyGate.ts).
const SHARED_LOCK = "SELECT pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))";
const SHARED_SHA = 'SELECT sha FROM smdb_data.shared_docs WHERE key = $1';
export const SHARED_UPSERT = `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by)
  VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), $4)
  ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, sha = EXCLUDED.sha, rev = EXCLUDED.rev,
    updated_at = now(), updated_by = EXCLUDED.updated_by`;
const changedText = (machine: string, at: Date) =>
  `This data was changed on ${machine} at ${at.toISOString()} after your change read it, so your change was not saved. Reload to see the current values, then try again.`;
const CHANGED_SINCE_OPEN = 'This file changed since you opened it; nothing was saved. Reload it to see the current values.';

export const shaOfText = (text: string | null): string => (text === null ? 'absent' : createHash('sha256').update(text, 'utf8').digest('hex'));
export const mirrorFile = (folder: string, id: string): string => path.join(folder, 'global', ...id.split('/'));
const readMirror = (folder: string, id: string): string | null => (fs.existsSync(mirrorFile(folder, id)) ? fs.readFileSync(mirrorFile(folder, id), 'utf8') : null);
export function writeMirror(folder: string, id: string, text: string | null): void {
  const file = mirrorFile(folder, id);
  if (text === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A machine's pass for the given shared files: its mirror takes each row's version, and loses a file whose row is gone. */
export async function syncMirror(pool: Pool, folder: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const rows = (await pool.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', [`global/${id}`])).rows;
    writeMirror(folder, id, rows.length === 0 ? null : (rows[0].body as Buffer).toString('utf8'));
  }
}

const FROZEN = 'Guild data is frozen for a shard migration; retry after it completes';

function split(fileId: string): { module: string; filename: string } {
  const parts = fileId.split('/');
  return { module: parts.length >= 2 ? parts[0] : '', filename: parts[parts.length - 1] };
}

class TooLarge extends Error {}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  if (raw.length > BODY_LIMIT) throw new TooLarge();
  return JSON.parse(raw.toString('utf8') || '{}');
}

export async function startFakeApp(options: FakeAppOptions): Promise<{ url: string; close: () => Promise<void>; previous: Map<string, string[]> }> {
  const route = options.route ?? (() => 0);
  // Every version each key held, for stale reads.
  const previous = new Map<string, string[]>();
  const hanging = new Set<http.ServerResponse>();
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();
  const admitted = (address: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(address) ?? { tokens: 10, lastRefill: now };
    buckets.set(address, bucket);
    const add = Math.floor((now - bucket.lastRefill) / 500);
    if (add > 0) {
      bucket.tokens = Math.min(10, bucket.tokens + add);
      bucket.lastRefill = now - ((now - bucket.lastRefill) % 500);
    }
    if (bucket.tokens === 0) return false;
    bucket.tokens -= 1;
    return true;
  };

  const upsert = async (pool: Pool, guildId: string, module: string, filename: string, data: any) => {
    const doc = JSON.stringify(data, null, 2);
    await pool.query(
      `INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, module, filename) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [guildId, module, filename, doc],
    );
    const list = previous.get(filename) ?? [];
    list.push(doc);
    previous.set(filename, list);
  };

  /** A shared save as the bot makes it: global.write's compare with this machine's copy, then the flush's. */
  const sharedWrite = async (b: any): Promise<[number, unknown]> => {
    const folder = options.sharedMirror!;
    const id = String(b.file);
    const key = `global/${id}`;
    if (typeof b.loadedSha !== 'string' || b.loadedSha.length === 0) {
      return [400, { success: false, error: 'This page is out of date; nothing was saved. Reload the page and open the file again.' }];
    }
    if (shaOfText(readMirror(folder, id)) !== b.loadedSha) return [409, { success: false, error: CHANGED_SINCE_OPEN }];
    const text = JSON.stringify(b.data, null, 2);
    const client = await options.pools[0].connect();
    try {
      await client.query('BEGIN');
      await client.query(SHARED_LOCK, [key]);
      const stored: string = (await client.query(SHARED_SHA, [key])).rows[0]?.sha ?? 'absent';
      if (options.sharedCompare !== false && stored !== b.loadedSha) {
        await client.query('ROLLBACK');
        return [409, { success: false, error: changedText('OTHER', new Date()) }];
      }
      await client.query(SHARED_UPSERT, [key, Buffer.from(text, 'utf8'), shaOfText(text), 'fake']);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    writeMirror(folder, id, text);
    return [200, { success: true }];
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (options.rateLimit && !admitted(req.socket.remoteAddress ?? 'unknown')) {
        res.setHeader('Retry-After', '1');
        return send(429, { error: 'Rate limit exceeded. Please wait a moment.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/config/data/update') {
        const b = await body(req);
        if (options.sharedMirror && b.guildId === undefined) {
          const [status, payload] = await sharedWrite(b);
          return send(status, payload);
        }
        if (typeof b.loadedSha !== 'string' || b.loadedSha.length === 0) {
          return send(400, { success: false, error: 'This page is out of date; nothing was saved. Reload the page and open the file again.' });
        }
        const { module, filename } = split(String(b.file));
        const pool = options.pools[route(filename)];
        const fault = options.writeFault?.(filename, b.data) ?? 'normal';
        if (fault === 'refuse') return send(503, { success: false, error: FROZEN });
        if (fault === 'ack-no-write') return send(200, { success: true });
        if (fault === 'held-no-write') return send(202, { success: true, pending: true, message: 'saved, not yet confirmed durable' });
        await upsert(pool, b.guildId, module, filename, fault === 'corrupt' ? { ...b.data, pad: `${b.data.pad}!` } : b.data);
        if (fault === 'held') return send(202, { success: true, pending: true, message: 'saved, not yet confirmed durable' });
        if (fault === 'ambiguous') return send(503, { success: false, error: 'guild temporarily unavailable' });
        if (fault === 'refuse-but-write') return send(503, { success: false, error: FROZEN });
        if (fault === 'hang') {
          hanging.add(res);
          return;
        }
        return send(200, { success: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/config/data/delete') {
        const b = await body(req);
        const { module, filename } = split(String(b.file));
        if ((options.deleteFault?.(filename) ?? 'normal') === 'normal') {
          await options.pools[route(filename)].query(
            'DELETE FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3',
            [b.guildId, module, filename],
          );
        }
        return send(200, { success: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/config/data/get') {
        if (options.readDelayMs) await new Promise(resolve => setTimeout(resolve, options.readDelayMs));
        if (options.sharedMirror && !url.searchParams.has('guildId')) {
          const text = readMirror(options.sharedMirror, url.searchParams.get('file') ?? '');
          if (text === null) return send(404, { success: false, error: 'Data file not found' });
          return send(200, { success: true, data: JSON.parse(text), exists: true, sha: shaOfText(text) });
        }
        const { module, filename } = split(decodeURIComponent(url.searchParams.get('file') ?? ''));
        const guildId = url.searchParams.get('guildId');
        const rows = (await options.pools[route(filename)].query(
          'SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3',
          [guildId, module, filename],
        )).rows;
        if (rows.length === 0) return send(404, { success: false, error: 'Data file not found' });
        const versions = previous.get(filename) ?? [];
        const doc = options.staleRead?.(filename) && versions.length >= 2 ? versions[0] : rows[0].doc;
        return send(200, { success: true, data: JSON.parse(doc), exists: true, sha: shaOfText(doc) });
      }
      if (req.method === 'GET' && url.pathname === '/api/fleet/state') {
        return send(200, { success: true, ...(options.fleetState?.() as object ?? {}) });
      }
      send(404, { success: false, error: 'no route' });
    } catch (error) {
      if (error instanceof TooLarge) return send(500, TOO_LARGE);
      send(500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    previous,
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
