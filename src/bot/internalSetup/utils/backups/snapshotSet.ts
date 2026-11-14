import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../../../utils/dataRoot';
import { ROOT_CONFIG_PATH } from '../configManager';

export const ROOT_CONFIG_REL = 'dist/bot/config.json';
export const OWNER_CHANNEL_REL = 'owner-channel.json';

const NUMERIC = /^\d+$/;
const GLOBAL_OUT = new Set(['appstore', 'fleet']);

function rootConfigInSet(): boolean {
  return path.resolve(ROOT_CONFIG_PATH) === path.resolve(dataPath(...ROOT_CONFIG_REL.split('/')));
}

/** Whether a POSIX path relative to the data root is in the snapshot set; the '.tmp' rule applies to files only. */
export function classify(rel: string, type: 'file' | 'dir' = 'file'): 'in' | 'out' {
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) return 'out';
  if (type === 'file' && parts[parts.length - 1].endsWith('.tmp')) return 'out';
  const [top] = parts;
  if (NUMERIC.test(top)) return 'in';
  if (top === '_graveyard') return parts.length > 1 && parts[1].startsWith('.sweep-') ? 'out' : 'in';
  if (top === 'global') return parts.length > 1 && GLOBAL_OUT.has(parts[1]) ? 'out' : 'in';
  if (rel === ROOT_CONFIG_REL) return rootConfigInSet() ? 'in' : 'out';
  if (rel === OWNER_CHANNEL_REL) return 'in';
  return 'out';
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
}

function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * The restore's units under `root` (the data root or a staging tree), as POSIX paths relative to it: each numeric
 * entry, `_graveyard`, each child of `global` in the set, the root config and `owner-channel.json`, where present.
 * Every path `classify` puts in the set lies in exactly one unit.
 */
export function topItems(root: string = DATA_ROOT): string[] {
  const units: string[] = [];
  for (const e of entries(root)) {
    if (NUMERIC.test(e.name) || e.name === '_graveyard' || (e.name === 'global' && !e.isDirectory())) units.push(e.name);
    else if (e.name === OWNER_CHANNEL_REL && classify(e.name) === 'in') units.push(e.name);
  }
  const global = entries(path.join(root, 'global'));
  for (const e of global) {
    const rel = `global/${e.name}`;
    if (classify(rel, e.isDirectory() ? 'dir' : 'file') === 'in') units.push(rel);
  }
  if (classify(ROOT_CONFIG_REL) === 'in' && present(path.join(root, ...ROOT_CONFIG_REL.split('/')))) units.push(ROOT_CONFIG_REL);
  return units.sort();
}
