import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { STEP_MS, TIME_SCALE } from './helpers/time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = path.join(repo, 'src');

// The tiers are projects so a run can pick one (the mutation passes do, see
// mutation/README.md): fast takes every test file outside the other two, so a
// new directory is never left out; integration needs Docker; child runs real
// processes on a dist that its globalSetup rebuilds unless it holds a build of
// exactly this src (helpers/build.cjs).
const SLOW = ['integration/**', 'child/**'];

// The exact test files a mutation gate run takes (mutation/runner.mjs names a
// JSON list of paths relative to test/ in SMDB_MUTATION_INCLUDE): vitest's own
// file filters take every path that holds a name, and a long list can pass
// Windows' limit on a command line. Kept on the process, as vitest may load this
// file again for a project, and taken out of the env, so no vitest a test
// starts inherits it.
const LISTED = Symbol.for('smdb.mutationInclude');
const processState = globalThis as Record<PropertyKey, unknown>;
if (process.env.SMDB_MUTATION_INCLUDE) {
  processState[LISTED] = JSON.parse(fs.readFileSync(process.env.SMDB_MUTATION_INCLUDE, 'utf8')) as string[];
  delete process.env.SMDB_MUTATION_INCLUDE;
}
const listed = processState[LISTED] as string[] | undefined;
// Each name as a glob that matches only itself, by tinyglobby's own escapes for the platform.
const exact = (file: string) => file.replace(process.platform === 'win32' ? /([()[\]{}]|^!|[!+@](?=\())/g : /([()[\]{}*?|]|^!|[!+@](?=\())/g, '\\$1');
const tierOf = (file: string) => (file.startsWith('integration/') ? 'integration' : file.startsWith('child/') ? 'child' : 'fast');
const include = (tier: string, globs: string[]) => (listed ? listed.filter(file => tierOf(file) === tier).map(exact) : globs);

// Mirrors the paths of the root tsconfig.json; the exact @bot/types entry
// comes before the @bot/* prefix it would otherwise match.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@bot\/types$/, replacement: path.join(src, 'bot/types') },
      { find: /^@internal\/(.*)$/, replacement: path.join(src, 'bot/internalSetup/$1') },
      { find: /^@modules\/(.*)$/, replacement: path.join(src, 'bot/modules/$1') },
      { find: /^@bot\/(.*)$/, replacement: path.join(src, 'bot/$1') },
      { find: /^@webui\/(.*)$/, replacement: path.join(src, 'webui/$1') },
      { find: /^@\/(.*)$/, replacement: path.join(src, '$1') },
    ],
  },
  server: { fs: { allow: [repo] } },
  test: {
    root: here,
    // A pass A run with no mutant records what each test file reached
    // (mutation/README.md); first, so its recorder is in place before any instrumented file loads.
    setupFiles: [...(process.env.SMDB_MUTATION_COVERAGE ? ['./helpers/mutationCoverage.ts'] : []), './helpers/setup.ts'],
    // Not 'test', as a developer's shell may set it, so every run shows that
    // setup.ts puts it right (unit/envScrub.test.ts).
    env: { NODE_ENV: 'development' },
    pool: 'forks',
    testTimeout: 30_000 * TIME_SCALE,
    hookTimeout: 180_000 * TIME_SCALE,
    projects: [
      { extends: true, test: { name: 'fast', include: include('fast', ['**/*.test.ts']), exclude: ['node_modules/**', ...SLOW] } },
      { extends: true, test: { name: 'integration', include: include('integration', ['integration/**/*.test.ts']) } },
      // A child test may run up to 14 steps: one that hangs fails by its own bound first.
      { extends: true, test: { name: 'child', include: include('child', ['child/**/*.test.ts']),globalSetup: ['./helpers/childBuild.ts'], testTimeout: 15 * STEP_MS } },
    ],
  },
});
