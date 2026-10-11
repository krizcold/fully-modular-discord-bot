// The Stryker options of each pass (mutation/README.md, "The passes"), beyond
// the mutate patterns and the concurrency touched.mjs gives them.
const BUILD = { buildCommand: 'node test/helpers/build.cjs', checkers: [], dryRunTimeoutMinutes: 15 };

export const PASSES = {
  a: { checkers: ['typescript'], timeoutMS: 10_000, timeoutFactor: 2 },
  a2: { checkers: [], concurrency: 1, timeoutMS: 60_000, timeoutFactor: 4 },
  b: { ...BUILD, timeoutMS: 60_000, timeoutFactor: 2 },
  // A pass B kill rerun with one file: an hour is above anything vitest's own
  // limits let that file take after its first failure (the rest of a child
  // test, then its hooks), so a rerun that fails always leaves its report.
  b2: { ...BUILD, concurrency: 1, timeoutMS: 60 * 60_000, timeoutFactor: 4 },
};
