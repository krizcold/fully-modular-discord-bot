// Child scenario: one boot of a node per process, so module state starts clean
// the way it does after a real restart. Prints one RESULT line of JSON with the
// node id and the bot modules it loaded.
// Usage: node nodeIdentity.cjs
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const identity = require(path.join(root, 'dist', 'bot', 'internalSetup', 'fleet', 'nodeIdentity.js'));

const result = identity.getNodeId();
const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
process.stdout.write(`RESULT ${JSON.stringify({ result, loaded })}\n`);
