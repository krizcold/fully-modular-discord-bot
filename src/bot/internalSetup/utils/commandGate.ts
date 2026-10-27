import { componentConfigPath, getLastAppliedDisabledCommands, readConfigFile } from './appStoreConfigFile';

export type CommandGate = { runnable: true } | { runnable: false; reason: 'disabled' | 'unknown'; error?: string };

/** Refuses a command switched off in component-config; on a read error, the last applied set decides, or it refuses. */
export function isCommandRunnable(commandName: string): CommandGate {
  const read = readConfigFile(componentConfigPath());
  if (!read.ok) {
    const applied = getLastAppliedDisabledCommands();
    if (!applied) return { runnable: false, reason: 'unknown', error: read.error };
    return applied.has(commandName) ? { runnable: false, reason: 'disabled' } : { runnable: true };
  }
  for (const [key, value] of Object.entries(read.config)) {
    if (value !== false) continue;
    const parts = key.split(':');
    if (parts.length >= 3 && parts[1] === 'command' && parts.slice(2).join(':') === commandName) {
      return { runnable: false, reason: 'disabled' };
    }
  }
  return { runnable: true };
}
