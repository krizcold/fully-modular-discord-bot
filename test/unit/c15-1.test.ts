import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../smdb.sh');
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

// A fake docker: `inspect` knows no container, `ps` lists the bot's containers in
// the given order, `exec NAME test -f ...` succeeds only for the app, and the
// final `exec -i NAME ...` prints the container it reached.
function run(psOrder: string[], appNames: string[]) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-1-'));
  fs.writeFileSync(path.join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  inspect) exit 1 ;;',
    `  ps) printf '%s\\n' ${psOrder.map((n) => `'${n}'`).join(' ')} ;;`,
    '  exec)',
    '    if [ "$2" = "-i" ]; then echo "REACHED $3"; exit 0; fi',
    `    for a in ${appNames.map((n) => `'${n}'`).join(' ')}; do [ "$2" = "$a" ] && exit 0; done`,
    '    exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SMDB_CONTAINER: '', SMDB_LOCAL: '' };
  return spawnSync('bash', [script, 'bot-1', 'status'], { env, encoding: 'utf8' });
}

describe.skipIf(!hasBash)('smdb.sh resolves a bot-id to the app container', () => {
  it('reaches the app even when the auth proxy is listed first', () => {
    const r = run(['bot1-appshield', 'bot1-app'], ['bot1-app']);
    expect(r.stdout.trim()).toBe('REACHED bot1-app');
    expect(r.status).toBe(0);
  });

  it('refuses when no container of the bot carries the console', () => {
    const r = run(['bot1-appshield'], []);
    expect(r.stdout).not.toContain('REACHED');
    expect(r.status).toBe(2);
  });

  it('refuses when two containers carry the console', () => {
    const r = run(['bot1-a', 'bot1-b'], ['bot1-a', 'bot1-b']);
    expect(r.stdout).not.toContain('REACHED');
    expect(r.status).toBe(2);
  });
});
