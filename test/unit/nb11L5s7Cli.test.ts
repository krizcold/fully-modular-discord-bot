import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, CliResponse } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';
import { EXIT_ERR, EXIT_OK, EXIT_USAGE } from '../../src/cli/output';

// NB11 survivors, chunk 7 (wip-redesign/sheets/NB11.md, decision 11): `smdb graveyard restore`.

const G = '123456789012345678';
const WHOLE_MS = 'retiredAt must be a whole number of milliseconds';

let exits: number[];
let stdout: string[];
let stderr: string[];
let tty: boolean | undefined;

beforeEach(() => {
  exits = [];
  stdout = [];
  stderr = [];
  tty = process.stdout.isTTY;
  (process.stdout as any).isTTY = true;
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exits.push(code); throw new Error(`exit ${code}`); }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true; }) as never);
});

afterEach(() => {
  (process.stdout as any).isTTY = tty;
  vi.restoreAllMocks();
});

function fakeClient(res: CliResponse) {
  const calls: Array<{ method: string; path: string; opts: unknown }> = [];
  const client = {
    request: async (method: string, path: string, opts: unknown) => {
      calls.push({ method, path, opts });
      return method === 'GET' ? { status: 200, ok: true, body: { success: true, entries: [] } } : res;
    },
  } as unknown as Client;
  return { client, calls };
}

async function run(client: Client, args: string[]): Promise<unknown> {
  try {
    await dispatch(client, ['graveyard', 'restore', ...args], {});
    return null;
  } catch (error) {
    return error;
  }
}

describe('the restore verb', () => {
  it('sends a multi-digit retiredAt as a number in a POST to the restore route', async () => {
    const { client, calls } = fakeClient({ status: 200, ok: true, body: { success: true, retiredAt: 5000, reason: 'r' } });
    await run(client, [G, '5000']);
    expect(calls).toEqual([
      { method: 'GET', path: `/api/data/graveyard?guildId=${G}`, opts: { timeoutMs: 10_000 } },
      { method: 'POST', path: '/api/data/graveyard/restore', opts: { body: { guildId: G, retiredAt: 5000 }, timeoutMs: 100_000 } },
    ]);
    expect(exits).toEqual([EXIT_OK]);
    expect(stderr.join('')).not.toContain(WHOLE_MS);
  });

  it.each(['12 ', '0x10', '5e3'])('refuses retiredAt %j with the usage code and sends nothing', async raw => {
    const { client, calls } = fakeClient({ status: 200, ok: true, body: { success: true, retiredAt: 5000 } });
    await run(client, [G, raw]);
    expect(exits).toEqual([EXIT_USAGE]);
    expect(stderr.join('')).toContain(WHOLE_MS);
    expect(calls).toEqual([]);
  });

  it('prints no restored line for a refusal that carries a retiredAt', async () => {
    const { client } = fakeClient({ status: 409, ok: false, body: { success: false, refusal: 'live-data', retiredAt: 5000, error: `server ${G} has data saved since entry 5000 was deleted; nothing was restored. To put entry 5000 in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${G} 5000 --replace` } });
    await run(client, [G]);
    expect(stdout.join('')).not.toContain('restored server');
    expect(stderr.join('')).toContain(`server ${G} has data saved since entry 5000 was deleted; nothing was restored. To put entry 5000 in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${G} 5000 --replace`);
    expect(exits).toEqual([EXIT_ERR]);
  });

  it('an empty answer body prints nothing and exits by the status', async () => {
    const { client } = fakeClient({ status: 200, ok: true, body: null });
    const thrown = await run(client, [G]);
    expect(exits).toEqual([EXIT_OK]);
    expect(String(thrown)).toBe(`Error: exit ${EXIT_OK}`);
    expect(stdout.join('')).toBe('');
  });

  it('an answer with no reason and no copied count prints an empty reason and no rows line', async () => {
    const { client } = fakeClient({ status: 200, ok: true, body: { success: true, retiredAt: 5000 } });
    await run(client, [G]);
    expect(stdout.join('')).toBe(`restored server ${G} from the entry deleted at ${new Date(5000).toISOString()} (retiredAt 5000, reason )\n`);
    expect(stderr.join('')).toBe('');
    expect(exits).toEqual([EXIT_OK]);
  });

  it('E1: a warning in the answer goes to stderr after the restored line, and the exit is success', async () => {
    const W = "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the restore. Check the disk.";
    const { client } = fakeClient({ status: 200, ok: true, body: { success: true, retiredAt: 5000, reason: 'r', warning: W } });
    await run(client, [G]);
    expect(stdout.join('')).toBe(`restored server ${G} from the entry deleted at ${new Date(5000).toISOString()} (retiredAt 5000, reason r)\n`);
    expect(stderr.join('')).toBe(`smdb: warning: ${W}\n`);
    expect(exits).toEqual([EXIT_OK]);
  });
});
