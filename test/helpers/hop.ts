import net from 'net';

/**
 * What the hop does with the next COMMIT a client sends (NB13 test file 3):
 * 'drop-answer' forwards it, drops the server's answer, then cuts both sides;
 * 'drop-commit' drops it and cuts both sides;
 * 'drop-keep-server' drops it and cuts only the client side, so the server session stays open until its idle timeout;
 * 'hold' forwards it after holdMs while new connections pass.
 */
export type CommitMode = 'drop-answer' | 'drop-commit' | 'drop-keep-server' | 'hold';

const COMMIT = Buffer.from('COMMIT\0');

function isCommit(chunk: Buffer): boolean {
  for (let i = chunk.indexOf(0x51); i >= 0; i = chunk.indexOf(0x51, i + 1)) {
    if (i + 5 + COMMIT.length <= chunk.length && chunk.subarray(i + 5, i + 5 + COMMIT.length).equals(COMMIT)) return true;
  }
  return false;
}

/** A TCP hop in front of the container that can drop the traffic of every connection, cut them all, or act on a COMMIT. */
export class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private cut = false;
  private armed: { mode: CommitMode; holdMs: number; seen: () => void } | null = null;
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Bytes in both directions are dropped, so a query sent now never reaches the store. */
  stall(): void {
    this.stalled = true;
  }

  /** Every open connection is destroyed, and new ones are refused until restore. */
  cutAll(): void {
    this.cut = true;
    for (const socket of this.sockets) socket.destroy();
  }

  restore(): void {
    this.stalled = false;
    this.cut = false;
  }

  /** Acts on the next COMMIT any connection sends; the promise settles when that COMMIT reached the hop. */
  armCommit(mode: CommitMode, holdMs = 0): Promise<void> {
    return new Promise(resolve => { this.armed = { mode, holdMs, seen: resolve }; });
  }

  close(): Promise<void> {
    this.cutAll();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    if (this.cut) {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    let answerDropped = false;
    let keepServer = false;
    this.sockets.add(client);
    this.sockets.add(upstream);
    client.on('data', chunk => {
      if (this.stalled) return;
      const armed = this.armed;
      if (armed && isCommit(chunk)) {
        this.armed = null;
        armed.seen();
        if (armed.mode === 'drop-answer') {
          answerDropped = true;
          upstream.write(chunk);
          setTimeout(() => { client.destroy(); upstream.destroy(); }, 200);
        } else if (armed.mode === 'drop-commit') {
          client.destroy();
          upstream.destroy();
        } else if (armed.mode === 'drop-keep-server') {
          keepServer = true;
          this.sockets.delete(upstream);
          client.destroy();
        } else {
          setTimeout(() => { if (!upstream.destroyed) upstream.write(chunk); }, armed.holdMs);
        }
        return;
      }
      upstream.write(chunk);
    });
    upstream.on('data', chunk => { if (!this.stalled && !answerDropped && !client.destroyed) client.write(chunk); });
    client.on('close', () => {
      this.sockets.delete(client);
      if (!keepServer) upstream.destroy();
    });
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  }
}
