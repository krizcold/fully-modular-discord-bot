import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { mirrorRig } from '../helpers/nb6Mirror';

const m = mirrorRig('rp5docs');
const NAME = 'd.json';

beforeEach(async () => { await m.setup(); });
afterEach(async () => { await m.teardown(); });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
}

function deleteTicket(): RowTicket {
  const res = dm.deleteDataTracked(NAME, m.opts) as { ticket?: RowTicket };
  expect(res.ticket).toBeDefined();
  return res.ticket!;
}

const savedLine = (errno: string) => `[Shared] Saved ${m.keyOf(NAME)} in the database, but could not write ${m.file(NAME)} (${errno}); this machine keeps using the saved version and tries again`;

function failUnlink(value: unknown): void {
  const real = fs.promises.unlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'unlink').mockImplementation((async (p: fs.PathLike) => {
    if (String(p) === m.file(NAME)) throw value;
    return real(p);
  }) as typeof fs.promises.unlink);
}

describe('rp5: the flush mirror of a deleted shared doc (writeMirror)', () => {
  it('a mirror edited by hand is moved aside, the delete lands, and the line says nothing was put back (rp5-2, rp5-4, rp5-6)', async () => {
    await m.landed(NAME, { v: 1 });
    const ticket = deleteTicket();
    fs.writeFileSync(m.file(NAME), '{"edited":true}');
    await dm.flushAll();
    await until(() => ['landed', 'refused', 'unconfirmed'].includes(ticket.op.state), 'the delete to settle');
    expect(ticket.op.state).toBe('landed');
    const moved = m.state.lines.filter(line => line.startsWith(`[Shared] Moved ${m.file(NAME)} to `));
    expect(moved).toHaveLength(1);
    expect(moved[0].endsWith('; the database holds no such file, so nothing was put back')).toBe(true);
    expect(m.state.lines.filter(line => line.includes('could not write'))).toEqual([]);
    expect(Object.values(m.superseded())).toEqual(['{"edited":true}']);
    expect(m.read(NAME)).toBeNull();
    expect(m.entry(NAME)).toBeUndefined();
  });

  it('an unlink refused with EACCES keeps the delete pending on its mirror and logs the errno (rp5-1, rp5-2)', async () => {
    await m.landed(NAME, { v: 1 });
    failUnlink(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const ticket = deleteTicket();
    await dm.flushAll();
    await until(() => ticket.op.state === 'landed' || m.state.lines.some(line => line.includes('could not write')), 'the mirror step');
    expect(m.state.lines).toContain(savedLine('EACCES'));
    expect(ticket.op.state).toBe('mirror');
    expect(m.read(NAME)).not.toBeNull();
    expect(m.entry(NAME)).toBeDefined();
  });

  it('an unlink that rejects with a bare null is logged as null (rp5-3)', async () => {
    await m.landed(NAME, { v: 1 });
    failUnlink(null);
    const ticket = deleteTicket();
    await dm.flushAll();
    await until(() => ticket.op.state === 'landed' || m.state.lines.some(line => line.includes('could not write')), 'the mirror step');
    expect(m.state.lines).toContain(savedLine('null'));
    expect(ticket.op.state).toBe('mirror');
  });
});
