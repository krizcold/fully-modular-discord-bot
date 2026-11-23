// The webhook deliveries this web UI process answered 200, per provider and event id, so a repeat is answered without
// running the op again. Memory only: what keeps a purchase from being applied twice is premium's own repeat-safety.

const KEEP_MS = 4 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const answered = new Map<string, number>();

const keyOf = (providerId: string, eventId: string): string => `${providerId}\u0000${eventId}`;

function dropExpired(now: number): void {
  for (const [key, at] of answered) {
    if (now - at < KEEP_MS) break;
    answered.delete(key);
  }
}

export function webhookDeliveryAnswered(providerId: string, eventId: string): boolean {
  const now = Date.now();
  dropExpired(now);
  const at = answered.get(keyOf(providerId, eventId));
  return at !== undefined && now - at < KEEP_MS;
}

export function recordWebhookDelivery(providerId: string, eventId: string): void {
  const now = Date.now();
  const key = keyOf(providerId, eventId);
  answered.delete(key);
  answered.set(key, now);
  dropExpired(now);
  while (answered.size > MAX_ENTRIES) {
    const oldest = answered.keys().next().value as string;
    answered.delete(oldest);
  }
}

export function _resetWebhookDeliveries(): void {
  answered.clear();
}
