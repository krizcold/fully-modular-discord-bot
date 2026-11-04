import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/cli/client';

// NB3 mutation gate, round f1: an error on the answer's stream fails the request with that error, not a guess.

let held: http.ServerResponse | null = null;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
  res.write('{"partial":');
  held = res;
});
let client: Client;

beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  client = new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
});
afterEach(() => {
  vi.restoreAllMocks();
  held = null;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

describe('Client.request when the answer stream fails', () => {
  it('rejects with the stream error itself and does not throw it unhandled', async () => {
    const real = http.request;
    let answer: http.IncomingMessage | null = null;
    let gotAnswer: () => void = () => undefined;
    const arrived = new Promise<void>(done => { gotAnswer = done; });
    vi.spyOn(http, 'request').mockImplementation(((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
      real(opts, res => {
        answer = res;
        cb(res);
        gotAnswer();
      })) as any);

    const pending = client.request('GET', '/api/x');
    const outcome = pending.then(() => 'resolved', (e: Error) => e);
    await arrived;
    const failure = new Error('the stream broke in the test');
    let thrown: unknown = null;
    try {
      answer!.emit('error', failure);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    expect(await outcome).toBe(failure);
    answer!.destroy();
    held?.destroy();
  });
});
