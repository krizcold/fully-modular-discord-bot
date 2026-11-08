// Child scenario of NB6 test 41 (row 112), run on the built dist with DATA_BACKEND=postgres and the database URL in
// NB6_URL. The module trees (source, build, dist) are folders under the data dir, and the store's repository clone is
// a folder in its cache with git answered by a stub; the compile and the load are stubs, as the apply's other kill
// scenarios have them. Modes:
//   install <version>: the clone holds m at that version; the real installModule in the bot (stage, publish, apply).
//   stage <version>: the clone holds m at that version; the real updateModule stages it, and the process kills itself
//     with SIGKILL as the publish starts, before anything is sent (STAGED names the staged folder first).
//   pass <offsetMs>: the pass's module step with the clock moved on by offsetMs; RESULT the staged folders left.
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

const repo = path.resolve(__dirname, '..', '..', '..');
const dist = path.join(repo, 'dist');
// The built bot's path aliases (src/bot/index.ts registers them before anything loads): tsconfig.json's, on dist.
const tsconfigPaths = require(require.resolve('tsconfig-paths', { paths: [repo] }));
const tsconfig = tsconfigPaths.loadConfig(repo);
if (tsconfig.resultType !== 'success') throw new Error(`tsconfig.json: ${tsconfig.message}`);
tsconfigPaths.register({
  baseUrl: dist,
  paths: Object.fromEntries(Object.entries(tsconfig.paths).map(([alias, targets]) => [alias, targets.map(t => t.replace(/^src\//, ''))])),
});
const utils = path.join(dist, 'bot', 'internalSetup', 'utils');
const [mode, arg] = process.argv.slice(2);
const url = process.env.NB6_URL;

// git: the clone is a plain folder; HEAD answers a fixed commit and a pull changes nothing.
const realExecSync = childProcess.execSync;
childProcess.execSync = (cmd, opts) => {
  if (typeof cmd === 'string' && cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
  if (typeof cmd === 'string' && (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch'))) return Buffer.from('');
  return realExecSync(cmd, opts);
};

const { PostgresBackend } = require(path.join(utils, 'dataBackends', 'postgresBackend.js'));
const mainDatabase = require(path.join(utils, 'dataBackends', 'mainDatabase.js'));
const dm = require(path.join(utils, 'dataManager.js'));
const pathHelpers = require(path.join(utils, 'pathHelpers.js'));
const reloader = require(path.join(utils, 'moduleReloader.js'));
const sharedModules = require(path.join(utils, 'sharedModules.js'));
const apply = require(path.join(utils, 'moduleApply.js'));
const { getAppStoreManager } = require(path.join(utils, 'appStoreManager.js'));
const { dataPath } = require(path.join(dist, 'utils', 'dataRoot.js'));

const TAG = '1:ALPHA';
const root = dataPath('nb6-trees');
const trees = {
  source: path.join(root, 'appstore-modules'),
  build: path.join(root, 'build', 'bot', 'modules'),
  dist: path.join(root, 'dist', 'bot', 'modules'),
  backups: dataPath('global', 'appstore', 'cache', 'backups'),
  buildFile: path.join(root, 'dist', '.build-complete'),
};
for (const dir of [trees.source, trees.build, trees.dist]) fs.mkdirSync(dir, { recursive: true });
apply._setModuleDirs(trees);
pathHelpers.getSourceModulesDir = () => trees.source;
pathHelpers.getBuildModulesDir = () => trees.build;
pathHelpers.getModulesDir = () => trees.dist;
pathHelpers.getModulesDevDir = () => path.join(root, 'modulesDev');
reloader.recompileTypeScript = async () => ({ success: true, duration: 0, diagnostics: [] });
reloader.loadModuleUnmarked = async (_client, name) => ({ success: true, moduleName: name, late: false });
apply.setModuleApplyClient({});

const chooser = {
  chosen: () => url,
  awaitChoice: async () => url,
  lastPassLogin: () => 'unreachable',
  holdStarted(backend, epoch) {
    setTimeout(() => { backend.noteEntryAnswered(epoch); backend.confirmHold(epoch); }, 0);
  },
  confirmNow() {},
  stop() {},
};
const view = { chosen: url, generation: 1, machine: 'ALPHA', state: 'main', reason: null, addresses: [] };
mainDatabase.setMainChooser({ view: () => view, stop: () => undefined });

const STORE = dataPath('global', 'appstore');
const REPO = 'r41';

/** The store's repository list and its clone of m at version. */
function cloneAt(version) {
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const mod = path.join(dir, 'Modules', 'm');
  fs.mkdirSync(path.join(mod, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(mod, 'module.json'), JSON.stringify({ name: 'm', version, displayName: 'm', description: 'a crash test module', author: 'nb6', category: 'misc' }));
  fs.writeFileSync(path.join(mod, 'index.js'), `exports.v = '${version}';\n`);
  fs.writeFileSync(path.join(mod, 'lib', `only-${version}.bin`), Buffer.from([0, 255, 1, 254]));
}

async function ready() {
  const backend = new PostgresBackend({ chooser });
  backend.start();
  const until = Date.now() + 60000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  if (backend.connectionState().state !== 'ready') throw new Error('the backend did not become ready');
  dm.setGuildDataBackend(backend);
  return backend;
}

function finish(result) {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
}

const stagedNow = () => fs.readdirSync(trees.source).filter(n => n.startsWith('.incoming-'));

(async () => {
  await ready();
  if (mode === 'install') {
    cloneAt(arg);
    const answer = await getAppStoreManager().installModule('m', REPO);
    finish({ to: answer.to, applied: answer.applied && answer.applied.outcome });
    return;
  }
  if (mode === 'stage') {
    cloneAt(arg);
    sharedModules.publishModule = async (_name, dir) => {
      process.stdout.write(`STAGED ${path.basename(dir)}\n`);
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => undefined);
    };
    await getAppStoreManager().updateModule('m');
    finish('the publish was never reached');
    return;
  }
  if (mode === 'pass') {
    const realNow = Date.now;
    const offset = Number(arg);
    Date.now = () => realNow() + offset;
    const answered = await apply.modulePassStep({ tag0: TAG });
    finish({ answered, staged: stagedNow() });
    return;
  }
  throw new Error(`unknown mode ${mode}`);
})().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
