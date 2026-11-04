import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/cli/commands';

// NB3 mutation gate, round f1: smdb panels select with no argument names the missing panelId.

let calls: string[];
let err: string;
let exitCode: number | undefined;

function fakeClient(): any {
  return {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { ok: true, status: 200, body: { success: true } };
    },
  };
}

beforeEach(() => {
  calls = [];
  err = '';
  exitCode = undefined;
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exitCode = code; throw new Error('exit ' + code); }) as any);
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('smdb panels select without a panel id', () => {
  it('exits with the usage code, names the missing panelId and calls no route', async () => {
    await expect(dispatch(fakeClient(), ['panels', 'select'], { values: 'a,b' })).rejects.toThrow('exit 2');
    expect(exitCode).toBe(2);
    expect(err).toBe('smdb: missing argument: panelId\n');
    expect(calls).toEqual([]);
  });
});
