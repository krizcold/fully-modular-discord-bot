import { Client, Guild } from 'discord.js';
import { getMetricsCollector } from '../../utils/metrics/metricsCollector';

export default async function (client: Client, guild: Guild) {
  const collector = getMetricsCollector();
  collector.dropGuild(guild.id);
  collector.dropGuildPersisted(guild.id);
}
