// A Stryker reporter for every pass (touched.mjs). When Stryker has made its
// plan, before any check or run, it writes plan.json in the pass's dir (each
// planned mutant's id and key), and it appends a line to results.jsonl there
// for each result of a mutant the pass is for as Stryker reports it, which is
// what the gate reads of the pass, so a run that stops keeps what it found
// (resume.mjs). Stryker does not await a reporter, so each write is
// synchronous: it is on disk before the call returns.
// In a pass that runs only some of the mutants Stryker makes (a span brings in
// mutants nested inside it that the pass is not for), it also writes the ids
// of the mutants the pass is for (their keys are in the file
// SMDB_MUTATION_TARGETS names; the ids go to the one SMDB_MUTATION_RUN names,
// and each id's key to run-keys.json beside it), and runner.mjs runs no test
// for the others, whose results touched.mjs drops. In every pass it also
// leaves Stryker's own time for the run with no mutant (dry-timing.json in the
// pass's dir), which each rerun's budget is built from (control.mjs).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { declareClassPlugin, PluginKind, tokens } from '@stryker-mutator/api/plugin';
import { fileOf, keyOf } from './keys.mjs';
import { RUN_KEYS_FILE } from './reach.mjs';
import { PLAN_FILE, RESULTS_FILE } from './resume.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {{ line: number, column: number }} position Stryker's plan counts from 0, its results from 1 */
const fromOne = position => ({ line: position.line + 1, column: position.column + 1 });

/**
 * @typedef {{ start: { line: number, column: number }, end: { line: number, column: number } }} Place
 * @typedef {{ id: string, fileName: string, mutatorName: string, replacement?: string, location: Place }} Mutant
 */

class TargetsReporter {
  static inject = tokens();

  /** @type {Set<string> | null} in a pass on some of the mutants, the keys of those it is for */
  forKeys = null;

  /** @param {{ mutantPlans: readonly { mutant: Mutant }[] }} event */
  onMutationTestingPlanReady({ mutantPlans }) {
    const out = process.env.SMDB_MUTATION_OUT;
    const planned = mutantPlans.map(plan => plan.mutant).map(m => {
      const file = fileOf(root, m.fileName);
      const location = { start: fromOne(m.location.start), end: fromOne(m.location.end) };
      const replacement = m.replacement ?? '';
      return { id: m.id, key: keyOf(file, m.mutatorName, replacement, location), file, location, mutator: m.mutatorName, replacement };
    });
    const targets = process.env.SMDB_MUTATION_TARGETS;
    const run = process.env.SMDB_MUTATION_RUN;
    if (targets && run) {
      const keys = new Set(/** @type {string[]} */ (JSON.parse(fs.readFileSync(targets, 'utf8'))));
      this.forKeys = keys;
      const forPass = planned.filter(m => keys.has(m.key));
      fs.writeFileSync(run, JSON.stringify(forPass.map(m => m.id)));
      // a2 finds by the key the files each mutant's run in pass A took (runner.mjs).
      fs.writeFileSync(path.join(path.dirname(run), RUN_KEYS_FILE), JSON.stringify(Object.fromEntries(forPass.map(m => [m.id, m.key]))));
    }
    if (out) fs.writeFileSync(path.join(out, PLAN_FILE), JSON.stringify(planned));
  }

  /**
   * One line per result, CompileError and Ignored included, with its places
   * counted from 1 as every result's are; in a pass on some of the mutants,
   * only for those it is for: Stryker reports the others Survived, with no
   * test run.
   * @param {Mutant & { status: string, statusReason?: string }} result
   */
  onMutantTested(result) {
    const out = process.env.SMDB_MUTATION_OUT;
    if (!out) return;
    const key = keyOf(fileOf(root, result.fileName), result.mutatorName, result.replacement ?? '', result.location);
    if (this.forKeys && !this.forKeys.has(key)) return;
    const line = { key, id: result.id, status: result.status, ...(result.statusReason !== undefined ? { statusReason: result.statusReason } : {}) };
    fs.appendFileSync(path.join(out, RESULTS_FILE), `${JSON.stringify(line)}\n`);
  }

  /**
   * Stryker times the run with no mutant on its own clock: each rerun's budget
   * is timeoutFactor times `net`, plus timeoutMS, plus `overhead`.
   * @param {{ timing: { net: number, overhead: number } }} event
   */
  onDryRunCompleted({ timing }) {
    const out = process.env.SMDB_MUTATION_OUT;
    if (!out) return;
    fs.writeFileSync(path.join(out, 'dry-timing.json'), JSON.stringify({ net: timing.net, overhead: timing.overhead }));
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Reporter, 'smdb-targets', TargetsReporter)];
