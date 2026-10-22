import fc from 'fast-check';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { adminPageFallback, isAdminPagePath, isRefusedPath, pathGuard, pathMiss } from '../../src/webui/middleware/pathGuard';

// HF1 (notes/HF1.md): the gateways judge a request on the decoded, normalized path and pass the raw one on, so the
// bot refuses, before any route sees it, the raw forms the two could read as another segment, prefix or extension.

const REFUSED = [
  '/assets/..%2Fapi%2Fbot%2Fstatus',
  '/assets/%2e%2e/api/config',
  '/assets/%2E%2E/api/config',
  '/guild/%2e/api/bot',
  '/guild/api/panels/a%2fb',
  '/assets/x%5cy',
  '/assets/x%5Cy',
  '/assets\\..\\api\\bot',
  '/assets/x\\y.css',
  '/assets/../api/bot',
  '/assets/./styles.css',
  '/guild/..',
  '/guild/.',
  '/..',
  '/.',
  '/api/bot/status/../../assets/x',
  '/api/bot/status.js',
  '/api/config/x.CSS',
  '/api/bot/a.woff2',
  '/api/x.Js',
  '/API/bot/x.js',
  '/Api/bot/x.png',
  '/api/bot/x.ico?y=1',
  '/api/.jsx',
  // Review round 1: an encoded unreserved character (RFC 3986 2.3), an encoded control character, a raw '#'.
  '/api/appstore/modules/foo.j%73',
  '/api/bot/status.c%73s',
  '/api/x.%6As',
  '/api/a.pn%67',
  '/api/x.js#',
  '/api/bot/x.js#y',
  '/guild#x',
  '/%67uild/x',
  '/%61ssets/styles.css',
  '/%61uth/discord',
  '/guild/%41bc',
  '/assets/x%2D',
  '/assets/x%5f',
  '/assets/x%7E',
  '/assets/x%30',
  '/x%00',
  '/x%1f',
  '/x%7F',
  // Delta round 1: an encoded '?' or '#', which a gateway decodes into a query or a fragment.
  '/guild%3Fx',
  '/guild%3f',
  '/auth%3Fx',
  '/auth%3F/discord',
  '/assets%3Fx',
  '/guild%23x',
  '/api/appstore/modules/foo.js%3Fx',
  '/api/x.js%23',
  // Delta round 2: an empty segment, which nginx and Go's path cleaning merge away.
  '//guild',
  '//guild/x',
  '//auth/discord',
  '//assets/zz',
  '/guild//x',
  '/assets//styles.css',
];

const ACCEPTED = [
  '/',
  '/assets/styles.css',
  '/assets/utils/guildApi.js',
  '/assets/components/guild/OAuthLogin.jsx',
  '/guild',
  '/guild/123456789012345678',
  '/guild/123456789012345678/subscription',
  '/guild/api/panels/123456789012345678/my-panel',
  '/auth/discord',
  '/auth/discord/callback?code=abc&state=x%2Fy%2E%2e%5C',
  '/api/config/file?path=modules%2Fx%2Fconfig.json',
  '/api/panels/x?file=a.js',
  '/api/bot/status',
  '/api/health',
  '/api/appstore/modules/my.module',
  '/api/config/settings.json',
  '/api/bot/x.jsonl',
  '/api/bot/x.css.bak',
  '/webhook/stripe',
  '/styles.css',
  '/styles/update-panel.css',
  '/build-info.js',
  '/utils/api.js',
  '/utils/emojiShortcodes.json',
  '/components/UsagePanel.jsx',
  '/apis/x.js',
  '/guild/api/x.js',
  '/a..b/c',
  '/x/.hidden',
  '/guild/api/panels/a%20b',
  '/guild/api/x%C3%A9',
  '/api/appstore/modules/my%40mod',
  '/guild/api/x%21',
  '/assets/x%252Fy',
  '/auth/discord/callback?code=%61%2E%23',
  // Delta round 1: the encoded characters next to the refused ones, which real ids carry (a boost id holds ':').
  '/guild/api/subscriptions/123456789012345678/orphans/boost/boost%3A1%3A2%3Avip',
  '/guild/api/x%3a%3B%3C%3D%3E',
  '/guild/api/x%5B1%5D%5e',
  '/guild/api/x%60',
  '/guild/api/x%7B%7D%7c',
  '/guild/api/x%25',
  '/assets/',
  '/guild/',
];

describe('isRefusedPath', () => {
  it.each(REFUSED)('refuses %s', p => {
    expect(isRefusedPath(p)).toBe(true);
  });

  it.each(ACCEPTED)('accepts %s', p => {
    expect(isRefusedPath(p)).toBe(false);
  });

  const segChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~'.split(''));
  const plainSeg = fc.string({ unit: segChar, minLength: 1, maxLength: 10 });
  const plainPath = fc.array(plainSeg, { minLength: 0, maxLength: 5 }).map(s => `/${s.join('/')}`);
  const query = fc.oneof(fc.constant(''), fc.constantFrom('?a=%2F', '?p=..%2F..%2Fx.js', '?x=%5c', '?y=.', '?z=a/../b'));

  it('refuses a refused form anywhere in a path, in any case, whatever the query', () => {
    const form = fc.constantFrom('%2F', '%2f', '%5C', '%5c', '%2E', '%2e', '%3F', '%3f', '%23', '\\');
    fc.assert(fc.property(plainPath, form, fc.nat(), query, (p, f, at, q) => {
      const i = at % (p.length + 1);
      return isRefusedPath(`${p.slice(0, i)}${f}${p.slice(i)}${q}`);
    }));
  });

  it('refuses a percent-encoded unreserved character anywhere in the path, in either case', () => {
    fc.assert(fc.property(plainPath.filter(p => p.length > 1), fc.nat(), fc.boolean(), query, (p, at, upper, q) => {
      const i = 1 + (at % (p.length - 1));
      if (p[i] === '/') return true;
      const hex = p.charCodeAt(i).toString(16).padStart(2, '0');
      return isRefusedPath(`${p.slice(0, i)}%${upper ? hex.toUpperCase() : hex}${p.slice(i + 1)}${q}`);
    }));
  });

  it('refuses an empty segment anywhere in the path, whatever the query', () => {
    fc.assert(fc.property(plainPath, fc.nat(), query, (p, at, q) => {
      const slashes = [...p].map((ch, i) => (ch === '/' ? i : -1)).filter(i => i >= 0);
      const i = slashes[at % slashes.length];
      return isRefusedPath(`${p.slice(0, i + 1)}/${p.slice(i + 1)}${q}`);
    }));
  });

  it('refuses a raw # anywhere in the path', () => {
    fc.assert(fc.property(plainPath, fc.nat(), (p, at) => {
      const i = at % (p.length + 1);
      return isRefusedPath(`${p.slice(0, i)}#${p.slice(i)}`);
    }));
  });

  it('refuses a dot segment at any depth', () => {
    fc.assert(fc.property(fc.array(plainSeg, { maxLength: 4 }), fc.array(plainSeg, { maxLength: 4 }),
      fc.constantFrom('.', '..'), fc.boolean(), query, (before, after, dot, trailingSlash, q) => {
        const p = `/${[...before, dot, ...after].join('/')}${trailingSlash ? '/' : ''}`;
        return isRefusedPath(`${p}${q}`);
      }));
  });

  it('refuses an /api path ending in a static extension, in any case, and nothing else under /api', () => {
    const ext = fc.constantFrom('js', 'jsx', 'css', 'png', 'ico', 'svg', 'jpg', 'jpeg', 'gif', 'woff', 'woff2', 'ttf', 'eot');
    const casing = fc.array(fc.boolean(), { minLength: 8, maxLength: 8 });
    const flip = (s: string, c: boolean[]) => s.split('').map((ch, i) => (c[i % c.length] ? ch.toUpperCase() : ch)).join('');
    fc.assert(fc.property(fc.array(plainSeg, { maxLength: 4 }), plainSeg, ext, casing, casing, query,
      (mid, name, e, c1, c2, q) => {
        const p = `/${flip('api', c1)}/${[...mid, `${name}.${flip(e, c2)}`].join('/')}`;
        return isRefusedPath(`${p}${q}`) && !isRefusedPath(`/api/${[...mid, name].join('/')}${q}`);
      }));
  });

  it('accepts every plain path outside /api, extension or not, whatever the query', () => {
    const ext = fc.constantFrom('', '.js', '.jsx', '.css', '.png', '.json', '.html');
    fc.assert(fc.property(plainPath, ext, query, (p, e, q) => {
      if (/^\/api(\/|$)/i.test(p)) return true;
      return !isRefusedPath(`${p}${p === '/' ? '' : e}${q}`);
    }));
  });
});

describe('pathGuard', () => {
  const run = (originalUrl: string, url = originalUrl) => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    pathGuard({ originalUrl, url } as never, res as never, next);
    return { res, next };
  };

  it('answers 400 with its message and stops the chain for a refused path', () => {
    const { res, next } = run('/assets/..%2Fapi%2Fbot');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'This request path is not accepted' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an accepted path on untouched', () => {
    const { res, next } = run('/assets/styles.css');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('answers a path no route matched with 404, never the admin page', () => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    pathMiss({ originalUrl: '/assets/zzz' } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('judges the original url, not the mount-relative one', () => {
    expect(run('/assets/../api/bot', '/x').next).not.toHaveBeenCalled();
    expect(run('/assets/styles.css', '/../x').next).toHaveBeenCalledTimes(1);
  });
});

// Delta round 2 (notes/HF1.md): the admin page's tabs are plain paths, so the catch-all serves it only at one; every
// other form, which a gateway may read as a public path, gets 404 there.
describe('isAdminPagePath', () => {
  it.each(['/', '/dashboard', '/credentials', '/credentials/', '/devmodules', '/dev-modules', '/a/b_c/1', '/X9'])('serves the admin page at %s', p => {
    expect(isAdminPagePath(p)).toBe(true);
  });

  it.each(['', '//', '//guild/x', '//auth/discord', '//assets/zz', '/a//b', '/x.y', '/.', '/a%20b', '/guild%3Fx', '/a b', '/a~b',
    '/a@b', '/:x', '/a\\b', '/a#b', 'credentials'])('never at %s', p => {
    expect(isAdminPagePath(p)).toBe(false);
  });

  const plainChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split(''));
  const plain = fc.array(fc.string({ unit: plainChar, minLength: 1, maxLength: 8 }), { maxLength: 4 });

  it('serves it at every plain path, with or without a trailing slash', () => {
    fc.assert(fc.property(plain, fc.boolean(), (segs, slash) => isAdminPagePath(`/${segs.join('/')}${slash && segs.length ? '/' : ''}`)));
  });

  it('never serves it once any other character is in the path', () => {
    const other = fc.constantFrom('.', '~', '%', '!', '$', '&', "'", '(', ')', '*', '+', ',', ';', '=', ':', '@', ' ', '\\', '#', '?', '\u00e9');
    fc.assert(fc.property(plain.filter(s => s.length > 0), other, fc.nat(), (segs, ch, at) => {
      const p = `/${segs.join('/')}`;
      const i = 1 + (at % (p.length - 1));
      return !isAdminPagePath(`${p.slice(0, i)}${ch}${p.slice(i)}`);
    }));
  });
});

// Delta round 3 (notes/HF1.md): the catch-all's body, as a handler with its own rows instead of a source-text pin.
describe('adminPageFallback', () => {
  const PUBLIC_DIR = path.join('srv', 'public');
  const run = (req: { path: string; url?: string; originalUrl?: string }) => {
    const res = { status: vi.fn(), json: vi.fn(), sendFile: vi.fn() };
    res.status.mockReturnValue(res);
    adminPageFallback(PUBLIC_DIR)(req as never, res as never);
    return res;
  };

  it.each(['/', '/credentials', '/credentials/', '/zz'])('sends the admin page once at %s', p => {
    const res = run({ path: p });
    expect(res.sendFile).toHaveBeenCalledTimes(1);
    expect(res.sendFile).toHaveBeenCalledWith(path.join(PUBLIC_DIR, 'index.html'));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each(['/x.y', '/a%20b', '/guild%3Fx', '/a@b', '/index.html'])('answers 404 at %s, never the admin page', p => {
    const res = run({ path: p });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('judges the path, not the url with its query', () => {
    const res = run({ path: '/credentials', url: '/credentials?tab=a.b', originalUrl: '/credentials?tab=a.b' });
    expect(res.sendFile).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
