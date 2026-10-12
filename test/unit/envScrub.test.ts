import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { childEnv } from '../helpers/child';
import { DEAD_ENDS, kept, scrubEnv } from '../helpers/env';

// The env scrub (helpers/env.ts): tests and the children they start keep only
// the platform's, the test tools' and the suite's own variables, so whatever a
// developer's shell sets, by any name, reaches no run; pg and git are pointed
// at nothing.

const src = path.join(__dirname, '..', '..', 'src');
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : /\.(ts|js|cjs|mjs)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);

describe('the env scrub', () => {
  const texts = filesUnder(src).map(file => fs.readFileSync(file, 'utf8'));
  const found = (pattern: RegExp) => [...new Set(texts.flatMap(text => [...text.matchAll(pattern)].map(m => m[1] ?? m[2])))].sort();

  it('takes out every key src reads from process.env, but the platform ones it reads on purpose', () => {
    const keys = found(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter(kept)).toEqual([]);
  });

  it('takes out every uppercase prefix src checks keys against', () => {
    const prefixes = found(/startsWith\(\s*['"]([A-Z][A-Z0-9]*_)['"]\s*\)/g);
    expect(prefixes).toEqual(expect.arrayContaining(['PATREON_', 'PAYPAL_', 'STRIPE_']));
    expect(prefixes.filter(prefix => kept(`${prefix}ANY`))).toEqual([]);
  });

  it('runs tests with NODE_ENV test, whatever the shell set', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('keeps only the platform\'s, the test tools\' and the suite\'s own keys, the active mutant included', () => {
    const passing = {
      Path: 'p', SystemRoot: 'r', TEMP: 't', USERPROFILE: 'u', HOME: 'h', TMPDIR: 'd', LC_ALL: 'C', VITEST_POOL_ID: '1',
      __STRYKER_ACTIVE_MUTANT__: '7', SMDB_TEST_TIME_SCALE: '4', SMDB_TEST_SEED: '5', DOCKER_HOST: 'npipe:', TESTCONTAINERS_RYUK_DISABLED: 'true',
    };
    const env = scrubEnv({
      ...passing,
      // the bot's own keys, by name and by prefix, and a module's config key read through configManager
      DISCORD_TOKEN: 't', STRIPE_SECRET_KEY: 's', SESSION_SECRET: 'x', FLEET_CONFIRM_TAKEOVER: '1', DATA_BACKEND_URL: 'u', DEVS: '1', apiKey: 'k',
      // what dependencies read: pg, dotenv, git, node
      DATABASE_URL: 'postgres://real', PGHOST: 'db.example', PGPASSWORD: 'p', PGSSLMODE: 'require', DOTENV_CONFIG_PATH: '/srv/bot/.env',
      GIT_DIR: '/srv/repo/.git', GIT_CONFIG_PARAMETERS: "'diff.algorithm'='histogram'", NODE_OPTIONS: '--require /x.js', npm_config_cache: 'c',
    });
    expect(env).toEqual(passing);
  });

  it('points pg and git at nothing in every test', () => {
    expect(Object.keys(DEAD_ENDS).sort()).toEqual(['GIT_CEILING_DIRECTORIES', 'PGHOST', 'PGPASSFILE']);
    for (const [key, value] of Object.entries(DEAD_ENDS)) expect(process.env[key], key).toBe(value);
    expect(fs.existsSync(DEAD_ENDS.PGHOST)).toBe(false);
    expect(fs.existsSync(DEAD_ENDS.PGPASSFILE)).toBe(false);
    expect(DEAD_ENDS.GIT_CEILING_DIRECTORIES).toBe([path.resolve(__dirname, '..', '..', '..'), os.tmpdir()].join(path.delimiter));
  });

  it('gives a child scenario the same, with pg and git pointed at nothing whatever the test set', () => {
    onTestFinished(() => { vi.unstubAllEnvs(); });
    vi.stubEnv('DISCORD_TOKEN', 'real');
    vi.stubEnv('PGHOST', 'db.example');
    const env = childEnv('/data');
    expect(env).toMatchObject({ ...DEAD_ENDS, NODE_ENV: 'test', DATA_DIR: '/data' });
    expect(env.DISCORD_TOKEN).toBeUndefined();
  });

  // A Stryker sandbox sits inside the checkout and holds no .git, and a test's
  // data dir or a child's cwd sits under the temp dir: a mutant's git call must
  // find no repository from either, never the checkout's or one holding the temp dir.
  it('stops git at the dir that holds the bot root, and at the temp dir', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-ceiling-'));
    onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', repo]);
    const sandbox = path.join(repo, '.stryker-tmp', 'sandbox-1');
    const temp = path.join(repo, 'Temp');
    fs.mkdirSync(path.join(sandbox, 'test'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'smdb-test-1', 'cache'), { recursive: true });
    const run = (cwd: string, ceiling: string) => {
      try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: ceiling }, encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch (error) {
        return String((error as { stderr?: string }).stderr);
      }
    };
    expect(fs.realpathSync(run(path.join(sandbox, 'test'), ''))).toBe(fs.realpathSync(repo));
    const ceiling = [path.dirname(sandbox), temp].join(path.delimiter);
    expect(run(path.join(sandbox, 'test'), ceiling)).toMatch(/not a git repository/);
    expect(run(path.join(temp, 'smdb-test-1', 'cache'), ceiling)).toMatch(/not a git repository/);
  });

  // Every test file of every mutant run makes one: left behind, they pile up in the temp dir.
  it("removes a test file's data root after the file's own afterAll hooks, unless SMDB_KEEP_TEST_FILES keeps it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-dataroot-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'root.txt');
    fs.writeFileSync(path.join(dir, 'root.test.mjs'), [
      "import fs from 'fs';",
      "import path from 'path';",
      "afterAll(() => { fs.writeFileSync(path.join(process.env.DATA_DIR, 'late.txt'), 'x'); });",
      "it('writes', () => {",
      "  fs.mkdirSync(path.join(process.env.DATA_DIR, 'guild'));",
      "  fs.writeFileSync(path.join(process.env.DATA_DIR, 'guild', 'a.json'), '{}');",
      '  fs.writeFileSync(process.env.SMDB_PROBE_OUT, process.env.DATA_DIR);',
      '});',
    ].join('\n'));
    const vitest = path.join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
    const setup = path.join(__dirname, '..', 'helpers', 'setup.ts');
    fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default { test: { setupFiles: [${JSON.stringify(setup)}] } };\n`);
    const run = (keep: boolean) => {
      const env: NodeJS.ProcessEnv = { ...process.env, SMDB_PROBE_OUT: out };
      delete env.SMDB_KEEP_TEST_FILES;
      if (keep) env.SMDB_KEEP_TEST_FILES = '1';
      const result = spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--globals'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const root = fs.readFileSync(out, 'utf8');
      expect(path.basename(root)).toMatch(/^smdb-test-/);
      return root;
    };
    expect(fs.existsSync(run(false))).toBe(false);
    const left = run(true);
    onTestFinished(() => fs.rmSync(left, { recursive: true, force: true }));
    expect(fs.readFileSync(path.join(left, 'late.txt'), 'utf8')).toBe('x');
  });
});
