import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';

// NB8 test 17 (C18): the CLI reads whether a backup restore stands from the panel's status, `backups.restoring`:
// true is yes, false is no, anything else is unknown.

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

describe('panelAnswers() reads restoring (C18)', () => {
  it.each([
    ['true', { alert: null, restoring: true }, 'yes'],
    ['false', { alert: null, restoring: false }, 'no'],
    ["'unknown'", { alert: null, restoring: 'unknown' }, 'unknown'],
    ['absent', undefined, 'unknown'],
  ] as const)('restoring %s', async (_name, backups, expected) => {
    answer(200, { status: { running: false, migration: null, ...(backups ? { backups } : {}) } });
    expect(await client.panelAnswers(2000)).toEqual({ bot: 'no', migration: 'no', restoring: expected });
  });
});

// NB8 test 17 (decisions 13 and 61): the `backups` verbs against a scripted client. `backups restore` posts, then
// polls GET /api/backups every 2 s until the restore's record has a result while no restore runs, a latch stands, or
// the restore stopped part way; it prints the restore's JSON and its last line, and exits 0 only for `done`.

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

describe('the backups verbs (decisions 13 and 61)', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const NAME = 'hourly-2026-11-13T04-00-00-000Z';
  type Reply = { status: number; body: unknown };

  /** A client whose POST answers `posted` and whose GETs answer `gets` in turn (the last one repeats). */
  function scripted(posted: Reply, gets: Reply[]) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const limits: Array<number | undefined> = [];
    let n = 0;
    const scriptedClient = {
      request: async (method: string, path: string, opts?: { body?: unknown; timeoutMs?: number }) => {
        calls.push({ method, path, body: opts?.body });
        limits.push(opts?.timeoutMs);
        const next = method === 'GET' ? gets[Math.min(n++, gets.length - 1)] : posted;
        return { ...next, ok: next.status >= 200 && next.status < 300 };
      },
    };
    return { client: scriptedClient, calls, limits };
  }

  async function run(target: unknown, positionals: string[], flags: Record<string, string | boolean> = { json: true }) {
    let code: number | undefined | 'none' = 'none';
    try {
      await dispatch(target as never, positionals, flags);
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      code = e.code;
    }
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  const status = (restore: Record<string, unknown>): Reply => ({ status: 200, body: { success: true, restore: { name: NAME, running: false, latch: null, ...restore } } });
  const STARTED: Reply = { status: 202, body: { success: true, state: 'started', name: NAME } };

  it('backups list asks GET /api/backups and prints the six columns in human mode', async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const s = scripted(STARTED, [{ status: 200, body: { success: true, snapshots: [{ name: NAME, kind: 'hourly', takenAt: 5, files: 2, bytes: 14, guilds: 1, graveyardEntries: 0, test: 'passed', state: 'complete' }] } }]);
      const r = await run(s.client, ['backups', 'list'], {});
      expect(s.calls).toEqual([{ method: 'GET', path: '/api/backups', body: undefined }]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${'name'.padEnd(NAME.length)}  kind    takenAt  files  bytes  test\n${NAME}  hourly  5        2      14     passed\n`);
    } finally {
      if (desc) Object.defineProperty(process.stdout, 'isTTY', desc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('backups settings sends its body to PUT /api/backups/settings', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const settingsClient = {
      request: async (method: string, path: string, opts?: { body?: unknown }) => {
        calls.push({ method, path, body: opts?.body });
        return { status: 200, ok: true, body: { success: true, settings: { enabled: false, hour: 4 } } };
      },
    };
    const r = await run(settingsClient, ['backups', 'settings'], { json: true, body: '{"enabled":false,"expected":{"enabled":true}}' });
    expect(calls).toEqual([{ method: 'PUT', path: '/api/backups/settings', body: { enabled: false, expected: { enabled: true } } }]);
    expect(r.code).toBe(0);
  });

  it('backups restore without a name is a usage error and sends nothing', async () => {
    const s = scripted(STARTED, []);
    expect((await run(s.client, ['backups', 'restore'])).code).toBe(2);
    expect(s.calls).toEqual([]);
  });

  it('a refused POST prints its error, exits 1 and polls nothing', async () => {
    const refused: Reply = { status: 409, body: { success: false, error: 'A data migration is running or unfinished; restore once it has finished.' } };
    const s = scripted(refused, []);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(s.calls).toEqual([{ method: 'POST', path: '/api/backups/restore', body: { name: NAME } }]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('smdb: A data migration is running or unfinished; restore once it has finished.\n');
  });

  it('polls to done every 2 s, prints the done line and exits 0', async () => {
    vi.useFakeTimers();
    const done = 'Restored x at y: 2 files. The data it replaced is kept as backup pre-restore-z. The bot is now stopped.';
    const s = scripted(STARTED, [
      status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' }),
      status({ stage: 'placed', line: 'Restoring x: recording the replaced data.' }),
      status({ stage: 'done', result: 'done', line: done }),
    ]);
    const pending = run(s.client, ['backups', 'restore', NAME]);
    await vi.advanceTimersByTimeAsync(4100);
    const r = await pending;
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ stage: 'done', result: 'done' });
    expect(r.stderr).toBe(`smdb: ${done}\n`);
  });

  it.each([
    ['failed', { stage: 'failed', result: 'failed', line: 'The restore of x failed before any data was changed: The bot did not stop within 60 seconds. The bot is now stopped.' }],
    ['stuck', { stage: 'stuck', state: 'stuck', line: 'The restore of x stopped part way: /data/123 could not be moved (EBUSY).' }],
  ])('ends %s with its line and exit 1', async (_label, restore) => {
    const s = scripted(STARTED, [status(restore)]);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: ${restore.line}\n`);
  });

  it('a latch seen during the poll prints its line and exits 1 with no further GET', async () => {
    vi.useFakeTimers();
    const latch = "The restore of x stopped part way: its record (/data/_snapshots/restore.json) could not be written (EIO), so can't confirm the disk took the restore's last step.";
    const s = scripted(STARTED, [
      status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' }),
      status({ stage: 'swapping', latch, line: latch }),
      status({ stage: 'swapping', line: 'never read' }),
    ]);
    const pending = run(s.client, ['backups', 'restore', NAME]);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET', 'GET']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: ${latch}\n`);
  });

  it('a result while a restore still runs keeps the poll going until none runs', async () => {
    vi.useFakeTimers();
    const old = `Restoring ${NAME}: copying and checking the backup.`;
    const done = 'Restored x.';
    const s = scripted({ status: 202, body: { success: true, state: 'running', name: NAME, note: `A restore of ${NAME} is already running.` } }, [
      status({ stage: 'done', result: 'done', running: true, line: old }),
      status({ stage: 'done', result: 'done', running: true, line: old }),
      status({ stage: 'done', result: 'done', line: done }),
    ]);
    const pending = run(s.client, ['backups', 'restore', NAME]);
    await vi.advanceTimersByTimeAsync(4100);
    const r = await pending;
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`smdb: ${done}\n`);
  });

  it("a record that names another backup once no restore runs: can't confirm, exit 1", async () => {
    const s = scripted(STARTED, [{ status: 200, body: { success: true, restore: { name: 'hourly-2026-11-12T04-00-00-000Z', stage: 'done', result: 'done', running: false, latch: null, line: 'Restored another.' } } }]);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: can't confirm that the restore of ${NAME} ran: the restore record names hourly-2026-11-12T04-00-00-000Z; check with: smdb api GET /api/backups\n`);
  });

  it('gives up after 2 hours naming the stage, with the timeout code', async () => {
    vi.useFakeTimers();
    const s = scripted(STARTED, [status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' })]);
    const pending = run(s.client, ['backups', 'restore', NAME]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 5000);
    const r = await pending;
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`smdb: can't confirm the outcome of the restore of ${NAME} within 2 hours; its record says staging; check with: smdb api GET /api/backups\n`);
    expect(s.calls.filter(c => c.method === 'GET').length).toBeGreaterThan(3000);
  });

  it("a POST with no answer: can't confirm whether the restore started, exit 1", async () => {
    const failing = { request: async () => { throw new Error('socket hang up'); } };
    const r = await run(failing, ['backups', 'restore', NAME]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: can't confirm whether the restore of ${NAME} started (socket hang up); check with: smdb api GET /api/backups\n`);
  });

  // Fix 3C (code review 3, lane C).
  it('a POST answered running for another backup prints its note, exits 1 and polls nothing (C1)', async () => {
    const OTHER = 'hourly-2026-11-12T04-00-00-000Z';
    const running: Reply = { status: 202, body: { success: true, state: 'running', name: OTHER, note: `A restore of ${OTHER} is already running.` } };
    const s = scripted(running, [status({ name: OTHER, stage: 'done', result: 'done', line: 'Restored another.' })]);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(s.calls.map(c => c.method)).toEqual(['POST']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ state: 'running', name: OTHER });
    expect(r.stderr).toBe(`smdb: A restore of ${OTHER} is already running.\n`);
  });

  it('a record that cannot be read ends with its own line and exit 1 (C2, unknown)', async () => {
    const line = "can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (EIO). Until it can be read, the bot cannot be started, no change to the data is saved and no backup is taken; if no restore ran, remove that file.";
    const s = scripted(STARTED, [{ status: 200, body: { success: true, restore: { name: null, stage: null, state: 'unknown', running: false, latch: null, cause: 'EIO', line } } }]);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: ${line}\n`);
  });

  it('an unfinished restore ends with its line and exit 1 (C2, unfinished)', async () => {
    const line = `The restore of ${NAME} did not finish (/data/_snapshots/restore.json says swapping), and no restore runs now. The bot does not start until it ends. Restart the bot's container: the web panel finishes the restore when it starts, or ends it failed with the data unchanged if no data had been moved yet, or finishes it, when /data held no data, before it starts the bot.`;
    const s = scripted(STARTED, [status({ stage: 'swapping', state: 'unfinished', line })]);
    const r = await run(s.client, ['backups', 'restore', NAME]);
    expect(s.calls.map(c => c.method)).toEqual(['POST', 'GET']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: ${line}\n`);
  });

  it('gives up after --timeout naming the wait it used (C3)', async () => {
    vi.useFakeTimers();
    const s = scripted(STARTED, [status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' })]);
    const pending = run(s.client, ['backups', 'restore', NAME], { json: true, timeout: '120' });
    await vi.advanceTimersByTimeAsync(125_000);
    const r = await pending;
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`smdb: can't confirm the outcome of the restore of ${NAME} within 2 minutes; its record says staging; check with: smdb api GET /api/backups\n`);
  });

  it('caps the POST and each GET at the time left before the 2 hours end (C4)', async () => {
    vi.useFakeTimers();
    const s = scripted(STARTED, [
      status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' }),
      status({ stage: 'staging', running: true, line: 'Restoring x: copying and checking the backup.' }),
      status({ stage: 'done', result: 'done', line: 'Restored x.' }),
    ]);
    const pending = run(s.client, ['backups', 'restore', NAME]);
    await vi.advanceTimersByTimeAsync(4100);
    const r = await pending;
    expect(r.code).toBe(0);
    expect(s.limits).toEqual([7_200_000, 7_200_000, 7_198_000, 7_196_000]);
  });

  it("a status request with no answer by the deadline ends with can't confirm the outcome, exit 3 (C4)", async () => {
    reply = (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: 'started', name: NAME }));
      }
    };
    const began = Date.now();
    const r = await run(client, ['backups', 'restore', NAME], { json: true, timeout: '1' });
    expect(Date.now() - began).toBeGreaterThanOrEqual(2900);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`smdb: can't confirm the outcome of the restore of ${NAME} within 1 second; the status request had no answer; check with: smdb api GET /api/backups\n`);
  }, 10_000);

  it("a POST with no answer by the deadline: can't confirm whether the restore started, exit 1 (C4)", async () => {
    reply = () => undefined;
    const r = await run(client, ['backups', 'restore', NAME], { json: true, timeout: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`smdb: can't confirm whether the restore of ${NAME} started (no answer within 3s); check with: smdb api GET /api/backups\n`);
  }, 10_000);
});
