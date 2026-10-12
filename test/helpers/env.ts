import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// What a test, and a child process it starts, keeps of the environment it was
// started in: the platform's own variables, vitest's, the active Stryker
// mutant, Docker's and testcontainers' (the integration tier starts its
// containers from the tests), and this suite's own (SMDB_). Every other
// variable is taken out, whoever would read it (src by name or through
// configManager's process.env[key], pg, dotenv, discord.js, git), so a
// developer's shell can point no run at a real fleet, database, manager,
// payment provider or Discord account. unit/envScrub.test.ts holds the list
// against what src reads.
const KEPT_NAMES = new Set([
  // Windows
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME',
  'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'PUBLIC', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
  // POSIX
  'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'USER',
  // the test tools
  'CI', 'FORCE_COLOR', 'NO_COLOR', 'TEST',
]);
const KEPT_PREFIXES = ['LC_', 'XDG_', 'VITEST', 'SMDB_', 'DOCKER_', 'TESTCONTAINERS_', '__STRYKER_'];

// Windows names its variables in any case.
export function kept(key: string): boolean {
  const name = key.toUpperCase();
  return KEPT_NAMES.has(name) || KEPT_PREFIXES.some(prefix => name.startsWith(prefix));
}

export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) if (!kept(key)) delete env[key];
  return env;
}

// Where nothing names them, pg connects to localhost:5432 as the OS user with
// the user's password file, and git looks for a repository in every dir above
// its cwd: from a Stryker sandbox, which sits inside the checkout and holds no
// .git, that is the checkout's own, and from a test's data dir or a child's
// cwd, under the temp dir, whatever repository holds the temp dir. These point
// both at nothing: PGHOST at a socket dir that does not exist, PGPASSFILE at no
// file, and git no higher than the dir that holds the bot root (in a sandbox,
// .stryker-tmp) or than the temp dir.
const botRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEAD_ENDS = {
  PGHOST: '/smdb-no-postgres',
  PGPASSFILE: path.join(botRoot, 'test', 'no-pgpass'),
  GIT_CEILING_DIRECTORIES: [path.dirname(botRoot), os.tmpdir()].join(path.delimiter),
};
