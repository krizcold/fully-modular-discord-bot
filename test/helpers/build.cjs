// Builds dist/ the way `npm run build` does (tsc, then the copy-assets step
// written in Node so it also runs on Windows and without a shell) and stamps it
// with a hash of what it was built from. With --if-stale it builds only when
// that hash changed. The child tier's globalSetup calls it with --if-stale; a
// Stryker pass B calls it as its buildCommand, before the sandbox has its own
// node_modules, so typescript resolves upward from the root.
// Usage: node test/helpers/build.cjs [--if-stale]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const stampFile = path.join(dist, '.smdb-build.json');

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sourceHash() {
  const hash = crypto.createHash('sha256');
  const inputs = [...filesUnder(src), path.join(root, 'tsconfig.json'), __filename];
  for (const file of inputs.map(f => path.relative(root, f).split(path.sep).join('/')).sort()) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function stampedHash() {
  try { return JSON.parse(fs.readFileSync(stampFile, 'utf8')).source; } catch { return null; }
}

function copyAssets() {
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

const source = sourceHash();
if (process.argv.includes('--if-stale') && stampedHash() === source) process.exit(0);

fs.rmSync(stampFile, { force: true });
const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
const run = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
if (run.status !== 0) {
  console.error(`build: tsc exited ${run.status === null ? `on ${run.signal}` : run.status}, so dist is not stamped`);
  process.exit(1);
}
copyAssets();
fs.writeFileSync(stampFile, `${JSON.stringify({ source, builtAt: new Date().toISOString() })}\n`);
