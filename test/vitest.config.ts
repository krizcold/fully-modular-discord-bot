import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = path.join(repo, 'src');

// The tiers are projects so a run can pick one (the mutation passes do, see
// mutation/README.md): fast takes every test file outside the other two, so a
// new directory is never left out; integration needs Docker; child runs real
// processes on a dist that its globalSetup rebuilds unless it holds a build of
// exactly this src (helpers/build.cjs).
const SLOW = ['integration/**', 'child/**'];

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
    setupFiles: ['./helpers/setup.ts'],
    // Not 'test', as a developer's shell may set it, so every run shows that
    // setup.ts puts it right (unit/envScrub.test.ts).
    env: { NODE_ENV: 'development' },
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 180_000,
    projects: [
      { extends: true, test: { name: 'fast', include: ['**/*.test.ts'], exclude: ['node_modules/**', ...SLOW] } },
      { extends: true, test: { name: 'integration', include: ['integration/**/*.test.ts'] } },
      { extends: true, test: { name: 'child', include: ['child/**/*.test.ts'], globalSetup: ['./helpers/childBuild.ts'] } },
    ],
  },
});
