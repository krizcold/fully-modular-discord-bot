// src/webui/middleware/pathGuard.ts

import { Request, Response, NextFunction } from 'express';
import * as path from 'path';

/**
 * The gateway in front of the bot (AppShield or Authelia) lets /guild, /auth and /assets/ through without the admin
 * login. It judges a request on the decoded, normalized path but passes the raw one on, and Express routes the raw
 * one. So, before any route, the guard refuses the raw forms that nginx's and Go's decoding and cleaning can read as
 * another segment, prefix or extension: an encoded slash, backslash, "?" or "#", a literal backslash or "#", an empty
 * segment ("//"), a "." or ".." segment, and a percent-encoded unreserved character (a letter, digit, "-", ".", "_"
 * or "~", which RFC 3986 makes equal to the bare one, so no client needs to encode it) or control character. Any
 * other encoded character (a space, ":", "@", non-ASCII) stays inside one name. An /api path ending in a static-file
 * extension is refused too: that keeps an old gateway extension rule off the owner API routes, though not off the
 * admin page's own files, which is why no gateway keeps one. Only the path is judged: query strings legitimately
 * carry %2F. The admin catch-all serves the admin page only at a plain path (isAdminPagePath), which every gateway
 * reads as the bot does.
 */
const ENCODED_OR_BACKSLASH = /%2f|%5c|%3f|%23|\\|#/i;
const ENCODED_UNRESERVED_OR_CONTROL = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2[de]|5f|7e|[01][0-9a-f]|7f)/i;
const API_STATIC = /^\/api\/.*\.(?:js|jsx|css|png|ico|svg|jpg|jpeg|gif|woff|woff2|ttf|eot)$/i;
// "/" and the admin page's tabs: plain segments of letters, digits, "-" and "_".
const ADMIN_PAGE_PATH = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/;

export function isRefusedPath(originalUrl: string): boolean {
  const pathPart = originalUrl.split('?', 1)[0];
  if (ENCODED_OR_BACKSLASH.test(pathPart) || ENCODED_UNRESERVED_OR_CONTROL.test(pathPart)) return true;
  if (pathPart.includes('//') || pathPart.split('/').some(segment => segment === '.' || segment === '..')) return true;
  return API_STATIC.test(pathPart);
}

export function pathGuard(req: Request, res: Response, next: NextFunction): void {
  if (isRefusedPath(req.originalUrl)) {
    res.status(400).json({ error: 'This request path is not accepted' });
    return;
  }
  next();
}

/** Whether the admin catch-all may answer this raw path with the admin page. */
export function isAdminPagePath(rawPath: string): boolean {
  return ADMIN_PAGE_PATH.test(rawPath);
}

/** After every route: a path no route or file answered gets 404, never the admin page. */
export function pathMiss(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

/** The admin catch-all: the admin page at a plain path no route or file answered, 404 at any other. */
export function adminPageFallback(publicDir: string): (req: Request, res: Response) => void {
  return (req, res) => {
    if (!isAdminPagePath(req.path)) {
      pathMiss(req, res);
      return;
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  };
}
