// The rollback route and rollback.js write /app/custom, /app/build and /app/dist, absolute paths of the image. A
// test points them at a folder of its data root: `useAppRoot(root)` in the test's own process, or this file preloaded
// (node -r) into a child with SMDB_TEST_APP_ROOT set. Only paths under /app move; every other path is untouched.
const fs = require('fs');
const path = require('path');

const SYNC = ['existsSync', 'mkdirSync', 'readdirSync', 'rmSync', 'lstatSync', 'statSync', 'unlinkSync', 'readFileSync', 'writeFileSync'];
const ASYNC = ['mkdir', 'readdir', 'rm', 'lstat', 'stat', 'unlink', 'readFile', 'writeFile'];

function mapper(root) {
  return p => {
    if (typeof p !== 'string') return p;
    const s = p.replace(/\\/g, '/');
    if (s !== '/app' && !s.startsWith('/app/')) return p;
    return path.join(root, s.slice('/app'.length));
  };
}

/** Moves every fs path under /app into `root`; answers the function that puts fs back. */
function useAppRoot(root) {
  const map = mapper(root);
  const saved = [];
  const patch = (owner, name, args) => {
    const original = owner[name];
    saved.push([owner, name, original]);
    owner[name] = function (...a) {
      for (let i = 0; i < args; i++) a[i] = map(a[i]);
      return original.apply(this, a);
    };
  };
  for (const name of SYNC) patch(fs, name, 1);
  patch(fs, 'copyFileSync', 2);
  for (const name of ASYNC) patch(fs.promises, name, 1);
  patch(fs.promises, 'cp', 2);
  return () => {
    for (const [owner, name, original] of saved.reverse()) owner[name] = original;
  };
}

if (process.env.SMDB_TEST_APP_ROOT) useAppRoot(process.env.SMDB_TEST_APP_ROOT);

module.exports = { useAppRoot };
