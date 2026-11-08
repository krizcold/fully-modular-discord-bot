import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botRoot, childEnv, FORK_GUARD, freshDataDir } from '../helpers/child';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB6 test 41 [kill] (wip-redesign/sheets/NB6.md row 112, decision 35, C15; part 19): a bot process is killed between
// an update's staged copy and its COMMIT. The live folder is byte for byte as before and the database still holds the
// version in place; the pass leaves the staged folder alone for 10 minutes and deletes it after that. Run on the built
// dist with real Postgres, started here.

const SCENARIO = path.join(botRoot, 'test', 'child', 'scenarios', 'nb6CrashPublish.cjs');

let container: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  container = await startPostgres();
  url = `postgres://${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

type Step = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function step(dataDir: string, ...args: string[]): Promise<Step> {
  const env = { ...childEnv(dataDir), DATA_BACKEND: 'postgres', NB6_URL: url };
  const child = spawn(process.execPath, ['--require', FORK_GUARD, SCENARIO, ...args], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args.join(' ')} did not finish\n${stderr}`)); }, 120_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

const resultOf = (s: Step) => {
  const line = s.stdout.split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT\n${s.stdout}\n${s.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
};

/** Every file under dir with the sha of its bytes, and the folder names: the tree byte for byte. */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(path.join(at, e.name), r);
      } else {
        out[r] = createHash('sha256').update(fs.readFileSync(path.join(at, e.name))).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

describe('row 112: killed between the staging and the COMMIT', () => {
  it('the live folder and the rows are as before; the pass deletes the staged folder only after 10 minutes', async () => {
    const dataDir = freshDataDir();
    const source = path.join(dataDir, 'nb6-trees', 'appstore-modules');

    const installed = await step(dataDir, 'install', '1.0.0');
    expect(installed.code).toBe(0);
    const first = resultOf(installed);
    expect(first.applied).toBe('applied');
    const before = treeOf(path.join(source, 'm'));

    const killed = await step(dataDir, 'stage', '2.0.0');
    expect(killed.signal === 'SIGKILL' || killed.code !== 0).toBe(true);
    expect(killed.stdout).not.toContain('RESULT ');
    const stagedName = killed.stdout.split('\n').find(l => l.startsWith('STAGED '))!.slice('STAGED '.length);
    expect(stagedName).toMatch(/^\.incoming-m-\d+$/);
    expect(fs.existsSync(path.join(source, stagedName))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(source, stagedName, 'module.json'), 'utf8')).version).toBe('2.0.0');
    expect(treeOf(path.join(source, 'm'))).toEqual(before);

    const pool = poolFor(container);
    try {
      expect((await pool.query('SELECT sha FROM smdb_data.shared_modules WHERE module = $1', ['m'])).rows[0].sha).toBe(first.to);
      const doc = (await pool.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', ['global/appstore/installed.json'])).rows[0];
      expect(JSON.parse(Buffer.from(doc.body).toString('utf8')).modules.m.version).toBe('1.0.0');
    } finally {
      await pool.end();
    }

    const early = await step(dataDir, 'pass', String(9 * 60_000));
    expect(early.code).toBe(0);
    expect(resultOf(early)).toEqual({ answered: true, staged: [stagedName] });

    const late = await step(dataDir, 'pass', String(11 * 60_000));
    expect(late.code).toBe(0);
    expect(resultOf(late)).toEqual({ answered: true, staged: [] });
    expect(treeOf(path.join(source, 'm'))).toEqual(before);
  }, 300_000);
});
