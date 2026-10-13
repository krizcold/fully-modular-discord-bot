// A process started with an env of its own that lacks DATA_DIR resolves its
// data root to /data (src/utils/dataRoot.ts), on a developer's machine a real
// one. src forks the bot so (webui/botManager.ts), and a mutant that empties
// such an env must fail, never run: in a test (helpers/setup.ts loads this
// file) and in a child scenario (helpers/child.ts preloads it), every way
// child_process starts a process (fork, spawn, exec, execFile and their sync
// forms, a promisified exec or execFile included) and a worker_threads Worker
// given such an env throws.
const childProcess = require('child_process');
const workerThreads = require('worker_threads');
const { syncBuiltinESMExports } = require('module');
const { promisify } = require('util');

/**
 * @param {string} what
 * @param {unknown[]} args the arguments after the command
 */
function check(what, args) {
  const options = args.find(arg => arg !== null && typeof arg === 'object' && !Array.isArray(arg));
  if (options && options.env && typeof options.env === 'object' && !options.env.DATA_DIR) {
    throw new Error(`a ${what} with an env of its own that lacks DATA_DIR would take /data as its data root (test/helpers/forkGuard.cjs)`);
  }
}

for (const name of ['fork', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  const guarded = function (command, ...rest) {
    check(`${name} of ${command}`, rest);
    return original.call(this, command, ...rest);
  };
  // exec and execFile promisify to { stdout, stderr } through a form of their own.
  const custom = original[promisify.custom];
  if (custom) {
    guarded[promisify.custom] = function (command, ...rest) {
      check(`${name} of ${command}`, rest);
      return custom.call(this, command, ...rest);
    };
  }
  childProcess[name] = guarded;
}

const { Worker } = workerThreads;
workerThreads.Worker = class GuardedWorker extends Worker {
  constructor(file, options) {
    check(`Worker of ${file}`, [options]);
    super(file, options);
  }
};
// An ES module's `import { fork } from 'child_process'` sees it too.
syncBuiltinESMExports();
