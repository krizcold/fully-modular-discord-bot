// NB8 test 20: a real bot process taking a snapshot of a busy data folder, killed at one point of the take, then a
// new process that checks what the kill left. Runs the compiled dist. At final-op the process is the web UI's instead,
// running the local take, killed inside the final op it queues (T6.x).
// Usage: node nb8KillTake.cjs take <pass1 | round | after-turn | before-rename | final-op>
//        node nb8KillTake.cjs check
// take prints "AT <point>" (written synchronously) when it reaches the point and then never returns; the test kills it.
// check prints one RESULT line: whether every live file parses, whether every complete snapshot matches its manifest,
// the work folders before and after a new take, and that take's answer.
const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', '..', '..', 'dist');
const utils = path.join(dist, 'bot', 'internalSetup', 'utils');
const dataDir = process.env.DATA_DIR;
const [step, point] = process.argv.slice(2);

const lock = require(path.join(utils, 'writerLock.js'));
const take = require(path.join(utils, 'backups', 'snapshotTake.js'));
const fileBackend = require(path.join(utils, 'dataBackends', 'fileBackend.js'));
const list = require(path.join(utils, 'backups', 'snapshotList.js'));
const verify = require(path.join(utils, 'backups', 'snapshotVerify.js'));

const at = name => {
  fs.writeSync(1, `AT ${name}\n`);
  for (;;) { /* held here until the kill */ }
};

function liveFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '_snapshots' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) liveFiles(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function fixture() {
  for (let g = 0; g < 3; g++) {
    for (let f = 0; f < 20; f++) {
      const p = path.join(dataDir, `10${g}`, 'mod', `f${f}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ n: 0, pad: 'x'.repeat(2000) }));
    }
  }
}

async function runTake() {
  fixture();
  const local = point === 'final-op';
  lock.configureWriterLock(local ? 'webui' : 'bot');
  if (lock.takeWriterLock().kind !== 'taken') throw new Error('the writer lock was not taken');
  let n = 0;
  const writer = setInterval(() => {
    n += 1;
    fileBackend.enqueueWrite(path.join(dataDir, '100', 'mod', `f${n % 20}.json`), JSON.stringify({ n, pad: 'y'.repeat(2000) }));
  }, 2);
  writer.unref();
  const realOpen = fs.promises.open.bind(fs.promises);
  let copies = 0;
  let turned = false;
  let inRound = false;
  let inFinal = false;
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    const out = realReadFileSync(p, ...rest);
    if (inRound && path.basename(String(p)) === '.writer.lock') turned = true;
    return out;
  };
  fs.promises.open = async (p, flags, ...rest) => {
    const inSnapshots = String(p).includes(`${path.sep}_snapshots${path.sep}`);
    if (point === 'pass1' && !inSnapshots && flags === 'r' && String(p).endsWith('.json') && ++copies === 30) at('pass1');
    if (point === 'after-turn' && inSnapshots && flags === 'wx' && turned) at('after-turn');
    if (point === 'final-op' && inFinal) at('final-op');
    return realOpen(p, flags, ...rest);
  };
  take._setTakeTimingForTests({
    beforeTurn: () => {
      if (point === 'round') at('round');
      inRound = true;
      setImmediate(() => { inRound = false; });
    },
  });
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (point === 'before-rename' && path.basename(String(from)).startsWith('.taking-')) at('before-rename');
    return realRename(from, to);
  };
  // The web UI's side with no bot process: every shared write goes local, and the final op runs in this process. A
  // final walk that finds nothing to copy is killed once it ends, still inside the op.
  const host = {
    routeProbe: () => ({ route: 'local' }),
    isExiting: () => false,
    queueFinalOp: async fn => {
      inFinal = true;
      try {
        const value = await fn();
        at('final-op');
        return { ran: true, value };
      } catch (error) {
        return { ran: true, error };
      }
    },
  };
  const req = { name: 'hourly-2026-11-13T04-00-00-000Z', kind: 'hourly' };
  const answer = await (local ? take.takeSnapshotLocal(req, host) : take.takeSnapshot(req));
  fs.writeSync(1, `ENDED ${JSON.stringify(answer)}\n`);
  process.exit(3);
}

async function check() {
  const unparsed = liveFiles(dataDir).filter(p => {
    try { JSON.parse(fs.readFileSync(p, 'utf8')); return false; } catch { return true; }
  });
  const root = path.join(dataDir, '_snapshots');
  const work = () => (fs.existsSync(root) ? fs.readdirSync(root).filter(n => n.startsWith('.taking-')) : []);
  const before = work();
  const mismatched = [];
  for (const entry of await list.listSnapshots()) {
    if (entry.state !== 'complete') continue;
    const verdict = await verify.verifyTree(path.join(root, entry.name, 'data'), entry.manifest);
    if (!verdict.ok) mismatched.push(entry.name);
  }
  lock.configureWriterLock('bot');
  const taken = lock.takeWriterLock().kind;
  const answer = await take.takeSnapshot({ name: 'hourly-2026-11-13T05-00-00-000Z', kind: 'hourly' });
  const after = work();
  lock.releaseWriterLock();
  const result = { unparsed, mismatched, before, after, taken, answer };
  const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
  fs.writeSync(1, `RESULT ${JSON.stringify({ result, loaded })}\n`);
  process.exit(0);
}

(step === 'take' ? runTake() : check()).catch(error => {
  fs.writeSync(2, `${error && error.stack || error}\n`);
  process.exit(1);
});
