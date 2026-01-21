import { Client, Guild } from 'discord.js';
import { isGuildBlacklisted } from '../../panels/systemInfo';

export default async function (client: Client, guild: Guild) {
  // Check if the guild is blacklisted
  if (isGuildBlacklisted(guild.id)) {
    console.log(`[Blacklist] Auto-leaving blacklisted guild: ${guild.name} (${guild.id})`);

    try {
      await guild.leave();
      console.log(`[Blacklist] Successfully left blacklisted guild: ${guild.name}`);
    } catch (error) {
      console.error(`[Blacklist] Failed to leave guild ${guild.name}:`, error);
    }
  }
}
