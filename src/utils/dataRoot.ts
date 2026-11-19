// Single resolution point for the persistent data root: /data (container
// mount) in production, ./data under the repo in local development.

import * as fs from 'fs';
import * as path from 'path';

function resolveDataRoot(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.NODE_ENV === 'development') {
    const devRoot = path.resolve(__dirname, '..', '..', 'data');
    fs.mkdirSync(devRoot, { recursive: true });
    return devRoot;
  }
  return '/data';
}

export const DATA_ROOT = resolveDataRoot();

/** The data root as the container mounts it, for texts that name a data path. */
export const CONTAINER_DATA_ROOT = '/data';

export function dataPath(...segments: string[]): string {
  return path.join(DATA_ROOT, ...segments);
}
