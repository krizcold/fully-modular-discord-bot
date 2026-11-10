import { describe, expect, it } from 'vitest';
import { latchWords } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB24 section 8 test 6: the latch words of a tie in the switch notices.

describe('NB24 test 6: latchWords with machines', () => {
  it('a tie cause with two machines names the count, the generation and the machines', () => {
    expect(latchWords({ kind: 'tie', generation: 3, machines: ['A', 'B'] }, 'a:5432/bot'))
      .toBe("can't confirm that a:5432/bot is still the main (2 machines announced generation 3: A and B)");
  });

  it('a behind-notice cause with three machines names them all', () => {
    expect(latchWords({ kind: 'behind-notice', machine: 'A', generation: 5, machines: ['A', 'B', 'C'] }, 'a:5432/bot'))
      .toBe("can't confirm that a:5432/bot is still the main (3 machines announced generation 5: A, B and C)");
  });

  it("with one machine or none, today's text of each", () => {
    for (const machines of [undefined, ['B']]) {
      expect(latchWords({ kind: 'tie', generation: 2, ...(machines ? { machines } : {}) }, 'a:5432/bot'))
        .toBe("can't confirm that a:5432/bot is still the main (another database accepts writes at generation 2)");
      expect(latchWords({ kind: 'behind-notice', machine: 'B', generation: 2, ...(machines ? { machines } : {}) }, 'a:5432/bot'))
        .toBe("can't confirm that a:5432/bot is still the main (generation 2 was announced for B)");
    }
  });
});
