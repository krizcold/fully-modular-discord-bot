import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../../src/cli/client';

// NB3: the CLI reads the panel's status to say whether the bot runs and whether a data migration runs; any answer
// it cannot read is "unknown", never a guess. A cut or late answer is a failure that says so.

let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => undefined;
const server = http.createServer((req, res) => reply(req, res));
let client: Client;

beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  client = new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

function answer(status: number, body: unknown): void {
  reply = (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function cutMidBody(): void {
  reply = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' });
    res.write('{"status":{"running":true,');
    setTimeout(() => res.socket?.destroy(), 20);
  };
}

const late = (ms: number) => new Promise<'no answer'>(done => setTimeout(() => done('no answer'), ms));

describe('panelAnswers', () => {
  it('reads running and migration from a 200 status', async () => {
    answer(200, { status: { running: true, migration: null, backups: { alert: null, restoring: false } } });
    expect(await client.panelAnswers(2000)).toEqual({ bot: 'yes', migration: 'no', restoring: 'no' });
    answer(200, { status: { running: false, migration: { jobId: 'job-1', to: 'postgres' }, backups: { alert: null, restoring: false } } });
    expect(await client.panelAnswers(2000)).toEqual({ bot: 'no', migration: 'yes', restoring: 'no' });
  });

  it('answers unknown for a status that is not 200, whatever its body says', async () => {
    answer(503, { status: { running: true, migration: null } });
    expect(await client.panelAnswers(2000)).toEqual({ bot: 'unknown', migration: 'unknown', restoring: 'unknown' });
  });

  it('answers unknown for a running value that is not a boolean', async () => {
    answer(200, { status: { running: 'maybe', migration: null } });
    expect((await client.panelAnswers(2000)).bot).toBe('unknown');
  });

  it('answers unknown for a migration value that is neither null nor an object', async () => {
    for (const migration of ['job-1', 5, true]) {
      answer(200, { status: { running: true, migration } });
      expect((await client.panelAnswers(2000)).migration, String(migration)).toBe('unknown');
    }
    answer(200, { status: { running: true } });
    expect((await client.panelAnswers(2000)).migration).toBe('unknown');
  });

  it('answers unknown at once when the answer is cut mid-body', async () => {
    cutMidBody();
    expect(await Promise.race([client.panelAnswers(10_000), late(1500)])).toEqual({ bot: 'unknown', migration: 'unknown', restoring: 'unknown' });
  });
});

describe('request', () => {
  it('fails with "the answer was cut off" when the body is cut', async () => {
    cutMidBody();
    const err = await client.request('GET', '/api/x').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('the answer was cut off');
  });

  it('names the timeout in seconds when no answer comes', async () => {
    reply = () => undefined;
    const err = await client.request('GET', '/api/x', { timeoutMs: 500 }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe('no answer within 1s');
  });
});
