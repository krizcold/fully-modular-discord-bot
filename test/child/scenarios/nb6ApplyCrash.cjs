// Child scenario of NB6 tests 45 and 57, run on the built dist with DATA_BACKEND=postgres and the database URL in
// NB6_URL. The module trees (source, build, dist) are folders under the data dir; tsc is a copy of each module's build
// folder into its dist folder (what it emits, errors or not), and the loader reads the dist folder's manifests.
// Modes:
//   publish <module> <version>: publishes that version; place <module> <version>: publishes it and applies it live.
//   setup <module>: publishes version 1.0.0 and applies it live, then publishes 2.0.0 and stages it; RESULT the shas.
//   kill <module> <point> <to> <staged>: applies <to> from <staged> and kills itself with SIGKILL at <point>: 'intent'
//     (after the intent, before the first rename), 'backup' (after the live folder went to its backup, before the
//     staged folder's rename), 'copy' (during the copy into build), 'compile', 'load'.
//   boot: runBot's boot steps (the recovery, bootShared, the boot compile, the boot loop with its load check, the
//     initializer turns); RESULT each module's entry, the sha of its live folder, its build and dist files, and the
//     loaded modules. NB6_TURNS=0 skips the turns, as a clientReady handler that returned early.
//   guard <module>: the version in place, as `boot`, with the real guardUncaught installed and NB6_THROW set: the
//     module's code throws uncaught at the point it names (onLoad, onReady, initializer, late) so the process ends
//     through guardUncaught, as BotManager sees a crash.
//   live <module> <version>: as `guard` for the version in place, then publishes <version> (LIVE its sha) and applies
//     it through the bot's module:apply IPC handler with the real load (ANSWER the handler's answer); NB6_THROW names
//     what the published version's code throws.
const path = require('path');
const fs = require('fs');

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
const [mode, ...args] = process.argv.slice(2);
const url = process.env.NB6_URL;

const { PostgresBackend } = require(path.join(utils, 'dataBackends', 'postgresBackend.js'));
const mainDatabase = require(path.join(utils, 'dataBackends', 'mainDatabase.js'));
const dm = require(path.join(utils, 'dataManager.js'));
const mirror = require(path.join(utils, 'sharedMirror.js'));
const apply = require(path.join(utils, 'moduleApply.js'));
const reloader = require(path.join(utils, 'moduleReloader.js'));
const pathHelpers = require(path.join(utils, 'pathHelpers.js'));
const sharedModules = require(path.join(utils, 'sharedModules.js'));
const records = require(path.join(utils, 'sharedRecords.js'));
const crashes = require(path.join(utils, 'moduleCrashes.js'));
const maintenance = require(path.join(utils, 'maintenance.js'));
const { getModuleRegistry } = require(path.join(utils, 'moduleRegistry.js'));
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

function kill() {
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => undefined);
}

// tsc: every module's build folder emitted into its dist folder.
reloader.recompileTypeScript = async () => {
  if (process.env.NB6_KILL_AT === 'compile') await kill();
  for (const e of fs.readdirSync(trees.build, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    fs.rmSync(path.join(trees.dist, e.name), { recursive: true, force: true });
    fs.cpSync(path.join(trees.build, e.name), path.join(trees.dist, e.name), { recursive: true });
  }
  return { success: true, duration: 0, diagnostics: [] };
};
pathHelpers.findModuleManifests = () => fs.readdirSync(trees.dist, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => path.join(trees.dist, e.name, 'module.json'))
  .filter(p => fs.existsSync(p));

const manifest = (name, version) => JSON.stringify({ name, version, displayName: name, description: 'a crash test module', author: 'nb6', category: 'misc' });
function moduleFiles(name, version) {
  const files = { 'module.json': manifest(name, version), [`only-${version}.js`]: `exports.v = '${version}';\n` };
  const thrown = process.env.NB6_THROW;
  const at = process.env.NB6_THROW_VERSION || '2.0.0';
  const only = process.env.NB6_THROW_MODULE;
  if (thrown && version === at && (!only || only === name)) {
    const raise = "setTimeout(() => { throw new Error('the module stopped the bot'); }, 0)";
    if (thrown === 'onLoad' || thrown === 'onReady') files['hooks.js'] = `exports.${thrown} = async () => { ${raise}; await new Promise(r => setTimeout(r, 50)); };\n`;
    if (thrown === 'initializer') {
      files['commands/boom.js'] = `module.exports = { name: 'boom', description: 'b', initialize: () => new Promise(() => { ${raise}; }) };\n`;
    }
    if (thrown === 'late') {
      files['commands/boom.js'] = `module.exports = { name: 'boom', description: 'b', initialize: () => new Promise(() => { setTimeout(() => { throw new Error('the module stopped the bot'); }, 61000); }) };\n`;
    }
  }
  return files;
}

function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (at, rel) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(at, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
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

async function installedBody(backend) {
  const res = await backend.sharedSelect('SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', ['global/appstore/installed.json'], 10000);
  const row = res.rows[0];
  return row ? { body: JSON.parse(Buffer.from(row.body).toString('utf8')), base: row.sha } : { body: { modules: {} }, base: 'absent' };
}

async function publish(backend, name, version) {
  const dir = writeTree(path.join(root, `stage-${version}-${Date.now()}`, name), moduleFiles(name, version));
  const { body, base } = await installedBody(backend);
  body.modules[name] = { version };
  const answer = await sharedModules.publishModule(name, dir, JSON.stringify(body), base, { operation: base === 'absent' || !body.modules[name] ? 'install' : 'update', version });
  if (answer.kind !== 'committed') throw new Error(`publish ${name}: ${JSON.stringify(answer)}`);
  return { sha: answer.sha, dir };
}

function finish(result) {
  process.stdout.write(`RESULT ${JSON.stringify({ result })}\n`);
  process.exit(0);
}

const client = { options: { intents: 0 }, on: () => undefined };

// runBot's order (clientInitializer.ts): the recovery and the boot's swaps, bootShared, the boot compile, loadModules with
// its load check, the components, and the clientReady handler's turns unless NB6_TURNS is 0.
async function boot() {
  const ci = require(path.join(dist, 'bot', 'internalSetup', 'clientInitializer.js'));
  apply.recoverModuleApplies();
  apply.beginBootApplies();
  const shared = await mirror.bootShared();
  if (shared !== 'done') throw new Error(`bootShared answered ${shared}`);
  await apply.bootCompileModules();
  await ci.loadModules(client);
  ci.registerModuleComponents(client);
  apply.setModuleApplyClient(client);
  if (process.env.NB6_TURNS !== '0') await ci.runInitializers(client);
  return getModuleRegistry().getAllModules().map(m => m.manifest.name).sort();
}

// Each module's row in shared_module_status (decision 83: an answered upsert clears the entry's `status`).
async function report(backend, names, loaded) {
  const rows = await backend.sharedSelect('SELECT module, sha, state, error FROM smdb_data.shared_module_status WHERE module = ANY($1::text[])', [names], 10000);
  const read = records.readStoreRecord();
  const out = {};
  for (const name of names) {
    out[name] = {
      entry: read.ok ? read.record.modules[name] ?? null : null,
      live: apply.folderSha(path.join(trees.source, name)),
      build: listFiles(path.join(trees.build, name)),
      dist: listFiles(path.join(trees.dist, name)),
      statusRows: rows.rows.filter(r => r.module === name).map(({ sha, state, error }) => ({ sha, state, error })),
    };
  }
  let lines = {};
  try { lines = JSON.parse(fs.readFileSync(dataPath('global', 'appstore', 'cache', 'module-crashes.json'), 'utf8')); } catch {}
  return { modules: out, loaded, lines };
}

(async () => {
  const backend = await ready();
  if (mode === 'setup') {
    const name = args[0];
    const s = await publish(backend, name, '1.0.0');
    apply.setModuleApplyClient(client);
    reloader.loadModuleUnmarked = async () => ({ success: true, moduleName: name, late: false });
    const first = await apply.applyModuleChange({ module: name, to: s.sha, source: s.dir, displaced: 'backups', reason: 'install', tag: TAG, version: '1.0.0' });
    if (first.outcome !== 'applied') throw new Error(`apply 1.0.0: ${JSON.stringify(first)}`);
    const u = await publish(backend, name, '2.0.0');
    finish({ s: s.sha, u: u.sha, staged: u.dir });
    return;
  }
  if (mode === 'publish' || mode === 'place') {
    const [name, version] = args;
    const row = await publish(backend, name, version);
    if (mode === 'place') {
      apply.setModuleApplyClient(client);
      reloader.loadModuleUnmarked = async () => ({ success: true, moduleName: name, late: false });
      const placed = await apply.applyModuleChange({ module: name, to: row.sha, source: row.dir, displaced: 'backups', reason: 'install', tag: TAG, version });
      if (placed.outcome !== 'applied') throw new Error('apply ' + version + ': ' + JSON.stringify(placed));
    }
    finish({ sha: row.sha });
    return;
  }
  if (mode === 'kill') {
    const [name, point, to, staged] = args;
    const live = path.join(trees.source, name);
    const realRename = fs.renameSync;
    fs.renameSync = (from, dest) => {
      if (point === 'intent' && path.resolve(String(from)) === path.resolve(live)) process.kill(process.pid, 'SIGKILL');
      if (point === 'backup' && path.resolve(String(from)) === path.resolve(staged)) process.kill(process.pid, 'SIGKILL');
      return realRename(from, dest);
    };
    const realCp = fs.cpSync;
    fs.cpSync = (from, dest, opts) => {
      if (point === 'copy' && path.resolve(String(dest)).startsWith(path.resolve(trees.build))) process.kill(process.pid, 'SIGKILL');
      return realCp(from, dest, opts);
    };
    process.env.NB6_KILL_AT = point;
    apply.setModuleApplyClient(client);
    reloader.loadModuleUnmarked = async () => kill();
    await apply.applyModuleChange({ module: name, to, source: staged, displaced: 'backups', reason: 'update', tag: TAG, version: '2.0.0' });
    finish('the kill point was never reached');
    return;
  }
  if (mode === 'boot') {
    const loaded = await boot();
    finish(await report(backend, args, loaded));
    return;
  }
  if (mode === 'guard') {
    process.on('uncaughtException', maintenance.guardUncaught);
    process.on('unhandledRejection', maintenance.guardRejection);
    const loaded = await boot();
    // A late throw needs the process to live past the module's 60 s turn.
    if (process.env.NB6_THROW === 'late') await new Promise(r => setTimeout(r, 70000));
    finish(await report(backend, args, loaded));
    return;
  }
  if (mode === 'live') {
    const [name, version] = args;
    process.on('uncaughtException', maintenance.guardUncaught);
    process.on('unhandledRejection', maintenance.guardRejection);
    await boot();
    const row = await publish(backend, name, version);
    process.stdout.write(`LIVE ${JSON.stringify({ sha: row.sha })}\n`);
    const answers = [];
    process.send = message => { answers.push(message); return true; };
    require(path.join(utils, 'ipcReloadHandler.js')).setupReloadIPCHandlers(client);
    process.emit('message', { type: 'module:apply', requestId: 'nb6-live', data: { module: name, to: row.sha, staged: row.dir, tag: TAG, version, reason: 'update' } });
    const until = Date.now() + 120000;
    while (answers.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    const answer = answers.length > 0 ? answers[0].data : null;
    process.stdout.write(`ANSWER ${JSON.stringify(answer)}\n`);
    if (process.env.NB6_THROW === 'late') await new Promise(r => setTimeout(r, 70000));
    finish({ sha: row.sha, answer });
    return;
  }
  throw new Error(`unknown mode ${mode}`);
})().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
