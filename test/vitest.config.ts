import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const src = path.join(repo, 'src');

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
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    setupFiles: ['./helpers/setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
