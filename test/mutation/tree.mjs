// A fingerprint of the files a run reads (touched.mjs): taken when the gate
// plans and again before its verdict. Each pass, and each run with no mutant
// after the reruns, copies the tree as it is when it starts, so a tree that
// changed in between (an edit, a formatter, another session) leaves the
// verdict about no one tree, and the gate has no result.
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
