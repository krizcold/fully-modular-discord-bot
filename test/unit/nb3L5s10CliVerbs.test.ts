import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../src/cli/commands';
import { EXIT_OK, EXIT_USAGE } from '../../src/cli/output';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

interface Call { method: string; path: string; opts: any }

async function run(positionals: string[], flags: Record<string, string | boolean> = {}, opts: { tty?: boolean; body?: unknown } = {}) {
  const calls: Call[] = [];
  let out = '';
  let err = '';
  const client: any = {
    request: async (method: string, path: string, o?: any) => {
      calls.push({ method, path, opts: o });
      return { status: 200, ok: true, body: opts.body ?? { success: true } };
    },
  };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { out += String(s); return true; }) as any);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { err += String(s); return true; }) as any);
  const ttyBefore = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  if (opts.tty !== undefined) Object.defineProperty(process.stdout, 'isTTY', { value: opts.tty, configurable: true, writable: true });
  let code: number | undefined | 'none' = 'none';
  try {
    await dispatch(client, positionals, flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
    if (opts.tty !== undefined) {
      if (ttyBefore) Object.defineProperty(process.stdout, 'isTTY', ttyBefore);
      else delete (process.stdout as any).isTTY;
    }
  }
  return { code, out, err, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('smdb verbs send the route the panel serves', () => {
  const routes: Array<[string[], string, string]> = [
    [['appstore', 'queue'], 'GET', '/api/appstore/install-queue'],
    [['premium', 'tiers'], 'GET', '/api/appstore/premium/tiers'],
    [['panels', 'list'], 'GET', '/api/panels/list'],
    [['devmodules', 'list'], 'GET', '/api/devmodules/list'],
    [['devmodules', 'reload', 'mod a'], 'POST', '/api/devmodules/mod%20a/reload'],
    [['devmodules', 'reload-all'], 'POST', '/api/devmodules/reload-all'],
    [['update', 'status'], 'GET', '/api/update/status'],
    [['update', 'check'], 'POST', '/api/update/check'],
    [['update', 'trigger'], 'POST', '/api/update/trigger'],
    [['update', 'check-all'], 'POST', '/api/update/check-all'],
    [['update', 'module', 'mod a'], 'POST', '/api/update/modules/mod%20a'],
    [['update', 'all-modules'], 'POST', '/api/update/modules'],
  ];
  for (const [pos, method, route] of routes) {
    it(`${pos.join(' ')} sends ${method} ${route}`, async () => {
      const r = await run(pos);
      expect(r.code).toBe(EXIT_OK);
      expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual([`${method} ${route}`]);
    });
  }
});

describe('a verb missing an argument names it', () => {
  const cases: Array<[string[], string]> = [
    [['appstore', 'install'], 'name'],
    [['appstore', 'uninstall'], 'name'],
    [['panels', 'exec'], 'panelId'],
    [['panels', 'press'], 'panelId'],
    [['panels', 'press', 'p1'], 'buttonId'],
    [['panels', 'select', 'p1'], 'dropdownId'],
    [['panels', 'modal'], 'panelId'],
    [['panels', 'modal', 'p1'], 'modalId'],
    [['devmodules', 'reload'], 'name'],
    [['update', 'module'], 'name'],
  ];
  for (const [pos, label] of cases) {
    it(`${pos.join(' ')} says missing argument: ${label}`, async () => {
      const r = await run(pos, { repo: 'r1' });
      expect(r.code).toBe(EXIT_USAGE);
      expect(r.err).toBe(`smdb: missing argument: ${label}\n`);
      expect(r.calls).toEqual([]);
    });
  }
});

describe('appstore install and uninstall', () => {
  it('install posts the repo id to the module install route', async () => {
    const r = await run(['appstore', 'install', 'my mod'], { repo: 'repo-1' });
    expect(r.code).toBe(EXIT_OK);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].method).toBe('POST');
    expect(r.calls[0].path).toBe('/api/appstore/modules/my%20mod/install');
    expect(r.calls[0].opts).toEqual({ body: { repoId: 'repo-1' } });
  });

  it('install without --repo refuses with the usage text and sends nothing', async () => {
    const r = await run(['appstore', 'install', 'm']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.err).toBe('smdb: --repo <id> is required\n');
    expect(r.calls).toEqual([]);
  });

  it('uninstall sends DELETE to the module route', async () => {
    const r = await run(['appstore', 'uninstall', 'my mod']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual(['DELETE /api/appstore/modules/my%20mod']);
  });
});

describe('appstore installed table', () => {
  it('prints name, version and loaded columns in human mode', async () => {
    const r = await run(['appstore', 'installed'], {}, { tty: true, body: { success: true, modules: [{ name: 'alpha', version: '1.2.3', loaded: true }] } });
    expect(r.code).toBe(EXIT_OK);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines[0].split(/\s+/)).toEqual(['name', 'version', 'loaded']);
    expect(lines[1].split(/\s+/)).toEqual(['alpha', '1.2.3', 'true']);
  });
});

describe('panels bodies', () => {
  it('exec posts the panel id and context', async () => {
    const r = await run(['panels', 'exec', 'p1'], { guild: 'g1' });
    expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/panels/execute']);
    expect(r.calls[0].opts.body).toEqual({ panelId: 'p1', userId: 'web-ui-owner', guildId: 'g1' });
  });

  it('press posts the panel and button ids', async () => {
    const r = await run(['panels', 'press', 'p1', 'b1']);
    expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/panels/button']);
    expect(r.calls[0].opts.body).toEqual({ panelId: 'p1', buttonId: 'b1', userId: 'web-ui-owner' });
  });

  it('select posts the dropdown id and the non-empty values', async () => {
    const r = await run(['panels', 'select', 'p1', 'd1'], { values: 'ab,,cd' });
    expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/panels/dropdown']);
    expect(r.calls[0].opts.body).toEqual({ panelId: 'p1', dropdownId: 'd1', values: ['ab', 'cd'], userId: 'web-ui-owner' });
  });

  it('select without --values posts an empty list', async () => {
    const r = await run(['panels', 'select', 'p1', 'd1']);
    expect(r.calls[0].opts.body.values).toEqual([]);
  });

  it('modal posts the modal id and the parsed fields', async () => {
    const r = await run(['panels', 'modal', 'p1', 'm1'], { fields: '{"a":1}' });
    expect(r.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/panels/modal']);
    expect(r.calls[0].opts.body).toEqual({ panelId: 'p1', modalId: 'm1', fields: { a: 1 }, userId: 'web-ui-owner' });
  });

  it('modal without --fields posts empty fields', async () => {
    const r = await run(['panels', 'modal', 'p1', 'm1']);
    expect(r.calls[0].opts.body.fields).toEqual({});
  });
});
