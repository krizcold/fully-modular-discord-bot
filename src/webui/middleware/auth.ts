// src/webui/middleware/auth.ts

import { Request, Response, NextFunction } from 'express';

/**
 * Web-UI access is authenticated at the deployment BOUNDARY, not by this app:
 *  - Managed by the Bot Manager: a gateway fronts the bot (AppShield OIDC on Yundera,
 *    Authelia on the remote/Linux stack) and authenticates before the request arrives.
 *  - Standalone self-hosted: the web UI binds to 127.0.0.1 (localhost only), so only
 *    the local machine can reach it. Exposing the port to a network is the operator's
 *    choice and must be done behind a reverse proxy / auth gateway.
 *
 * There is no in-app URL secret. This middleware is kept so route wiring is unchanged;
 * it intentionally passes every request through.
 */
export function requireAuth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
