// A Stryker reporter for the passes that run only some of the mutants Stryker
// makes (touched.mjs): Stryker makes every mutant a mutate range holds, so a
// span brings in mutants nested inside it that the pass is not for. When
// Stryker has made its plan, before any mutant runs, this writes the ids of the
// mutants the pass is for (their keys are in the file SMDB_MUTATION_TARGETS
// names; the ids go to the one SMDB_MUTATION_RUN names), and runner.mjs runs no
// test for the others, whose results touched.mjs drops.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { declareClassPlugin, PluginKind, tokens } from '@stryker-mutator/api/plugin';
import { fileOf, keyOf } from './keys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {{ line: number, column: number }} position Stryker's plan counts from 0, its results from 1 */
const fromOne = position => ({ line: position.line + 1, column: position.column + 1 });

class TargetsReporter {
  static inject = tokens();

  /**
   * @param {{ mutantPlans: readonly { mutant: { id: string, fileName: string, mutatorName: string, replacement?: string,
   *   location: { start: { line: number, column: number }, end: { line: number, column: number } } } }[] }} event
   */
  onMutationTestingPlanReady({ mutantPlans }) {
    const targets = process.env.SMDB_MUTATION_TARGETS;
    const run = process.env.SMDB_MUTATION_RUN;
    if (!targets || !run) return;
    const keys = new Set(JSON.parse(fs.readFileSync(targets, 'utf8')));
    const ids = mutantPlans
      .map(plan => plan.mutant)
      .filter(m => keys.has(keyOf(fileOf(root, m.fileName), m.mutatorName, m.replacement ?? '', { start: fromOne(m.location.start), end: fromOne(m.location.end) })))
      .map(m => m.id);
    fs.writeFileSync(run, JSON.stringify(ids));
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Reporter, 'smdb-targets', TargetsReporter)];
