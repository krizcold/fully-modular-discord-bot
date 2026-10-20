// A fingerprint of the files a run reads (touched.mjs): taken when the gate
// plans and again before its verdict. Each pass, and each run with no mutant
// after the reruns, copies the tree as it is when it starts, so a tree that
// changed in between (an edit, a formatter, another session) leaves the
// verdict about no one tree, and the gate has no result. The packages are
// linked into each sandbox, not copied, so each run loads them as they are
// then; the print holds npm's own record of each linked dir (linkedLockfiles).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * @param {string} root
 * @param {string[]} files from the root
 * @returns {Map<string, string>}
 */
export function treePrint(root, files) {
  return new Map(files.map(file => [file, stampOf(path.join(root, file))]));
}

/**
 * npm's hidden lockfile in each node_modules dir Stryker links into every
 * sandbox, found as Stryker finds them (core's findNodeModulesList): every
 * node_modules under the root, not under .stryker-tmp and not inside another,
 * links not followed. npm rewrites the file when an install changes the dir,
 * and npm ci removes it first.
 * @param {string} root
 * @returns {string[]} from the root
 */
export function linkedLockfiles(root) {
  /** @type {string[]} */
  const found = [];
  const queue = ['.'];
  let dir;
  while ((dir = queue.pop()) !== undefined) {
    const name = path.posix.basename(dir);
    if (name === '.stryker-tmp') continue;
    if (name === 'node_modules') {
      found.push(path.posix.join(dir, '.package-lock.json'));
      continue;
    }
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) if (entry.isDirectory()) queue.push(path.posix.join(dir, entry.name));
  }
  return found.sort();
}

/** @param {string} full */
function stampOf(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return 'not a file';
    return `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

/**
 * The files whose stamp differs between two prints, or that only one holds.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
export const treeChanges = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort();
