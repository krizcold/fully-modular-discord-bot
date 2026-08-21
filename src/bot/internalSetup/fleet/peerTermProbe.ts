// Pre-register term probe for the stale-master boot fence (PLAN_REPLICATION
// Stage 4). Asks a master candidate two questions - who are you, what term do
// you hold - and answers null for every failure mode, because a silent peer is
// not evidence.
//
// It never registers. Registering would enroll a node that is about to park as
// a worker of the live master, which then grants it shards: the two-masters-on
// -one-token failure this fence exists to prevent. The peer answers ahead of
// its term fencing, since the prober's term is the very thing in question.
//
// The identity in the reply is load-bearing, not diagnostic. A booting node
// dials its own advertised URL whenever FLEET_PUBLIC_URL is unset, and a
// restarting node's predecessor can still hold the control port while it
// drains, so without an attributable answer a node can park on its own echo.

import { WebSocket } from 'ws';
import { ControlEnvelope, MSG } from './protocol';

export interface PeerTerm {
  nodeId: string;
  term: number;
}

/**
 * Resolves the candidate's identity and term, or null when neither can be
 * established (dead host, wrong secret, silence, malformed reply). Never
 * throws, never leaves a socket behind: the peer has no idle reaper for
 * unregistered sockets.
 */
export function probePeerTerm(url: string, secret: string, timeoutMs: number): Promise<PeerTerm | null> {
  return new Promise<PeerTerm | null>(resolve => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { 'x-control-secret': secret }, handshakeTimeout: timeoutMs });
    } catch {
      resolve(null);
      return;
    }

    const requestId = `term-probe_${Date.now()}_${Math.random()}`;
    let settled = false;
    const finish = (peer: PeerTerm | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(peer);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already closing */ }
      finish(null);
    }, timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: MSG.TERM_PROBE, requestId, data: {} }));
      } catch {
        finish(null);
      }
    });
    ws.on('message', raw => {
      let message: ControlEnvelope;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.requestId !== requestId || message.type !== undefined) return;
      const term = Number(message.data?.term);
      const nodeId = message.data?.nodeId;
      // An unattributable answer is treated as silence: a peer that cannot say
      // who it is cannot be told apart from this node's own echo.
      finish(Number.isFinite(term) && typeof nodeId === 'string' && nodeId !== '' ? { nodeId, term } : null);
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}
