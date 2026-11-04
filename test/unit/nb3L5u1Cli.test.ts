import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/cli/commands';

// NB3 mutation gate, round u1: smdb logs --follow streams the bot's log lines, and a verb missing its first argument
// names that argument.

interface Call { method: string; path: string }

let calls: Call[];
let out: string;
let err: string;
let exitCode: number | undefined;
let onMessage: ((msg: { type: string; data: unknown }) => void) | null;

function fakeClient(): any {
  return {
    request: async (method: string, path: string) => {
      calls.push({ method, path });
      return { ok: true, status: 200, body: { success: true } };
    },
    openWs: (cb: (msg: { type: string; data: unknown }) => void) => {
      onMessage = cb;
      return { close: () => undefined };
    },
  };
}

async function settle(p: Promise<void>): Promise<string> {
  return Promise.race([
    p.then(() => 'returned', (e: Error) => e.message),
    new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
  ]);
}

beforeEach(() => {
  calls = [];
  out = '';
  err = '';
  exitCode = undefined;
  onMessage = null;
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exitCode = code; throw new Error('exit ' + code); }) as any);
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('smdb logs --follow', () => {
  it('streams each bot log line from the socket, calls no route and keeps running', async () => {
    const state = await settle(dispatch(fakeClient(), ['logs'], { follow: true }));
    expect(state).toBe('pending');
    expect(calls).toEqual([]);
    expect(exitCode).toBeUndefined();
    expect(onMessage).not.toBeNull();
    onMessage!({ type: 'bot:log', data: { line: '[Bot] ready' } });
    onMessage!({ type: 'bot:status', data: { line: 'not a log' } });
    onMessage!({ type: 'bot:log', data: { other: 1 } });
    expect(out).toBe('[Bot] ready\n{"other":1}\n');
  });
});

describe('smdb panels exec without a panel id', () => {
  it('exits with the usage code and names the missing panelId', async () => {
    const state = await settle(dispatch(fakeClient(), ['panels', 'exec'], {}));
    expect(state).toBe('exit 2');
    expect(exitCode).toBe(2);
    expect(err).toBe('smdb: missing argument: panelId\n');
    expect(calls).toEqual([]);
  });
});
