import { Client, ClientApplication, Routes } from 'discord.js';

/**
 * The bot application, from the gateway READY when this node had one, else
 * fetched through REST (a node holding no shard never receives READY).
 * Null when it cannot be resolved; the caller reports that it did nothing.
 */
export async function resolveClientApplication(client: Client): Promise<ClientApplication | null> {
  if (client.application) return client.application;
  try {
    const data = await client.rest.get(Routes.currentApplication());
    if (!client.application) {
      (client as any).application = new (ClientApplication as any)(client, data);
    }
    return client.application;
  } catch (err) {
    console.error('[Commands] Could not resolve the bot application through REST:', err instanceof Error ? err.message : err);
    return null;
  }
}
