// Child scenario: one step of a node's life per process, so module state starts
// clean the way it does after a real restart. Prints one RESULT line of JSON
// with the step's result and the bot modules it loaded.
// Usage: node fleetIdentity.cjs <write-override JSON | read | consume | node-id>
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const identity = require(path.join(root, 'dist', 'bot', 'internalSetup', 'fleet', 'nodeIdentity.js'));

const [step, arg] = process.argv.slice(2);
let result;
if (step === 'write-override') {
  identity.writeRoleOverride(JSON.parse(arg));
  result = null;
} else if (step === 'read') {
  result = { override: identity.readRoleOverride(), role: identity.resolveNodeRole(), standIn: identity.isStandInBoot() };
} else if (step === 'consume') {
  identity.consumeTakeoverFlags();
  result = identity.readRoleOverride();
} else if (step === 'node-id') {
  result = { nodeId: identity.getNodeId(), fresh: identity.wasNodeIdFreshlyGenerated() };
} else {
  throw new Error(`unknown step ${step}`);
}
const loaded = Object.keys(require.cache).filter(file => file !== __filename && !file.includes(`${path.sep}node_modules${path.sep}`));
process.stdout.write(`RESULT ${JSON.stringify({ result, loaded })}\n`);
