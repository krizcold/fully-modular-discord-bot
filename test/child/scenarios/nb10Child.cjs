// The bot process of the NB10 scenarios, forked by nb10Parent.cjs through BotManager: the compiled dist/bot/index.js
// itself, with its clientInitializer replaced by the module below. So the real entry takes the writer lock, installs
// the stop handler and its deposition listener, and no Discord client is made. NB10_CHILD_MODE picks what the
// replacement does:
//   two-writers   on {type:'nb10:go'} increments /data/global/nb10two/counter.json 200 times through the facade, one
//                 every 2 ms, each marking 'c' in the file's log
//   stop-early    reports shared only (bootShards held); its flushes take NB10_SLOW_MS longer
//   maintenance   the real runMaintenanceBoot (maintenance.json says maintenance) with a shard count that keeps failing;
//                 its flushes take NB10_SLOW_MS longer
//   deposed       on {type:'nb10:prepare'} it holds a global write whose flush keeps failing, journals a provider event
//                 whose line never lands (premium-tiers.json broken) and registers a stop step held 3 s during which
//                 an entitlement event arrives; the parent then takes the lock and the child's own 5 s check deposes
//                 it. On {type:'nb10:depose', variant}: 'snapshot' sends a large metrics:snapshot and runs the real
//                 check at once; 'no-message' and 'exit-1' exit by hand (a child that died without its report)
const path = require('path');
const fs = require('fs');
const Module = require('module');

const dist = path.resolve(__dirname, '..', '..', '..', 'dist');
const utils = path.join(dist, 'bot', 'internalSetup', 'utils');
const mode = process.env.NB10_CHILD_MODE;
const slowMs = Number(process.env.NB10_SLOW_MS || 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failing = { rename: null, append: null };

const realRename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (from, to) => {
  if (slowMs > 0 && String(to).endsWith('.json')) await sleep(slowMs);
  if (failing.rename && String(to).includes(failing.rename)) throw Object.assign(new Error('EIO: injected, rename'), { code: 'EIO' });
  return realRename(from, to);
};
// An append opens its file 'a+': on a failing path, that handle's write rejects with EIO before any byte.
const realOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = async (file, flags, mode) => {
  const handle = await realOpen(file, flags, mode);
  if (flags !== 'a+' || !failing.append || !String(file).endsWith(failing.append)) return handle;
  return new Proxy(handle, {
    get(target, prop) {
      if (prop === 'write') return async () => { throw Object.assign(new Error('EIO: injected, write'), { code: 'EIO' }); };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

function replacement() {
  void run().catch(error => {
    console.error('[nb10Child] failed:', error);
    process.exit(1);
  });
  return {};
}

async function run() {
  const writerLock = require(path.join(utils, 'writerLock.js'));
  const dataManager = require(path.join(utils, 'dataManager.js'));
  const sharedOps = require(path.join(utils, 'sharedOps.js'));

  if (mode === 'maintenance') {
    const maintenance = require(path.join(utils, 'maintenance.js'));
    const boot = await maintenance.decideBoot(async () => 'accepted');
    if (boot.mode !== 'maintenance') throw new Error(`maintenance.json did not give a maintenance boot: ${JSON.stringify(boot)}`);
    listen(writerLock, dataManager);
    await maintenance.runMaintenanceBoot(boot, {
      shards: async () => { throw new Error('injected: no shard count'); },
      login: () => new Promise(() => undefined),
    });
    return;
  }

  sharedOps.setupSharedOpsIPC();
  writerLock.reportWriterStage('shared');
  if (mode !== 'stop-early') writerLock.reportWriterStage('guild');
  process.stdout.write('Logged in as nb10#0001!\n');
  listen(writerLock, dataManager);
}

function listen(writerLock, dataManager) {
  process.on('message', async message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'nb10:sigterm') {
      // A signal on Windows ends a process without its handlers; the scenario delivers it as Node would on Linux.
      process.emit('SIGTERM');
    } else if (message.type === 'nb10:go' && mode === 'two-writers') {
      let accepted = 0;
      for (let i = 0; i < 200; i++) {
        const outcome = dataManager.updateGlobalModuleData('counter.json', 'nb10two', { n: 0, log: '' }, c => ({ n: c.n + 1, log: `${c.log || ''}c` }));
        if (outcome.outcome === 'saved') accepted++;
        await sleep(2);
      }
      await dataManager.flushAll();
      process.send({ type: 'nb10:done', accepted });
    } else if (message.type === 'nb10:prepare' && mode === 'deposed') {
      prepareLosses(dataManager);
      process.send({ type: 'nb10:prepared' });
    } else if (message.type === 'nb10:depose' && mode === 'deposed') {
      if (message.variant === 'snapshot') {
        process.send({ type: 'metrics:snapshot', data: { big: 'x'.repeat(4 * 1024 * 1024) } });
        writerLock.checkWriterLock();
      } else if (message.variant === 'no-message') {
        process.exit(75);
      } else {
        process.send({ type: 'data:writer', data: { stage: 'deposed', holder: { role: 'import', pid: 31 } } });
        process.exit(1);
      }
    }
  });
}

function prepareLosses(dataManager) {
  const { dataPath } = require(path.join(dist, 'utils', 'dataRoot.js'));
  const premium = require(path.join(utils, 'premiumManager.js'));
  const { getPaymentRegistry } = require(path.join(utils, 'payment', 'paymentRegistry.js'));
  const state = (status, days) => ({ status, startDate: new Date().toISOString(), endDate: new Date(Date.now() + days * 86_400_000).toISOString(), autoRenew: true });

  failing.rename = `${path.sep}nb10dep${path.sep}`;
  dataManager.updateGlobalModuleData('x.json', 'nb10dep', { v: 0 }, () => ({ v: 1 }));

  fs.mkdirSync(dataPath('global'), { recursive: true });
  fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ broken');
  failing.append = 'premium-tiers.events.jsonl';
  premium.getPremiumManager();
  getPaymentRegistry().emitEvent({ type: 'subscription.expired', providerId: 'discord', providerSubId: 'd1', guildId: 'g1', state: state('expired', -1) });

  dataManager.addStopStep(async () => {
    console.log('[nb10Child] gateway close step started');
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'discord', providerSubId: 'ent9', guildId: 'g9', tierId: 'low', offeringId: 'o1', state: state('active', 30) });
    await sleep(3000);
    console.log('[nb10Child] gateway close step ended');
  });
}

const target = path.join(dist, 'bot', 'internalSetup', 'clientInitializer.js');
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && request.includes('clientInitializer')) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null;
    }
    if (resolved === target) return replacement();
  }
  return realLoad.apply(this, arguments);
};

require(path.join(dist, 'bot', 'index.js'));
