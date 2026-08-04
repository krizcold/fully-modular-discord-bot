// Tiny CLI for the cross-node round-trip test (P4 test drill 4):
//   node dist/tools/dataBundle export <guildId> <file>
//   node dist/tools/dataBundle import <file>
// Export writes a DBEX1 bundle of one guild's namespace; import restores it
// into the live guild dir (guildId is read from the bundle records).

import * as path from 'path';
import { DATA_ROOT } from '../utils/dataRoot';
import { importNamespace, readBundle, writeBundle } from '../bot/internalSetup/utils/dataInterchange';

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);

  if (cmd === 'export') {
    if (!a || !b) {
      console.error('Usage: dataBundle export <guildId> <file>');
      process.exit(1);
    }
    const summary = await writeBundle(a, b);
    console.log(`Exported guild ${a}: ${summary.fileCount} file(s), ${summary.totalBytes} bytes`);
    console.log(`namespaceHash=${summary.namespaceHash}`);
    return;
  }

  if (cmd === 'import') {
    if (!a) {
      console.error('Usage: dataBundle import <file>');
      process.exit(1);
    }
    // Peek the first record for the guildId, then restore the whole stream.
    const gen = readBundle(a);
    const first = await gen.next();
    if (first.done) {
      console.error('Bundle is empty; nothing to import');
      process.exit(1);
      return;
    }
    const firstRecord = first.value;
    const guildId = firstRecord.guildId;
    async function* full() {
      yield firstRecord;
      yield* gen;
    }
    const destDir = path.join(DATA_ROOT, guildId);
    const result = await importNamespace(guildId, full(), destDir);
    console.log(`Imported guild ${guildId}: ${result.fileCount} file(s), ${result.totalBytes} bytes -> ${destDir}`);
    return;
  }

  console.error('Usage: dataBundle export <guildId> <file> | import <file>');
  process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
