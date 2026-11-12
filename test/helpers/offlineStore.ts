import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';

// The App Store routes clone the default repository (appStoreManager.ts DEFAULT_REPOS_CONFIG) when no clone is on
// disk. These tests lay that clone down themselves, and refuse every git command that would reach a remote (through
// execSync, the one child_process call appStoreManager.ts imports).

export const remoteGit: string[] = [];

const REMOTE = /^git\s+(clone|fetch|pull|push|ls-remote)\b|[a-z+]+:\/\/|git@/i;

export function offlineExecSync(real: (cmd: string, ...rest: any[]) => any): (cmd: string, ...rest: any[]) => any {
  return (cmd, ...rest) => {
    if (typeof cmd === 'string' && /^git\s/.test(cmd) && REMOTE.test(cmd)) {
      remoteGit.push(cmd.split(/\s+/).slice(0, 2).join(' '));
      throw new Error(`[Test] refused a git command that reaches a remote: ${cmd.split(/\s+/).slice(0, 2).join(' ')}`);
    }
    return real(cmd, ...rest);
  };
}

/** The default repository's clone as a refresh leaves it: a .git folder and one module under Modules/. */
export function seedStoreClone(): void {
  const clone = dataPath('global', 'appstore', 'cache', 'official-modules');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'Modules', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'Modules', 'alpha', 'module.json'), JSON.stringify({
    name: 'alpha', displayName: 'Alpha', description: 'A store module', version: '1.0.0', author: 'test', category: 'utility',
  }));
}
