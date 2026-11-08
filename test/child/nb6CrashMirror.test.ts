import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botRoot, childEnv, FORK_GUARD, freshDataDir } from '../helpers/child';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB6 test 30 [kill] (wip-redesign/sheets/NB6.md row 19, decision 25, C15; part 8): a bot process is killed after its
// row's COMMIT was answered and before the flush's mirror write; the next boot's bootShared writes the mirror from the
// row and records it. Run on the built dist with real Postgres, started here.

const SCENARIO = path.join(botRoot, 'test', 'child', 'scenarios', 'nb6CrashMirror.cjs');
const KEY = 'global/nb6crash/doc.json';
const BODY = JSON.stringify({ v: 'stored' }, null, 2);

let container: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  container = await startPostgres();
  url = `postgres://${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

function step(mode: string, dataDir: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const env = { ...childEnv(dataDir), DATA_BACKEND: 'postgres', NB6_URL: url };
  const child = spawn(process.execPath, ['--require', FORK_GUARD, SCENARIO, mode], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} did not finish\n${stderr}`)); }, 120_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

describe('row 19: killed between the COMMIT answer and the mirror write', () => {
  it('the row holds the change, the mirror and the record do not; the next boot writes both', async () => {
    const dataDir = freshDataDir();
    const killed = await step('write', dataDir);
    expect(killed.stdout).not.toContain('RESULT ');
    expect(killed.code === 0).toBe(false);

    const pool = poolFor(container);
    try {
      const row = (await pool.query('SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', [KEY])).rows[0];
      expect(Buffer.from(row.body).toString('utf8')).toBe(BODY);
    } finally {
      await pool.end();
    }
    expect(fs.existsSync(path.join(dataDir, 'global', 'nb6crash', 'doc.json'))).toBe(false);
    const recordFile = path.join(dataDir, '.shared-mirror.json');
    const before = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : { docs: {} };
    expect(before.docs[KEY]).toBeUndefined();

    const booted = await step('boot', dataDir);
    expect(booted.code).toBe(0);
    const line = booted.stdout.split('\n').find(l => l.startsWith('RESULT '))!;
    expect(JSON.parse(line.slice('RESULT '.length)).result).toEqual({ outcome: 'done', body: BODY });
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record.docs[KEY].sha).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readdirSync(dataDir)).not.toContain('_superseded');
  }, 300_000);
});
