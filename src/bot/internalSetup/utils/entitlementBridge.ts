import type { Client } from 'discord.js';
import { getPaymentRegistry } from './payment/paymentRegistry';
import { runEntitlementEvent } from './maintenanceGate';

type Bridged = { attachGatewayBridge?: (attach: (event: string, handler: (payload: any) => void) => void) => void };

/** Both boots' Discord payment bridge: each entitlement event's handler runs where its writes pass a save order's refusal (NX5 decision 10). */
export function attachEntitlementBridge(client: Client): void {
  const discord = getPaymentRegistry().get('discord') as Bridged | undefined;
  discord?.attachGatewayBridge?.((eventName, handler) => { client.on(eventName as any, (payload: any) => runEntitlementEvent(() => handler(payload))); });
}
