#!/usr/bin/env node
// @ts-check
/**
 * The oracle's checker (VERIFY.md section 5.3): judges writer logs against
 * copies of the run's docs and prints one line per verdict.
 * Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 64 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseLog } from './oracle.mjs';
import { appCopy, buildHistory, dbCopy, judge } from './judge.mjs';

const USAGE = `check.mjs --log FILE [--log FILE ...]
  [--db NAME=FILE ...]   a database listing that must hold every acknowledged effect
  [--lag NAME=FILE ...]  a database listing allowed to lag (an async standby)
  [--app FILE ...]       a copy read through a node's app path (oracle.mjs read)
  [--agree NAME,NAME]    copies that must match key for key
  [--fleet FILE ...]     control facts from each node (oracle.mjs fleet); without it the run is inconclusive
  [--fleet-again FILE ...] a second set taken after the first: only a CONTROL in both sets counts
  [--no-fleet]           only where the run has no fleet to check (a single local node)
  [--window NAME ...]    a window the scenario must have marked
  [--k N (5)]            acknowledged operations needed in each marked window
  [--out FILE]           the full result as JSON`;

/** @param {string} spec */
function named(spec) {
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error(`${spec}: expected NAME=FILE`);
  return { name: spec.slice(0, eq), file: spec.slice(eq + 1) };
}

/** @param {string[]} argv */
export function check(argv) {
  const a = parseArgs(argv, {
    log: 'many', db: 'many', lag: 'many', app: 'many', agree: 'one', fleet: 'many', 'fleet-again': 'many', 'no-fleet': 'flag', window: 'many',
    k: 'one', out: 'one',
  });
  if (a.log.length === 0) throw new Error('at least one --log is needed');
  const history = buildHistory(a.log.map((/** @type {string} */ f) => parseLog(fs.readFileSync(f, 'utf8'))));
  const copies = [
    ...a.db.map((/** @type {string} */ s) => { const { name, file } = named(s); return dbCopy(name, 'judged', fs.readFileSync(file, 'utf8')); }),
    ...a.lag.map((/** @type {string} */ s) => { const { name, file } = named(s); return dbCopy(name, 'lagging', fs.readFileSync(file, 'utf8')); }),
    ...a.app.map((/** @type {string} */ f) => appCopy(fs.readFileSync(f, 'utf8'))),
  ];
  const names = copies.map(c => c.name);
  if (new Set(names).size !== names.length) throw new Error('copy names must differ');
  const facts = (/** @type {string[]} */ files) => files.map(f => {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { name: doc.name, state: doc.state };
  });
  const fleet = facts(a.fleet);
  const fleetAgain = facts(a['fleet-again']);
  const k = a.k !== undefined ? Number(a.k) : 5;
  if (!Number.isInteger(k) || k < 0) throw new Error('--k must be a whole number');
  if (a['no-fleet'] && fleet.length + fleetAgain.length > 0) throw new Error('--no-fleet and --fleet exclude each other');
  if (fleetAgain.length > 0 && fleet.length === 0) throw new Error('--fleet-again needs a first set (--fleet)');
  const result = judge({
    history, copies, agree: a.agree ? a.agree.split(',') : [], fleet, fleetAgain, noFleet: a['no-fleet'] === true, windows: a.window, k,
  });
  if (a.out) fs.writeFileSync(a.out, `${JSON.stringify(result, null, 2)}\n`);
  return { result, run: history.run, guild: history.guild };
}

/** @param {ReturnType<typeof check>} checked */
export function render({ result, run, guild }) {
  const lines = [`run ${run} on guild ${guild}; copies: ${result.copies.join(', ') || 'none'}`];
  lines.push(`answers: ${Object.entries(result.answers).map(([k, v]) => `${k} ${v}`).join(', ')}; reads during the run: ${result.reads}`);
  for (const v of result.verdicts) {
    const marks = `${v.during ? ' (during)' : ''}${result.provisional ? ' (provisional)' : ''}`;
    lines.push(`${v.v}${marks} ${v.key ?? ''} [${v.copy ?? 'fleet'}] ${v.detail}`.replace(/ {2,}/g, ' '));
  }
  for (const reason of result.inconclusive) lines.push(`INCONCLUSIVE ${reason}`);
  for (const note of result.notes) lines.push(`note: ${note}`);
  // The operator route is the only one exercised; until the owner rules on
  // what "saved" means for module saves, nothing here claims zero loss [A18].
  lines.push(`RESULT ${result.result} (operator route; module path unproven)`);
  return lines.join('\n');
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    const checked = check(process.argv.slice(2));
    console.log(render(checked));
    process.exitCode = checked.result.result === 'PASS' ? 0 : checked.result.result === 'FAIL' ? 1 : 2;
  } catch (error) {
    console.error(`check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exitCode = 64;
  }
}
