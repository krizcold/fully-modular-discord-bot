// P1's log guard (sheet P1, claim 23). Premium logs L1 when a load leaves stored entries out, L2 when an event names
// no holder and L3 when a created event is not installed. A row that logs one of them without expecting it has lost
// its seed, and would pass because the store is empty; the guard fails that row. It watches as well the line handleEvent
// logs when an install threw (a created event lost to an error, with nothing stored). A row that expects such a line
// calls allowDropLines() first, naming 'install' for the last one.
//
// The guard stands in front of console itself, so it sees a line whether or not the row replaced the method with a
// spy that swallows it: the global console is a proxy whose log methods read the line, then call what the row put
// there.

export type DropLine = 'L1' | 'L2' | 'L3' | 'install';

const PATTERNS: Record<DropLine, RegExp> = {
  L1: /^\[PremiumManager\] (premium-tiers\.json|The configuration given to setFullConfig) holds entries this version does not read:/,
  L2: /^\[PremiumManager\] A \S+ event from .+ names no holder; it was not applied:/,
  L3: /^\[PremiumManager\] subscription\.created from .+ was not installed:/,
  install: /^\[PremiumManager\] installAsyncSubscription failed:/,
};
/** What allowDropLines() with no name lets through: a failed install is opted in to by name only. */
const UNNAMED: DropLine[] = ['L1', 'L2', 'L3'];
const METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);

interface GuardState {
  allowed: Set<DropLine>;
  seen: Array<{ kind: DropLine; line: string }>;
  /** Every line of a kind the row logged, allowed or not. */
  all: Array<{ kind: DropLine; line: string }>;
  depth: number;
  installed: boolean;
}
// On the process, as vi.resetModules gives a test a second copy of this module.
const KEY = Symbol.for('smdb.p1Guard');
const holder = globalThis as Record<PropertyKey, unknown>;
const state = (holder[KEY] ??= { allowed: new Set<DropLine>(), seen: [], all: [], depth: 0, installed: false }) as GuardState;

/** The row expects these lines (L1 to L3 when none is named): the guard lets them pass until the row ends. */
export function allowDropLines(...kinds: DropLine[]): void {
  for (const kind of kinds.length > 0 ? kinds : UNNAMED) state.allowed.add(kind);
}

/** The lines of this kind the row logged so far, through whatever spy it put on console. */
export function droppedLines(kind: DropLine): string[] {
  return state.all.filter(s => s.kind === kind).map(s => s.line);
}

function note(args: unknown[]): void {
  let line: string;
  try { line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' '); } catch { return; }
  for (const kind of Object.keys(PATTERNS) as DropLine[]) {
    if (!PATTERNS[kind].test(line)) continue;
    state.all.push({ kind, line });
    if (!state.allowed.has(kind)) state.seen.push({ kind, line });
  }
}

/** Puts the proxy in front of console and registers the two hooks; setup.ts calls it once per test file. */
export function installDropLineGuard(beforeEach: (fn: () => void) => void, afterEach: (fn: () => void) => void): void {
  if (!state.installed) {
    state.installed = true;
    const real = globalThis.console;
    const fronts = new WeakMap<object, (...args: unknown[]) => unknown>();
    const backs = new WeakMap<object, unknown>();
    const frontOf = (fn: (...args: unknown[]) => unknown): unknown => {
      let front = fronts.get(fn);
      if (!front) {
        // A proxy, so a spy keeps its mock state and its matchers when read back from console.
        front = new Proxy(fn, {
          apply(target, self, args: unknown[]) {
            if (state.depth === 0) note(args);
            state.depth += 1;
            try { return Reflect.apply(target, self === proxy ? real : self, args); } finally { state.depth -= 1; }
          },
        });
        fronts.set(fn, front);
        backs.set(front, fn);
      }
      return front;
    };
    const unwrap = (value: unknown): unknown => (typeof value === 'function' && backs.has(value) ? backs.get(value) : value);
    const proxy: Console = new Proxy(real, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        return typeof prop === 'string' && METHODS.has(prop) && typeof value === 'function' ? frontOf(value) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, unwrap(value), target);
      },
      defineProperty(target, prop, descriptor) {
        return Reflect.defineProperty(target, prop, 'value' in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor);
      },
    });
    globalThis.console = proxy;
  }
  beforeEach(() => {
    state.allowed.clear();
    state.seen.length = 0;
    state.all.length = 0;
  });
  afterEach(() => {
    const seen = state.seen.splice(0);
    state.all.length = 0;
    state.allowed.clear();
    if (seen.length > 0) {
      throw new Error(`This row logged ${seen.length} line(s) that say premium left stored entries out, dropped an event or failed an install (${[...new Set(seen.map(s => s.kind))].join(', ')}); a row that expects them calls allowDropLines() first. First line: ${seen[0].line}`);
    }
  });
}
