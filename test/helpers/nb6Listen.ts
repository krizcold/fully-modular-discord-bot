import { EventEmitter } from 'events';

// A listening client as sharedListener.ts uses node-pg's: connect, LISTEN and SELECT 1 queries, 'notification',
// 'error' and 'end' events, end() and a socket to destroy. Each connect takes the next answer of the plan ('ok' by
// default, an Error, or 'hang' for one that never answers); each query answers by the client's own script.

type Step = 'ok' | Error | 'hang';

export class FakeListenClient extends EventEmitter {
  readonly queries: string[] = [];
  ended = false;
  destroyed = false;
  /** A query's answer: undefined answers at once, an Error rejects, 'hang' never answers. */
  answer: (text: string) => Step | undefined = () => undefined;
  readonly connection: { stream: { remoteAddress?: string; destroy: () => void } };

  /** remoteAddress: the peer the connected socket reports (NB15 decision 21); unset when none is known. */
  constructor(readonly config: Record<string, unknown>, private readonly connectStep: Step, remoteAddress?: string) {
    super();
    this.connection = { stream: { remoteAddress, destroy: () => { this.destroyed = true; } } };
  }

  connect(): Promise<void> {
    if (this.connectStep === 'hang') return new Promise(() => undefined);
    if (this.connectStep instanceof Error) return Promise.reject(this.connectStep);
    return Promise.resolve();
  }

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    const step = this.answer(text);
    if (step === 'hang') return new Promise(() => undefined);
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }

  notify(channel: string, payload: string): void {
    this.emit('notification', { channel, payload });
  }
}

export function listenRig() {
  const clients: FakeListenClient[] = [];
  const plan: Step[] = [];
  /** The peer of each next client, in order; none known once it runs out. */
  const peers: string[] = [];
  return {
    clients,
    plan,
    peers,
    factory: (config: Record<string, unknown>) => {
      const client = new FakeListenClient(config, plan.shift() ?? 'ok', peers.shift());
      clients.push(client);
      return client;
    },
    last: () => clients[clients.length - 1],
  };
}
