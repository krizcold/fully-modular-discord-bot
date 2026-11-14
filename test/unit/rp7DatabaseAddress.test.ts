import { describe, expect, it } from 'vitest';
import { showAddress, showEntry } from '../../src/utils/databaseAddress';

const NBSP = String.fromCharCode(0xa0);

describe('the display form of a database address', () => {
  it('names a missing address as an unknown address', () => {
    expect(showAddress(null)).toBe('an unknown address');
    expect(showAddress(undefined)).toBe('an unknown address');
  });

  it('shows an entry framed by non-breaking spaces as its address, which the URL parser alone refuses', () => {
    expect(showEntry(`${NBSP}postgresql://bot:pw@DB1:6432/bot${NBSP}`, 2)).toBe('db1:6432/bot');
  });
});
