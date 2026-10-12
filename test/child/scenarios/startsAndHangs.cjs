// Not a step of the bot's life: it starts a process of its own, writes that
// process's id to the file named, and hangs, so unit/mutationRanges.test.ts
// can check that a step past its bound is ended with every process it started
// (helpers/child.ts). The process is detached, so nothing but that ends it:
// not the step's group, nor on Windows the job node ends its children with.
// Usage: node startsAndHangs.cjs <pid file>
const { spawn } = require('child_process');
const fs = require('fs');

const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', detached: true });
fs.writeFileSync(process.argv[2], String(started.pid));
setInterval(() => {}, 1000);
