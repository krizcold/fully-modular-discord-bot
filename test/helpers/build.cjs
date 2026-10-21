// Builds dist the way `npm run build` does (tsc, then the copy-assets step
// written in Node so it also runs on Windows and without a shell) and stamps
// it with a hash of what it was built from (src as tsc reads it, filesUnder;
// tsconfig.json, this file, the typescript version) and of what dist then
// holds. With --if-stale it builds
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
 * The files under dir. Given `seen` (the real paths of the dirs walked), it
 * reads src as tsc does: it leaves out .git and node_modules, which tsc
 * compiles nothing from, a dir already walked and a link it cannot stat
 * (broken, a loop, denied); it follows any other link, and a dir it cannot
 * list stops the walk.
 * @param {string} dir
 * @param {Set<string>} [seen]
 * @returns {string[]}
 */
function filesUnder(dir, seen) {
  /** @type {string[]} */
  const out = [];
  if (seen) {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return out;
    seen.add(real);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (seen && (entry.name === '.git' || entry.name === 'node_modules')) continue;
    const full = path.join(dir, entry.name);
    /** @type {{ isDirectory(): boolean, isFile(): boolean }} */
    let kind = entry;
    if (seen && entry.isSymbolicLink()) {
      try {
        kind = fs.statSync(full);
      } catch {
        continue;
      }
    }
    if (kind.isDirectory()) out.push(...filesUnder(full, seen));
    else if (kind.isFile()) out.push(full);
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
function sourceFiles(root) {
  return [...filesUnder(path.join(root, 'src'), new Set()), path.join(root, 'tsconfig.json'), __filename];
}

/** @param {string} root */
function sourceHash(root) {
  return hashOf(root, sourceFiles(root), `typescript ${typescriptVersion(root)}`);
}

/**
 * The size and write time of every source file: a file rewritten while tsc
 * ran changes them even when its bytes end up the same (a stash, then a pop).
 * @param {string} root
 */
function sourceTimes(root) {
  return sourceFiles(root).map(file => {
    const stat = fs.statSync(file);
    return `${file}\0${stat.size}\0${stat.mtimeMs}`;
  }).sort().join('\n');
}

/** @param {string} root */
function distHash(root) {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return 'none';
  return hashOf(root, filesUnder(dist).filter(f => path.basename(f) !== STAMP && f !== path.join(dist, LOCK)), 'dist');
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

/**
 * Stamps dist with the source hash taken before the build, so an edit saved
 * while tsc ran leaves the stamp stale.
 * @param {string} root
 * @param {string} source
 */
function writeStamp(root, source) {
  fs.writeFileSync(path.join(root, 'dist', STAMP), `${JSON.stringify({ source, dist: distHash(root), builtAt: new Date().toISOString() })}\n`);
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

// A lock is written with its owner's process id at once: one that holds none
// for longer than this was left by a process that died taking it.
const BIRTH_MS = 10_000;

/**
 * Runs fn holding dist's build lock, a file that holds its owner's process id.
 * A live owner is waited for, up to waitMs. A lock is never taken from another
 * process: one a build left when it died stops the run and names the file to
 * remove.
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
    /** @type {number | undefined} */
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, String(process.pid));
      } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
        throw error;
      }
      fs.closeSync(fd);
      break;
    }
    let owner = '';
    let age = 0;
    try {
      owner = fs.readFileSync(lock, 'utf8').trim();
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    if (owner ? !alive(Number(owner)) : age > BIRTH_MS) {
      throw new Error(`build: ${lock} was left by a build that died (${owner ? `process ${owner} is gone` : 'it holds no process id'}); remove that file and run again`);
    }
    if (Date.now() - started > waitMs) {
      throw new Error(`build: ${lock} is held by process ${owner || '(none yet)'}, still building after ${Math.round(waitMs / 1000)} s; remove that file if no build is running`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
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
  const times = sourceTimes(root);
  const source = sourceHash(root);
  const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
  const run = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`build: tsc exited ${run.status === null ? `on ${run.signal}` : run.status}, so dist is not stamped`);
    return 1;
  }
  copyAssets(root);
  if (sourceTimes(root) !== times || sourceHash(root) !== source) {
    console.error('build: src changed while dist was built, so dist is not stamped; run again');
    return 1;
  }
  writeStamp(root, source);
  return 0;
}

/**
 * Builds dist, or with ifStale only when its stamp no longer matches. A fresh
 * dist is seen without the lock, so a run that only checks never waits on one.
 * @param {string} root
 * @param {boolean} ifStale
 * @param {number} [waitMs]
 */
function run(root, ifStale, waitMs) {
  if (ifStale && isFresh(root)) return 0;
  return withLock(root, () => (ifStale && isFresh(root) ? 0 : build(root)), waitMs);
}

module.exports = { sourceHash, distHash, isFresh, writeStamp, withLock, build, run };

if (require.main === module) {
  try {
    process.exit(run(path.resolve(__dirname, '..', '..'), process.argv.includes('--if-stale')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
