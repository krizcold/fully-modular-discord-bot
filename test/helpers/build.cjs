// Builds dist the way `npm run build` does (tsc, then the copy-assets step
// written in Node so it also runs on Windows and without a shell) and stamps
// it with a hash of what it was built from (src, tsconfig.json, this file, the
// typescript version) and of what dist then holds. With --if-stale it builds
// only when either hash no longer matches, so a dist that another build, a
// branch switch or a hand edit changed is rebuilt. A lock in dist keeps two
// runs in one checkout from building over each other. The child tier's
// globalSetup calls it with --if-stale; a Stryker pass B calls it as its
// buildCommand, before the sandbox has its own node_modules, so typescript
// resolves upward from the root.
// Usage: node test/helpers/build.cjs [--if-stale]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STAMP = '.smdb-build.json';
const LOCK = '.build-lock';

/**
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * @param {string} root
 * @param {string[]} files
 * @param {string} extra
 */
function hashOf(root, files, extra) {
  const hash = crypto.createHash('sha256').update(`${extra}\0`);
  for (const file of files.map(f => path.relative(root, f).split(path.sep).join('/')).sort()) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** @param {string} root */
function typescriptVersion(root) {
  try {
    return String(JSON.parse(fs.readFileSync(require.resolve('typescript/package.json', { paths: [root] }), 'utf8')).version);
  } catch {
    return 'none';
  }
}

/** @param {string} root */
function sourceHash(root) {
  return hashOf(root, [...filesUnder(path.join(root, 'src')), path.join(root, 'tsconfig.json'), __filename], `typescript ${typescriptVersion(root)}`);
}

/** @param {string} root */
function distHash(root) {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return 'none';
  const lock = path.join(dist, LOCK) + path.sep;
  return hashOf(root, filesUnder(dist).filter(f => path.basename(f) !== STAMP && !f.startsWith(lock)), 'dist');
}

/** @param {string} root */
function isFresh(root) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, 'dist', STAMP), 'utf8'));
    return stamp.source === sourceHash(root) && stamp.dist === distHash(root);
  } catch {
    return false;
  }
}

/** @param {string} root */
function writeStamp(root) {
  fs.writeFileSync(path.join(root, 'dist', STAMP), `${JSON.stringify({ source: sourceHash(root), dist: distHash(root), builtAt: new Date().toISOString() })}\n`);
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Runs fn holding dist's build lock. A lock whose owner process is gone is
 * taken over; a live one is waited for, up to waitMs.
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @param {number} [waitMs]
 * @returns {T}
 */
function withLock(root, fn, waitMs = 10 * 60_000) {
  const lock = path.join(root, 'dist', LOCK);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      let owner = NaN;
      try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch { /* being written */ }
      if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > waitMs) throw new Error(`build: dist is locked by process ${owner} (${lock}); remove the lock if that process is gone`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** @param {string} root */
function copyAssets(root) {
  const src = path.join(root, 'src');
  const dist = path.join(root, 'dist');
  fs.cpSync(path.join(src, 'webui', 'public'), path.join(dist, 'webui', 'public'), { recursive: true });
  const modules = path.join(src, 'bot', 'modules');
  for (const file of filesUnder(modules)) {
    const name = path.basename(file);
    if (name !== 'module.json' && name !== 'settingsSchema.json') continue;
    const target = path.join(dist, 'bot', 'modules', path.relative(modules, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
}

/** @param {string} root */
function build(root) {
  fs.rmSync(path.join(root, 'dist', STAMP), { force: true });
  const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
  const run = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`build: tsc exited ${run.status === null ? `on ${run.signal}` : run.status}, so dist is not stamped`);
    return 1;
  }
  copyAssets(root);
  writeStamp(root);
  return 0;
}

module.exports = { sourceHash, distHash, isFresh, writeStamp, withLock };

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const ifStale = process.argv.includes('--if-stale');
  process.exit(withLock(root, () => (ifStale && isFresh(root) ? 0 : build(root))));
}
