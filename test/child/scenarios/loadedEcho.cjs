// Child scenario for helpers/child.ts's own check (unit/childPreload.test.ts): loads nothing of the bot and prints one
// RESULT line whose loaded list is what this process loaded, the names given added, and the fork guard left out when
// asked. Usage: node loadedEcho.cjs '<JSON list of names>' [no-guard]
const path = require('path');

const extra = JSON.parse(process.argv[2] || '[]');
const dropGuard = process.argv[3] === 'no-guard';
const loaded = Object.keys(require.cache)
  .filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`))
  .filter(file => !dropGuard || path.basename(file) !== 'forkGuard.cjs');
process.stdout.write(`RESULT ${JSON.stringify({ result: { pid: process.pid, reach: process.env.SMDB_MUTATION_REACH ?? null, token: process.env.SMDB_MUTATION_REACH_TOKEN ?? null }, loaded: [...loaded, ...extra] })}\n`);
