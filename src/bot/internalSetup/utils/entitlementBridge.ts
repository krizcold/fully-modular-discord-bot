import type { Client } from 'discord.js';
import { getPaymentRegistry } from './payment/paymentRegistry';
import { runEntitlementEvent } from './maintenanceGate';

type Bridged = { attachGatewayBridge?: (attach: (event: string, handler: (payload: any) => void) => void) => void };

/**
 * Both boots' Discord payment bridge: each entitlement event's handler runs where its writes pass a save order's refusal
 * (NX5 decision 10). The handler gets the event's last argument: discord.js emits entitlementUpdate as (old | null, new).
 */
export function attachEntitlementBridge(client: Client): void {
  const discord = getPaymentRegistry().get('discord') as Bridged | undefined;
  discord?.attachGatewayBridge?.((eventName, handler) => { client.on(eventName as any, (...args: any[]) => runEntitlementEvent(() => handler(args[args.length - 1]))); });
}
