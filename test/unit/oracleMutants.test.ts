import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, describe, expect, it } from 'vitest';
import { checks } from '../oracle/model';

// Each mutant breaks one rule of judge.mjs, and some check of the model must
// fail on it. A surviving mutant is a rule no check holds. An anchor that no
// longer matches fails too, so the list follows the source.

const here = path.dirname(fileURLToPath(import.meta.url));
const oracleDir = path.join(here, '../oracle');
const work = path.join(here, `../.mutants-${process.pid}`);

const SUPERSEDE_END = '    || (w.lane !== shown.lane && w.log === shown.log && w.at > shown.ansAt)));\n}\n\n/**\n * Committed writes';

const MUTANTS: [string, string, string][] = [
  ['unanswered writes count as superseded', '  if (!committed(shown)) return [];\n', ''],
  ['order by send, not answer', SUPERSEDE_END, SUPERSEDE_END.replace('w.at > shown.ansAt', 'w.at > shown.at')],
  ['clocks of two logs compared', SUPERSEDE_END, SUPERSEDE_END.replace('w.log === shown.log && ', '')],
  ['every refusal may apply', "const possiblyApplied = op => !(op.cls === 'REFUSED' && op.definite);", 'const possiblyApplied = op => true;'],
  ['read ordered by send', "} else if (w.cls === 'ACKED' && w.ansAt < r.at0 && !delSent) {", "} else if (w.cls === 'ACKED' && w.at < r.at0 && !delSent) {"],
  ['lagging copy judged', "const judged = copy.mode === 'judged';", 'const judged = true;'],
  ['held not committed', "const committed = op => op.cls === 'ACKED' || op.cls === 'HELD';", "const committed = op => op.cls === 'ACKED';"],
  ['mark problems ignored', 'const inconclusive = [...history.problems];', 'const inconclusive = [];'],
  ['failed app reads ignored', 'if (failed.length > 0) inconclusive.push(', 'if (false) inconclusive.push('],
  ['missing app rows ignored', 'const missing = copy.sample ? [] : r.unread.filter(key => !copy.docs.has(key));', 'const missing = [];'],
  ['cut log not inconclusive', 'if (!l.ended) {\n      inconclusive.push(', 'if (!l.ended) {\n      notes.push('],
  ['cut stream judged', "if (!ended && start.sink === 'stream') {", 'if (false) {'],
  ['start line with no sink accepted', "if (start.sink !== 'file' && start.sink !== 'stream') throw", 'if (false) throw'],
  ['slow marks poll accepted', 'if (every > MARKS_EVERY_MAX && events.some(', 'if (false && events.some('],
  ['begin without end accepted', '      problems.push(`window ${name} in log ${log + 1} begins but never ends`);\n', ''],
  ['read late landing silent', 'committedAfterUnanswered(entry, shown, r.at0)', '[]'],
  ['resurrected read not judged', "else if (delDone) add('RESURRECTED',", "else if (false) add('RESURRECTED',"],
  ['wrong read not judged', "if (r.state.h !== w.h) add('WRONG-CONTENT',", "if (false) add('WRONG-CONTENT',"],
  ['vanished hot read not judged', "if (acked.length > 0) add('LOST', `served as absent after write", "if (false) add('LOST', `served as absent after write"],
  ['guild split not checked', 'if (set.size > 1) add(`guild', 'if (false) add(`guild'],
  ['guild out of range not checked', "if (typeof count === 'number' && count > 0 && (typeof shard !== 'number' || shard < 0 || shard >= count)) {", 'if (false) {'],
  ['whole-run coverage not counted', 'if (acked.length < k) reasons.push(', 'if (false) reasons.push('],
  ['shard table not checked', 'if (holder !== owner) add(', 'if (false) add('],
  ['shard counts not compared', 'if (counts && counts.size > 1) add(', 'if (false) add('],
  ['pending rows owned', "if (row.nodeId !== null && row.status !== 'pending') put(", 'if (row.nodeId !== null) put('],
  ['two sets not intersected', 'const both = controlVerdicts(commonFacts(first, second));', 'const both = controlVerdicts(second);'],
  ['facts joined, not met', 'if (shared.size > 0) out.set(key, shared);', 'out.set(key, new Set([...values, ...(y.get(key) ?? [])]));'],
  ['node sets not compared', 'for (const id of inFirst) if (!inSecond.has(id)) inconclusive.push(', 'for (const id of []) if (!inSecond.has(id)) inconclusive.push('],
  ['node in second set only not flagged', 'for (const id of inSecond) if (!inFirst.has(id)) inconclusive.push(', 'for (const id of []) if (!inFirst.has(id)) inconclusive.push('],
  ['node sets compared by file name', 'new Set(set.map(n => n.state.nodeId ?? n.name));', 'new Set(set.map(n => n.name));'],
  ['owners of the first set only', 'owners: meet(a.owners, b.owners)', 'owners: a.owners'],
  ['counts of the first set only', 'counts: meet(a.counts, b.counts)', 'counts: a.counts'],
  ['guild facts of the first set only', 'guildShards: meet(a.guildShards, b.guildShards)', 'guildShards: a.guildShards'],
  ['out-of-range facts of the first set only', 'outOfRange: meet(a.outOfRange, b.outOfRange)', 'outOfRange: a.outOfRange'],
  ['out-of-range keyed by count', "put(f.outOfRange, `${guild} ${shard}`, 'out');", 'put(f.outOfRange, `${guild} ${shard}`, String(count));'],
  ['empty sample accepted', 'if (judgedHere === 0 && committedKeys.length > 0) inconclusive.push(', 'if (false) inconclusive.push('],
  ['late landing silent', 'const late = committedAfterUnanswered(entry, shown, Infinity);', 'const late = [];'],
  ['fleet optional', 'if (fleet.length === 0 && !input.noFleet) inconclusive.push(', 'if (false) inconclusive.push('],
  ['unreadable node silent', 'if (!n.state.initialized || !n.state.running) inconclusive.push(', 'if (false) inconclusive.push('],
  ['second set unreadable silent', 'for (const n of [...fleet, ...again]) {', 'for (const n of fleet) {'],
  ['single set not judged', 'if (fleet.length > 0 && again.length === 0) verdicts.push(', 'if (false) verdicts.push('],
  ['double lease not checked', 'if (set.size > 1) add(`shard', 'if (false) add(`shard'],
  ['run mismatch accepted', 'if (c.run !== undefined && (c.run !== history.run || c.guild !== history.guild)) {', 'if (false) {'],
  ['required windows ignored', 'for (const name of required) {', 'for (const name of []) {'],
  ['no judged copy accepted', "if (!copies.some(c => c.mode === 'judged')) inconclusive.push(", 'if (false) inconclusive.push('],
  ['agreeing copies not compared', 'if (differ.length > 0) {', 'if (false) {'],
  ['window coverage not counted', 'if (inside < k) reasons.push(', 'if (false) reasons.push('],
];

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('mutants of judge.mjs', () => {
  const source = fs.readFileSync(path.join(oracleDir, 'judge.mjs'), 'utf8');
  // The quick hand-built checks sit last in the list: try them first.
  const ordered = checks().reverse();
  MUTANTS.forEach(([name, from, to], i) => {
    it(`kills: ${name}`, async () => {
      expect(source.split(from).length - 1).toBe(1);
      const dir = path.join(work, `m${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(oracleDir, 'oracle.mjs'), path.join(dir, 'oracle.mjs'));
      fs.writeFileSync(path.join(dir, 'judge.mjs'), source.replace(from, to));
      const mutant = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, 'judge.mjs')).href);
      const killer = ordered.find(check => {
        try {
          check.run(mutant, 100);
          return false;
        } catch {
          return true;
        }
      });
      expect(killer?.name ?? 'no check failed').not.toBe('no check failed');
    });
  });
});
