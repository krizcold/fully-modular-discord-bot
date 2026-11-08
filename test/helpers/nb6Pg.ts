import net from 'net';
import { Client } from 'pg';
import { expect } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from './fixedDatabase';

// NB6's real-Postgres pieces for the row flush: a proxy between the bot's data pool and the server that can cut the
// connection once the server has answered a COMMIT (the COMMIT applied, its answer lost), drop the COMMIT before it
// reaches the server (the server's session is ended by a Terminate message, so it rolls back and gives up its locks at
// once), or hold the server's answer to it; a backend on a URL; a listener on 'smdb_shared'.

export type CommitFault = 'cut-after' | 'drop' | 'hold';

// The protocol's Terminate message: the server ends the session without waiting to notice a closed socket, which a
// port forward in front of the container may report late.
const TERMINATE = Buffer.from([0x58, 0, 0, 0, 4]);

export interface CommitProxy {
  url: string;
  /** The fault the next COMMIT meets; cleared once used. */
  next: CommitFault | null;
  /** Sends the held answer on to the bot. */
  release(): void;
  /** The simple-query texts the bot sent, in order. */
  queries: string[];
  close(): void;
}

const isCommit = (chunk: Buffer) => chunk[0] === 0x51 && chunk.subarray(5).toString('utf8').replace(/\0+$/, '') === 'COMMIT';

export function commitProxy(host: string, port: number, user: string, password: string, database: string): Promise<CommitProxy> {
  const sockets: net.Socket[] = [];
  let release = () => {};
  const proxy: CommitProxy = {
    url: '',
    next: null,
    release: () => release(),
    queries: [],
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
  const server = net.createServer(client => {
    const upstream = net.connect(port, host);
    sockets.push(client, upstream);
    let held: Buffer[] | null = null;
    let cutOnAnswer = false;
    upstream.on('data', chunk => {
      if (cutOnAnswer) {
        cutOnAnswer = false;
        client.destroy();
        upstream.end(TERMINATE);
        return;
      }
      if (held) held.push(chunk);
      else client.write(chunk);
    });
    client.on('data', chunk => {
      if (chunk[0] === 0x51) proxy.queries.push(chunk.subarray(5).toString('utf8').replace(/\0+$/, ''));
      if (!isCommit(chunk) || proxy.next === null) {
        upstream.write(chunk);
        return;
      }
      const fault = proxy.next;
      proxy.next = null;
      if (fault === 'drop') {
        upstream.end(TERMINATE);
        client.destroy();
        return;
      }
      upstream.write(chunk);
      if (fault === 'cut-after') {
        cutOnAnswer = true;
        return;
      }
      held = [];
      release = () => {
        const out = held ?? [];
        held = null;
        for (const part of out) client.write(part);
      };
    });
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', () => upstream.end());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const at = server.address() as net.AddressInfo;
    proxy.url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${at.port}/${database}`;
    resolve(proxy);
  }));
}

/** A started backend on url, ready (provisioned at this schema version). */
export async function backendOn(url: string): Promise<PostgresBackend> {
  const backend = new PostgresBackend(fixedDatabase(url));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  return backend;
}

/** A client listening on 'smdb_shared'; heard holds each payload. */
export async function sharedListener(url: string): Promise<{ heard: string[]; end(): Promise<void> }> {
  const client = new Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  const heard: string[] = [];
  client.on('notification', msg => { if (msg.channel === 'smdb_shared') heard.push(msg.payload ?? ''); });
  await client.query('LISTEN smdb_shared');
  return { heard, end: () => client.end().catch(() => undefined) };
}

export const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await pause(25);
  expect(await check()).toBe(true);
}
