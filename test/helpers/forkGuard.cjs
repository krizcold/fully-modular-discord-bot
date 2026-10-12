// A process forked with an env of its own that lacks DATA_DIR resolves its
// data root to /data (src/utils/dataRoot.ts), on a developer's machine a real
// one. src forks the bot so (webui/botManager.ts), and a mutant that empties
// that env must fail, never run: in a test (helpers/setup.ts loads this file)
// and in a child scenario (helpers/child.ts preloads it), such a fork throws.
const childProcess = require('child_process');
const { syncBuiltinESMExports } = require('module');

const fork = childProcess.fork;
childProcess.fork = function guardedFork(modulePath, ...rest) {
  const options = rest.find(arg => arg !== null && typeof arg === 'object' && !Array.isArray(arg));
  if (options && options.env && !options.env.DATA_DIR) {
    throw new Error(`a fork of ${modulePath} with an env of its own that lacks DATA_DIR would take /data as its data root (test/helpers/forkGuard.cjs)`);
  }
  return fork.call(this, modulePath, ...rest);
};
// An ES module's `import { fork } from 'child_process'` sees it too.
syncBuiltinESMExports();
