// src/webui/middleware/auth.ts

import { Request, Response, NextFunction } from 'express';

/**
 * Web-UI access is authenticated at the deployment BOUNDARY, not by this app:
 *  - Managed by the Bot Manager: a gateway fronts the bot (AppShield on Yundera,
 *    Authelia on the remote/Linux stack) and authenticates before the request arrives.
 *  - Standalone self-hosted: locally the web UI binds to 127.0.0.1 (localhost only),
 *    so only the local machine can reach it. For a public Linux server, setup.sh
 *    deploys docker-compose.remote.yml (Caddy + Authelia) as the gateway.
 *
 * There is no in-app URL secret. This middleware is kept so route wiring is unchanged;
 * it intentionally passes every request through.
 */
export function requireAuth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
