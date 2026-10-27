import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function cardSource(): string {
  const src = read('webui/public/components/usage/FleetView.jsx');
  const start = src.indexOf('function FleetEpisodeCard');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\nfunction ', start + 10));
}

describe('A23-4 episode card window start', () => {
  it('the master side words its since-when as when it first saw the stand-in holding', () => {
    const card = cardSource();
    expect(card).toMatch(/e\.side === 'master'/);
    expect(card).toMatch(/first saw \$\{standIn\} standing in/);
  });

  it('the master side names the stand-in again in the second clause', () => {
    const card = cardSource();
    expect(card).toMatch(/at \$\{at\(e\.standInSince\)\}, and \$\{standIn\} stood in/);
    expect(card).not.toMatch(/, and it stood in/);
  });

  it('the stand-in side keeps "stood in ... from"', () => {
    expect(cardSource()).toMatch(/\$\{standIn\} stood in for \$\{covering\} from \$\{at\(e\.standInSince\)\}/);
  });

});
