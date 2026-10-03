// The planned transfer's handover sender (B4f-4, file mode): a one-shot
// socket to the master, like the step-down notice, because a master that
// handed over drops every worker and refuses their registrations, and the
// backup whose answer was lost asks again.

import { WebSocket } from 'ws';
import { ControlEnvelope, MSG, TransferHandoverReply, TransferHandoverRequest } from './protocol';

/** The master's answer, or null when none arrived (dead host, wrong secret, silence, malformed reply). Never throws. */
export function requestHandover(url: string, secret: string, payload: TransferHandoverRequest, timeoutMs: number): Promise<TransferHandoverReply | null> {
  return new Promise<TransferHandoverReply | null>(resolve => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { 'x-control-secret': secret }, handshakeTimeout: timeoutMs });
    } catch {
      resolve(null);
      return;
    }
    const requestId = `transfer-handover_${Date.now()}_${Math.random()}`;
    let settled = false;
    const finish = (reply: TransferHandoverReply | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(reply);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already closing */ }
      finish(null);
    }, timeoutMs);
    ws.on('open', () => {
      try { ws.send(JSON.stringify({ type: MSG.TRANSFER_HANDOVER, requestId, data: payload })); } catch { finish(null); }
    });
    ws.on('message', raw => {
      let message: ControlEnvelope;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message || typeof message !== 'object' || message.requestId !== requestId || message.type !== undefined) return;
      const data = message.data;
      finish(data && typeof data === 'object' && typeof data.ok === 'boolean' ? data as TransferHandoverReply : null);
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}
