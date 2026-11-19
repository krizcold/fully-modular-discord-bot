// NB8 test 21: a process running a whole-bot restore (restore.ts, from the compiled dist) killed at one point, then a
// new process whose main()-style recovery and step 8 finish what the kill left.
// Usage: node nb8KillRestore.cjs restore <point>
//        node nb8KillRestore.cjs check
// restore prints "AT <point>" (written synchronously) when it reaches the point and then never returns; the test kills
// it. check prints one RESULT line: the journal's stage after recovery and step 8, the live files, and the files of the
// complete pre-restore backup, if any.
const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', '..', '..', 'dist');
const utils = path.join(dist, 'bot', 'internalSetup', 'utils');
const dataDir = process.env.DATA_DIR;
const [step, point] = process.argv.slice(2);

const lock = require(path.join(utils, 'writerLock.js'));
const take = require(path.join(utils, 'backups', 'snapshotTake.js'));
const list = require(path.join(utils, 'backups', 'snapshotList.js'));
const journalOf = require(path.join(utils, 'backups', 'restoreJournal.js'));
const restore = require(path.join(dist, 'webui', 'backups', 'restore.js'));
const restoreState = require(path.join(dist, 'webui', 'backups', 'restoreState.js'));

const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const OLD = { '100/mod/a.json': '{"v":"old"}', '101/mod/b.json': '{"b":"old"}', 'global/mod/x.json': '{"x":"old"}' };
const NEW = { '100/mod/a.json': '{"v":"new"}', '102/mod/c.json': '{"c":"new"}', 'global/mod/x.json': '{"x":"new"}' };

const at = name => {
  fs.writeSync(1, `AT ${name}\n`);
  for (;;) { /* held here until the kill */ }
};

function clearLive() {
  for (const e of fs.readdirSync(dataDir)) if (e !== '_snapshots' && !e.startsWith('.')) fs.rmSync(path.join(dataDir, e), { recursive: true, force: true });
}

function writeTree(files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), text);
  }
}

function tree(root) {
  const out = {};
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (e.name === '_snapshots' || e.name.startsWith('.'))) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

/** The web UI's side of a restore without a bot process: the writer lock taken for each op, as runRestoreOp does. */
function host() {
  return {
    isRunning: () => false,
    hasUnexitedChildren: () => false,
    shutdown: async () => ({ killed: false }),
    awaitNoChildren: async () => 'gone',
    migrationRunning: () => null,
    isExiting: () => false,
    getStatus: () => ({}),
    start: async () => ({ success: true }),
    runRestoreOp: async fn => {
      const taken = lock.takeWriterLock();
      if (taken.kind !== 'taken') return { taken: false, take: taken.kind === 'held' ? { kind: 'held', holder: taken.holder } : { kind: taken.kind, errno: taken.errno } };
      try {
        return { taken: true, value: await fn() };
      } finally {
        lock.releaseWriterLock();
      }
    },
  };
}

async function runRestore() {
  writeTree(OLD);
  lock.configureWriterLock('bot');
  if (lock.takeWriterLock().kind !== 'taken') throw new Error('the writer lock was not taken');
  const taken = await take.takeSnapshot({ name: NAME, kind: 'hourly' });
  if (!taken.ok) throw new Error(`the take failed: ${JSON.stringify(taken)}`);
  lock.releaseWriterLock();
  clearLive();
  writeTree(NEW);
  lock.configureWriterLock('webui');

  const journal = path.join(dataDir, '_snapshots', 'restore.json');
  let asideRenames = 0;
  let placeRenames = 0;
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const out = realRename(from, to);
    if (String(to) === journal) {
      const stage = JSON.parse(fs.readFileSync(journal, 'utf8')).stage;
      if (point === `after-${stage}`) at(point);
    } else if (String(to).includes('.pre-restore-') && !String(from).includes('_snapshots')) {
      asideRenames += 1;
      if (point === 'in-phase-a' && asideRenames === 1) at(point);
    } else if (String(from).includes('.restore-') && !String(to).includes('_snapshots')) {
      placeRenames += 1;
      if (point === 'in-phase-b' && placeRenames === 1) at(point);
    }
    return out;
  };
  const answer = await restore.postRestore(host(), NAME);
  await restore.restoreSettled();
  fs.writeSync(1, `ENDED ${JSON.stringify(answer)}\n`);
  process.exit(3);
}

async function check() {
  lock.configureWriterLock('webui');
  const recovery = restore.beginRecovery(host());
  const end = recovery ? await recovery : null;
  // main() clears recovery's op once it ended; the first tick then runs step 8.
  restoreState.setRestoreOp(null);
  const step8 = await restore.recordReplacedData();
  const read = journalOf.readRestoreJournal();
  const j = read.state === 'read' ? read.journal : null;
  const pre = j ? (await list.listSnapshots()).find(s => s.name === j.preRestore && s.state === 'complete') : null;
  const result = {
    end,
    step8,
    stage: j && j.stage,
    live: tree(dataDir),
    old: OLD,
    new: NEW,
    pre: pre ? tree(path.join(dataDir, '_snapshots', pre.name, 'data')) : null,
    staging: j ? fs.existsSync(path.join(dataDir, '_snapshots', j.staging)) : null,
  };
  const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
  fs.writeSync(1, `RESULT ${JSON.stringify({ result, loaded })}\n`);
  process.exit(0);
}

(step === 'restore' ? runRestore() : check()).catch(error => {
  fs.writeSync(2, `${error && error.stack || error}\n`);
  process.exit(1);
});
