// Child scenario of NB6 test 30 (row 19), run on the built dist with DATA_BACKEND=postgres and the database URL in
// NB6_URL. Mode 'write': a global save through the real facade and flush; its COMMIT is answered, and the process
// kills itself as the flush's mirror step starts its write, so the row is new and the mirror and the record are old.
// Mode 'boot': the next boot's bootShared, which prints the mirror it left as its RESULT.
const path = require('path');
const fs = require('fs');

const dist = path.resolve(__dirname, '..', '..', '..', 'dist');
const utils = path.join(dist, 'bot', 'internalSetup', 'utils');
const mode = process.argv[2];
const url = process.env.NB6_URL;

const fileBackend = require(path.join(utils, 'dataBackends', 'fileBackend.js'));
const { PostgresBackend } = require(path.join(utils, 'dataBackends', 'postgresBackend.js'));
const dm = require(path.join(utils, 'dataManager.js'));
const mirror = require(path.join(utils, 'sharedMirror.js'));
const { dataPath } = require(path.join(dist, 'utils', 'dataRoot.js'));

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
  const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
  process.stdout.write(`RESULT ${JSON.stringify({ result, loaded })}\n`);
  process.exit(0);
}

(async () => {
  await ready();
  if (mode === 'write') {
    fileBackend.atomicReplace = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => undefined); };
    dm.saveDataTracked('doc.json', { scope: 'global', category: 'nb6crash' }, { v: 'stored' });
    await dm.flushAll();
    finish('the mirror step was never reached');
    return;
  }
  const outcome = await mirror.bootShared();
  let body = null;
  try { body = fs.readFileSync(dataPath('global', 'nb6crash', 'doc.json'), 'utf8'); } catch {}
  finish({ outcome, body });
})().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
