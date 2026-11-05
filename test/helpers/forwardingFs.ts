// The source reads 'fs' through a module namespace, which cannot be spied on. A test file that stubs a sync fs call
// mocks 'fs' with this, so each sync function forwards to the default export's current property and vi.spyOn(fs, ...)
// reaches the source:
//   vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
// It imports nothing, so the mock factory never waits on 'fs' itself.

export const REAL_FS = Symbol.for('nb12.realFs');

export function forwardingFs(real: any): any {
  const target: any = { ...real, [REAL_FS]: real };
  const busy = new Set<string>();
  const out: any = { ...real };
  for (const fn of Object.keys(real)) {
    if (!fn.endsWith('Sync') || typeof real[fn] !== 'function') continue;
    const forwarder = (...args: unknown[]) => {
      const current = target[fn];
      if (current === forwarder || busy.has(fn)) return real[fn](...args);
      busy.add(fn);
      try {
        return current(...args);
      } finally {
        busy.delete(fn);
      }
    };
    target[fn] = forwarder;
    out[fn] = forwarder;
  }
  out.default = target;
  return out;
}
