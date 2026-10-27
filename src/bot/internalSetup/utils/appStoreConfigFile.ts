import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { atomicWriteFileSync } from './atomicWrite';

export const componentConfigPath = (): string => dataPath('global', 'appstore', 'component-config.json');
export const appStoreConfigPath = (): string => dataPath('global', 'appstore', 'config.json');

export type ConfigRead =
  | { ok: true; config: Record<string, any> }
  | { ok: false; error: string };

/** A missing file reads as empty; a read or parse error is reported, never read as empty. */
export function readConfigFile(file: string): ConfigRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, config: {} };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'the file does not hold a JSON object' };
    }
    return { ok: true, config: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function writeConfigFile(file: string, config: Record<string, any>): void {
  atomicWriteFileSync(file, JSON.stringify(config, null, 2));
}

let lastAppliedDisabledCommands: Set<string> | null = null;

export function getLastAppliedDisabledCommands(): Set<string> | null {
  return lastAppliedDisabledCommands;
}

export function setLastAppliedDisabledCommands(names: Set<string>): void {
  lastAppliedDisabledCommands = new Set(names);
}
