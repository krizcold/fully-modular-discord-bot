import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { setBackendKind } from '../helpers/backendKind';

interface FakeRes {
  statusCode: number;
  bodies: unknown[];
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    bodies: [],
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.bodies.push(body); return this; },
  };
}

function addressesRoute() {
  const lists: string[] = [];
  const bot = {
    applyAddressList: async (url: string) => { lists.push(url); return { status: 200, body: { success: true, applied: true } }; },
  };
  const router: any = createManagedRoutes(bot as any, {} as any);
  const layer = router.stack.find((l: any) => l.route && l.route.methods.post && l.route.path === '/addresses');
  const handle = layer.route.stack[0].handle as (req: any, res: any) => Promise<unknown>;
  return {
    lists,
    post: async (body: unknown) => {
      const res = fakeRes();
      await handle({ body }, res);
      return res;
    },
  };
}

const EMPTY = { success: false, error: 'url must be a non-empty string' };
const FILE_BOT = { success: false, error: 'This bot keeps its data in files, so it has no main database' };

beforeEach(() => { setBackendKind('postgres'); });
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('ru9 the addresses hook', () => {
  it('ru9 hands the bot the list without the spaces around it', async () => {
    const route = addressesRoute();
    const res = await route.post({ url: '  postgres://a.example:5432/bot  ' });
    expect(res.statusCode).toBe(200);
    expect(route.lists).toEqual(['postgres://a.example:5432/bot']);
  });

  it('ru9 a url of only spaces answers 400 that the url is empty', async () => {
    const route = addressesRoute();
    const res = await route.post({ url: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.bodies).toEqual([EMPTY]);
    expect(route.lists).toEqual([]);
  });

  it('ru9 an empty url answers 400 that the url is empty', async () => {
    const route = addressesRoute();
    const res = await route.post({ url: '' });
    expect(res.statusCode).toBe(400);
    expect(res.bodies).toEqual([EMPTY]);
    expect(route.lists).toEqual([]);
  });

  it('ru9 a url that is no string answers 400 that the url is empty', async () => {
    const route = addressesRoute();
    const res = await route.post({ url: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.bodies).toEqual([EMPTY]);
    expect(route.lists).toEqual([]);
  });

  it('ru9 a file bot answers 409 that it has no main database and applies nothing', async () => {
    setBackendKind('file');
    const route = addressesRoute();
    const res = await route.post({ url: 'postgres://a.example:5432/bot' });
    expect(res.statusCode).toBe(409);
    expect(res.bodies).toEqual([FILE_BOT]);
    expect(route.lists).toEqual([]);
  });
});
