import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// The child tier's globalSetup: its scenarios run the compiled dist, so build
// it first unless it was built from exactly this src (build.cjs --if-stale).
export default function setup(): void {
  const build = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.cjs');
  const run = spawnSync(process.execPath, [build, '--if-stale'], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`the child tier needs a dist built from this src, and build.cjs exited ${run.status ?? run.signal}`);
}
