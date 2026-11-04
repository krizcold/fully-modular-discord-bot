import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/cli/commands';

interface Call { method: string; path: string; body: unknown }

let calls: Call[];
let out: string;
let err: string;
let exitCode: number | undefined;
const spies: Array<{ mockRestore: () => void }> = [];

function fakeClient(responseBody: unknown = { success: true }): any {
  return {
    request: async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      return { ok: true, status: 200, body: responseBody };
    },
    openWs: () => ({ close: () => undefined }),
  };
}

async function run(positionals: string[], flags: Record<string, string | boolean> = {}, responseBody?: unknown): Promise<void> {
  const p = dispatch(fakeClient(responseBody), positionals, flags);
  const done = await Promise.race([
    p.then(() => 'returned', (e: Error) => e.message),
    new Promise<string>((r) => setTimeout(() => r('pending'), 200)),
  ]);
  expect(done).toMatch(/^exit \d$/);
}

beforeEach(() => {
  calls = [];
  out = '';
  err = '';
  exitCode = undefined;
  spies.push(vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exitCode = code; throw new Error('exit ' + code); }) as any));
  spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any));
  spies.push(vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as any));
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe('smdb verbs call the panel route they name', () => {
  const cases: Array<[string[], Record<string, string | boolean>, string, string, unknown]> = [
    [['status'], {}, 'GET', '/api/bot/status', undefined],
    [['start'], {}, 'POST', '/api/bot/start', undefined],
    [['restart'], {}, 'POST', '/api/bot/restart', undefined],
    [['shutdown'], {}, 'POST', '/api/bot/shutdown', { emergency: false }],
    [['shutdown'], { emergency: true }, 'POST', '/api/bot/shutdown', { emergency: true }],
    [['restart-server'], {}, 'POST', '/api/bot/restart-server', undefined],
    [['logs'], {}, 'GET', '/api/bot/logs?limit=100', undefined],
    [['logs'], { limit: '7' }, 'GET', '/api/bot/logs?limit=7', undefined],
    [['logs'], { webui: true, limit: '3' }, 'GET', '/api/bot/logs/webui?limit=3', undefined],
    [['logs', 'clear'], {}, 'POST', '/api/bot/logs/clear', undefined],
    [['setup', 'status'], {}, 'GET', '/api/setup/status', undefined],
    [['credentials', 'set'], { body: '{"token":"t"}' }, 'POST', '/api/setup/credentials', { token: 't' }],
    [['config', 'list'], {}, 'GET', '/api/config/list', undefined],
    [['config', 'list'], { guild: 'g1' }, 'GET', '/api/config/list?guildId=g1', undefined],
    [['config', 'get'], { file: 'f.json', guild: 'g2' }, 'GET', '/api/config/get?file=f.json&guildId=g2', undefined],
    [['config', 'update'], { body: '{"a":1}' }, 'POST', '/api/config/update', { a: 1 }],
    [['config', 'backups'], { file: 'f.json', guild: 'g3', category: 'c' }, 'GET', '/api/config/backups?file=f.json&guildId=g3&category=c', undefined],
    [['config', 'restore'], { body: '{"b":2}' }, 'POST', '/api/config/restore', { b: 2 }],
    [['data', 'get', 'x.json'], { guild: 'g4' }, 'GET', '/api/config/data/get?file=x.json&guildId=g4', undefined],
    [['data', 'update'], { body: '{"c":3}' }, 'POST', '/api/config/data/update', { c: 3 }],
    [['appstore', 'bundle'], {}, 'GET', '/api/appstore/bundle', undefined],
    [['appstore', 'repos'], {}, 'GET', '/api/appstore/repos', undefined],
    [['appstore', 'modules'], {}, 'GET', '/api/appstore/modules', undefined],
    [['appstore', 'module', 'my mod'], {}, 'GET', '/api/appstore/modules/my%20mod', undefined],
    [['appstore', 'installed'], {}, 'GET', '/api/appstore/installed', undefined],
  ];
  for (const [pos, flags, method, path, body] of cases) {
    it(`${pos.join(' ')} ${JSON.stringify(flags)} -> ${method} ${path}`, async () => {
      await run(pos, flags);
      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ method, path, body }]);
    });
  }
});

describe('smdb verbs that need input refuse without it and send nothing', () => {
  const verbs = [['credentials', 'set'], ['config', 'update'], ['config', 'restore'], ['data', 'update']];
  for (const v of verbs) {
    it(`${v.join(' ')} without --body exits with a usage error`, async () => {
      await run(v);
      expect(exitCode).toBe(2);
      expect(calls).toEqual([]);
      expect(err).toContain('--body <json> is required');
    });
  }

  it('data get without a file names the missing argument', async () => {
    await run(['data', 'get']);
    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(err).toContain('missing argument: file\n');
  });

  it('appstore module without a name names the missing argument', async () => {
    await run(['appstore', 'module']);
    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(err).toContain('missing argument: name\n');
  });
});

describe('appstore installed prints a table in human mode', () => {
  let had: PropertyDescriptor | undefined;
  beforeEach(() => {
    had = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  });
  afterEach(() => {
    if (had) Object.defineProperty(process.stdout, 'isTTY', had);
    else delete (process.stdout as any).isTTY;
  });

  it('shows name, version and loaded for each module', async () => {
    await run(['appstore', 'installed'], {}, { success: true, modules: [{ name: 'alpha', version: '1.2', loaded: true }] });
    expect(exitCode).toBe(0);
    expect(out).toBe('name   version  loaded\nalpha  1.2      true\n');
  });
});
