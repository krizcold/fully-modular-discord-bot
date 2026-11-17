// NX5 ruling G8-14: the asynchronous work a core subsystem (premium, the Dummy provider) has open. Each piece is
// counted from its start until it wrote or gave up, with no bound of its own; the subsystem reports what is open
// through the held-saver interface, and a maintenance answer is not saved true while anything is.

export class OpenWork {
  private readonly open = new Map<object, string>();

  constructor(private readonly name: string) {}

  /** Counts a piece of work until `end` is called; calling it again does nothing. */
  begin(what: string): () => void {
    const key = {};
    this.open.set(key, what);
    return () => { this.open.delete(key); };
  }

  /** Counts the promise until it settles; answers it unchanged. */
  track<T>(what: string, work: Promise<T>): Promise<T> {
    const end = this.begin(what);
    work.then(end, end);
    return work;
  }

  /** Calls fn at once (its entry check runs now) and counts what it returns until it settles. */
  run<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
    let work: Promise<T>;
    try {
      work = Promise.resolve(fn());
    } catch (error) {
      work = Promise.reject(error);
    }
    return this.track(what, work);
  }

  size(): number {
    return this.open.size;
  }

  /** What is open, as "premium: 2 member notice(s) not sent yet, 1 ...", or null when nothing is. */
  words(): string | null {
    if (this.open.size === 0) return null;
    const counts = new Map<string, number>();
    for (const what of this.open.values()) counts.set(what, (counts.get(what) ?? 0) + 1);
    return `${this.name}: ${[...counts].map(([what, n]) => `${n} ${what}`).join(', ')}`;
  }
}
