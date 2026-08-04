// Co-worker write gating. Role is resolved from env (works with the bot
// child down): on a fleet co-worker, master-owned resources are read-only
// here and managed on the master's web UI.

import { Request, Response, NextFunction } from 'express';
import { resolveNodeRole } from '../../bot/internalSetup/fleet/nodeIdentity';

export function isCoWorkerNode(): boolean {
  return resolveNodeRole() === 'co-worker';
}

export function coWorkerReadonlyResponse(res: Response): void {
  res.status(403).json({
    success: false,
    code: 'co-worker-readonly',
    error: 'This node is a fleet co-worker; this resource is managed by the master',
  });
}

/** 403 on every verb when this node is a co-worker. */
export function requireMasterNode(_req: Request, res: Response, next: NextFunction): void {
  if (isCoWorkerNode()) {
    coWorkerReadonlyResponse(res);
    return;
  }
  next();
}

/** GET/HEAD pass; mutating verbs 403 when this node is a co-worker. */
export function blockWritesOnCoWorker(req: Request, res: Response, next: NextFunction): void {
  if (isCoWorkerNode() && req.method !== 'GET' && req.method !== 'HEAD') {
    coWorkerReadonlyResponse(res);
    return;
  }
  next();
}
