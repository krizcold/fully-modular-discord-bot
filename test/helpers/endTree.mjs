// Ends a process and the processes it started: a child scenario step past its
// bound (child.ts).
import { execFileSync, spawnSync } from 'child_process';

/**
 * Ends a process and every process it started that still descends from it,
 * found by their parents while the tree stands (taskkill walks the same links
 * on Windows). One whose parent already exited is not found, and where ps is
 * missing none is.
 * @param {number} pid
 */
export function endTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const tree = [pid];
    for (let i = 0; i < tree.length; i++) for (const [child, parent] of rows) if (parent === tree[i]) tree.push(child);
    for (const each of tree) {
      try { process.kill(each, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* no ps: the caller's own kill */ }
}
