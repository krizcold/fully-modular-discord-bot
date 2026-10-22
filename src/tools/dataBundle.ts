// Tiny CLI for the cross-node round-trip test (P4 test drill 4):
//   node dist/tools/dataBundle export <guildId> <file>
//   node dist/tools/dataBundle import <file>
// Export writes a DBEX1 bundle of one guild's namespace; import stages,
// verifies and swaps it into the guild dir (guildId is read from the bundle).
// Both refuse a postgres-routed guild and a running bot child (asked of the panel on its port).

import { Client, resolveTarget } from '../cli/client';
import { bundleRefusal, importBundle, readBundle, writeBundle } from '../bot/internalSetup/utils/dataInterchange';

async function refuseIfUnsafe(guildId: string): Promise<void> {
  const refusal = bundleRefusal(guildId, await new Client(resolveTarget({})).botAnswers());
  if (refusal) {
    console.error(`Refused: ${refusal}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);

  if (cmd === 'export') {
    if (!a || !b) {
      console.error('Usage: dataBundle export <guildId> <file>');
      process.exit(1);
    }
    await refuseIfUnsafe(a);
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
    const gen = readBundle(a);
    const first = await gen.next();
    await gen.return(undefined);
    if (first.done) {
      console.error('Bundle is empty; nothing to import');
      process.exit(1);
      return;
    }
    await refuseIfUnsafe(first.value.guildId);
    const result = await importBundle(a);
    console.log(`Imported guild ${result.guildId}: ${result.fileCount} file(s), ${result.totalBytes} bytes -> ${result.destDir}`
      + (result.replaced ? ` (the previous copy is at ${result.replaced})` : ''));
    return;
  }

  console.error('Usage: dataBundle export <guildId> <file> | import <file>');
  process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
