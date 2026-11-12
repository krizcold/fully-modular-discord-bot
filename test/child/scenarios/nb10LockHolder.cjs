// A writer of the NB10 lock-kill scenario: takes the writer lock (polling while another process holds it), writes
// /data/global/nb10kill/x.json through the facade, and then, by its role argument:
//   hold       prints HELD once its write is on the wire (a slow rename) and waits to be killed
//   exit       prints EXITING and calls process.exit while its rename is on the wire
//   take       prints WAITING when its first try finds the lock held, and RESULT with the time it took the lock,
//              once its own write landed
// Usage: node nb10LockHolder.cjs <hold|exit|take> <body>
const path = require('path');
const fs = require('fs');

const [role, body] = process.argv.slice(2);
const dist = path.resolve(__dirname, '..', '..', '..', 'dist', 'bot', 'internalSetup', 'utils');

if (role !== 'take') {
  const rename = fs.promises.rename.bind(fs.promises);
  fs.promises.rename = async (from, to) => {
    if (String(to).endsWith('x.json')) {
      process.stdout.write(role === 'hold' ? 'HELD\n' : 'EXITING\n');
      if (role === 'exit') setImmediate(() => process.exit(0));
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
    return rename(from, to);
  };
}

const writerLock = require(path.join(dist, 'writerLock.js'));
const dataManager = require(path.join(dist, 'dataManager.js'));

async function main() {
  writerLock.configureWriterLock('bot');
  for (let tries = 0; ; tries++) {
    if (writerLock.takeWriterLock().kind === 'taken') break;
    if (tries === 0) process.stdout.write('WAITING\n');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const tookAt = Date.now();
  process.on('exit', () => writerLock.releaseWriterLockAtExit());
  dataManager.writeRawAtomic(path.join(process.env.DATA_DIR, 'global', 'nb10kill', 'x.json'), body);
  if (role === 'take') {
    await dataManager.flushAll();
    const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
    process.stdout.write(`RESULT ${JSON.stringify({ result: { tookAt }, loaded })}\n`);
    writerLock.releaseWriterLock();
    process.exit(0);
  }
  setInterval(() => {}, 1000);
}

main().catch(error => {
  console.error('[nb10LockHolder] failed:', error);
  process.exit(1);
});
