import * as fs from 'fs';
import { createHash } from 'crypto';
import { dataPath } from '../../../utils/dataRoot';
import { resolveDataBackend } from '../../../utils/envLoader';
import { atomicWriteFileSync } from './atomicWrite';

export const componentConfigPath = (): string => dataPath('global', 'appstore', 'component-config.json');
export const appStoreConfigPath = (): string => dataPath('global', 'appstore', 'config.json');

/** sha: the sha of the bytes read, 'absent' for a missing file; a write passes it as its base (NB6 decision 28). */
export type ConfigRead =
  | { ok: true; config: Record<string, any>; sha: string }
  | { ok: false; error: string };

/** A missing file reads as empty; a read or parse error is reported, never read as empty. */
export function readConfigFile(file: string): ConfigRead {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, config: {}, sha: 'absent' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'the file does not hold a JSON object' };
    }
    return { ok: true, config: parsed, sha: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The change named in decision 28's 202 answer. */
const changeOf = (file: string): string => (file === componentConfigPath() ? 'command settings' : 'App Store settings');

/**
 * A JSON bot writes the file at once, as before, and the promise resolves. On a Postgres bot (NB6 decision 28) the
 * write is a shared write inside the store mutex, queued under the store lock with base (the sha readConfigFile gave,
 * or else that of the bytes the lock finds), and the promise settles with its ticket: StoreWriteError for an answer
 * other than success.
 */
export function writeConfigFile(file: string, config: Record<string, any>, base?: string): Promise<void> {
  const text = JSON.stringify(config, null, 2);
  if (resolveDataBackend() !== 'postgres') {
    atomicWriteFileSync(file, text);
    return Promise.resolve();
  }
  return import('./appStoreManager').then(async store => {
    const hold = await store.takeStoreMutex();
    try {
      const queued = store.withStoreLock(() => store.queueStoreDoc(file, text, base ?? store.storeFileSha(file)));
      if (queued) await store.awaitStoreDoc(queued, changeOf(file));
    } finally {
      hold.release();
    }
  });
}

let lastAppliedDisabledCommands: Set<string> | null = null;

export function getLastAppliedDisabledCommands(): Set<string> | null {
  return lastAppliedDisabledCommands;
}

export function setLastAppliedDisabledCommands(names: Set<string>): void {
  lastAppliedDisabledCommands = new Set(names);
}
