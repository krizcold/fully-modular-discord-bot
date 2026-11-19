// Fails when a file under src/ makes a raw fsync or handle sync call that the table below does not allow. Folder syncs
// belong in folderChain.ts, where a failure sets the process's flag; a new raw call changes this table in its review.
const fs = require('fs');
const path = require('path');

const PATTERNS = [/\bf(?:data)?sync(?:Sync)?\s*\(/g, /\.(?:data)?sync\s*\(\s*\)/g];
const ANY = 'bot/internalSetup/utils/folderChain.ts';
const ALLOWED = {
  'bot/internalSetup/utils/appStoreManager.ts': 2,
  'bot/internalSetup/utils/atomicWrite.ts': 1,
  'bot/internalSetup/utils/dataBackends/fileBackend.ts': 6,
  'bot/internalSetup/utils/dataInterchange.ts': 1,
  'bot/internalSetup/utils/dataMigration.ts': 1,
  'bot/internalSetup/utils/sharedModules.ts': 1,
  'webui/utils/configBackups.ts': 1,
};

function sourceFiles(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sourceFiles(path.join(dir, entry.name), relPath, out);
    else if (/\.(?:ts|js|jsx)$/.test(entry.name)) out.push(relPath);
  }
  return out;
}

/** The failures under `root` (the folder that stands for src/), one line per match in a failing file. */
function checkSyncSites(root) {
  const failures = [];
  for (const rel of sourceFiles(root, '', []).sort()) {
    if (rel === ANY) continue;
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    const matches = [];
    lines.forEach((line, i) => {
      for (const p of PATTERNS) for (const _ of line.matchAll(p)) matches.push(i + 1);
    });
    const allowed = Object.prototype.hasOwnProperty.call(ALLOWED, rel) ? ALLOWED[rel] : 0;
    if (matches.length <= allowed) continue;
    for (const n of new Set(matches)) failures.push(`${rel}:${n} (found ${matches.length}, allowed ${allowed})`);
  }
  return failures;
}

module.exports = { checkSyncSites };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));
  const failures = checkSyncSites(root);
  if (failures.length) {
    console.error(`[SyncSites] Raw sync calls outside folderChain.ts that test/checkSyncSites.cjs does not allow:\n${failures.join('\n')}`);
    process.exit(1);
  }
}
