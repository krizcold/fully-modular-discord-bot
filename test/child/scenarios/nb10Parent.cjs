// The web UI side of the NB10 scenarios: the compiled BotManager, whose fork starts nb10Child.cjs (the real
// dist/bot/index.js with a stand-in clientInitializer) in place of the bot. Prints one RESULT line of JSON with the
// scenario's outcome and the bot modules it loaded.
// Usage: node nb10Parent.cjs two-writers | stop-early | maintenance | deposed <real|real-sigterm|snapshot|no-message|exit-1>
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const CHILD = path.join(__dirname, 'nb10Child.cjs');
const [mode, variant] = process.argv.slice(2);

const guardedFork = childProcess.fork;
childProcess.fork = function (_modulePath, args, options) {
  return guardedFork.call(this, CHILD, args, { ...options, execArgv: [] });
};
process.env.DISCORD_TOKEN = 'nb10-not-a-token';
process.env.CLIENT_ID = '1';
process.env.GUILD_ID = '2';
process.env.NB10_CHILD_MODE = mode;
if (mode === 'stop-early' || mode === 'maintenance') process.env.NB10_SLOW_MS = '1500';

const warns = [];
const realWarn = console.warn;
console.warn = (...args) => { warns.push(args.map(String).join(' ')); realWarn(...args); };

const dist = path.join(root, 'dist');
const { BotManager } = require(path.join(dist, 'webui', 'botManager.js'));
const { dataPath } = require(path.join(dist, 'utils', 'dataRoot.js'));
const { getSafetyManager } = require(path.join(dist, 'utils', 'updateSafety.js'));
const sha = raw => (raw === null || raw === undefined ? 'absent' : crypto.createHash('sha256').update(raw).digest('hex'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(test, ms) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(20);
  return test();
}

/** Everything the child prints, beside BotManager's own capture. */
function childOutput(child) {
  const out = { text: '' };
  child.stdout.on('data', chunk => { out.text += chunk; });
  child.stderr.on('data', chunk => { out.text += chunk; });
  return out;
}

async function twoWriters(manager) {
  const child = manager.botProcess;
  const done = new Promise(resolve => child.on('message', m => { if (m && m.type === 'nb10:done') resolve(m.accepted); }));
  let accepted = 0;
  const refusals = {};
  for (let i = 0; i < 200; i++) {
    const read = await manager.readGlobalData({ rel: 'nb10two/counter.json' });
    if (i === 0) child.send({ type: 'nb10:go' });
    if (!read || read.ok !== true) { refusals[`read:${read && read.code}`] = (refusals[`read:${read && read.code}`] || 0) + 1; continue; }
    const current = read.contentJson === undefined ? { n: 0, log: '' } : JSON.parse(read.contentJson);
    const reply = await manager.runSharedOp('global.write', {
      rel: 'nb10two/counter.json', contentJson: JSON.stringify({ n: current.n + 1, log: `${current.log || ''}p` }), expectSha: sha(read.contentJson ?? null),
    });
    if (reply && reply.ok) accepted++;
    else refusals[reply && reply.code] = (refusals[reply && reply.code] || 0) + 1;
  }
  const childAccepted = await done;
  await manager.shutdown(false);
  await until(() => !manager.isRunning(), 30_000);
  const stored = JSON.parse(fs.readFileSync(dataPath('global', 'nb10two', 'counter.json'), 'utf8'));
  return { final: stored.n, log: stored.log, parentAccepted: accepted, childAccepted, refusals };
}

/** Waits until the child prints, after `from`, that the slowed flush of `file` is on the wire. */
async function flushStarted(out, from, file) {
  const line = `[nb10Child] slowed rename to ${file} started`;
  if (!await until(() => out.text.indexOf(line, from) !== -1, 10_000)) throw new Error(`the child never printed: ${line}`);
}

async function stopEarly(manager, out) {
  const child = manager.botProcess;
  let exitCode = null;
  child.on('exit', code => { exitCode = code; });
  const from = out.text.length;
  const sent = manager.runSharedOp('global.write', { rel: 'nb10stop/x.json', contentJson: '{"landed":true}', expectSha: 'absent' });
  await flushStarted(out, from, 'x.json');
  child.send({ type: 'nb10:sigterm' });
  const reply = await sent;
  await until(() => exitCode !== null, 30_000);
  const target = dataPath('global', 'nb10stop', 'x.json');
  return { reply, exitCode, onDisk: fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null };
}

async function maintenanceStop(manager, out) {
  const child = manager.botProcess;
  let exitCode = null;
  child.on('exit', code => { exitCode = code; });
  const retrying = await until(() => out.text.includes('Could not fetch the shard count from Discord'), 10_000);
  const refused = await manager.runSharedOp('global.write', { rel: 'nb10stop/x.json', contentJson: '{"landed":true}', expectSha: 'absent' });
  const from = out.text.length;
  const sent = manager.runSharedOp('premium.setMessages', { args: [{ moduleBlocked: 'nb10 maintenance stop' }] });
  await flushStarted(out, from, 'premium-tiers.json');
  child.send({ type: 'nb10:sigterm' });
  const reply = await sent;
  await until(() => exitCode !== null, 30_000);
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    retrying, refused, reply, exitCode,
    premium: fs.existsSync(premium) ? JSON.parse(fs.readFileSync(premium, 'utf8')) : null,
    globalWritten: fs.existsSync(dataPath('global', 'nb10stop', 'x.json')),
  };
}

async function deposed(manager, out) {
  const child = manager.botProcess;
  let exitCode = null;
  let exitedAt = null;
  child.on('exit', code => { exitCode = code; exitedAt = out.text.length; });
  const lock = { pid: process.pid, start: null, role: 'import', at: Date.now() };
  const real = variant === 'real' || variant === 'real-sigterm';
  let sigtermSent = false;
  if (real) {
    const prepared = new Promise(resolve => child.on('message', m => { if (m && m.type === 'nb10:prepared') resolve(); }));
    child.send({ type: 'nb10:prepare' });
    await prepared;
  }
  const crashRestartsBefore = manager.crashRestarts;
  const crashCountBefore = getSafetyManager().getStatus().crashCount;
  if (variant === 'no-message') {
    fs.writeFileSync(dataPath('.writer.lock'), JSON.stringify({ pid: 31, start: null, role: 'import', at: Date.now() }));
  } else if (real || variant === 'snapshot') {
    fs.writeFileSync(dataPath('.writer.lock'), JSON.stringify(lock));
  }
  const tookAt = Date.now();
  if (!real) child.send({ type: 'nb10:depose', variant });
  if (variant === 'real-sigterm' && await until(() => out.text.includes('[nb10Child] gateway close step started'), 15_000)) {
    if (exitCode === null) {
      child.send({ type: 'nb10:sigterm' });
      sigtermSent = true;
    }
  }
  await until(() => exitCode !== null && !manager.isRunning(), 30_000);
  const exitAfterMs = Date.now() - tookAt;
  await sleep(200);
  const result = {
    exitCode,
    exitAfterMs,
    sigtermSent,
    crashed: manager.getStatus().crashed,
    crashLogs: manager.crashLogs.length,
    crashRestartsBefore,
    crashRestartsAfter: manager.crashRestarts,
    deposedLines: warns.filter(l => l.startsWith('[BotManager] The bot process stopped:')),
    crashCountBefore,
    crashCountAfter: getSafetyManager().getStatus().crashCount,
    parentPid: process.pid,
    childLog: out.text,
    childLogAtExit: exitedAt,
    lockAfter: fs.existsSync(dataPath('.writer.lock')) ? fs.readFileSync(dataPath('.writer.lock'), 'utf8') : null,
    lockWritten: JSON.stringify(lock),
  };
  manager.beginExit();
  if (manager.crashRestartTimer) clearTimeout(manager.crashRestartTimer);
  return result;
}

async function main() {
  if (mode === 'maintenance') {
    fs.writeFileSync(dataPath('maintenance.json'), JSON.stringify({ state: 'maintenance', message: 'nb10 maintenance', since: null }));
  }
  const manager = new BotManager();
  const started = await manager.start();
  if (!started.success) throw new Error(`the bot did not start: ${JSON.stringify(started)}`);
  const out = childOutput(manager.botProcess);
  await until(() => manager.childStage === (mode === 'stop-early' ? 'shared' : 'guild'), 20_000);
  const result = mode === 'two-writers' ? await twoWriters(manager)
    : mode === 'stop-early' ? await stopEarly(manager, out)
      : mode === 'maintenance' ? await maintenanceStop(manager, out)
        : await deposed(manager, out);
  const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
  process.stdout.write(`RESULT ${JSON.stringify({ result, loaded })}\n`);
  process.exit(0);
}

main().catch(error => {
  console.error('[nb10Parent] failed:', error);
  process.exit(1);
});
