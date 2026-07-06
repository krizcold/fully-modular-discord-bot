import { Client, Guild } from 'discord.js';
import { getMetricsCollector } from '../../utils/metrics/metricsCollector';

export default async function (client: Client, guild: Guild) {
  getMetricsCollector().dropGuild(guild.id);
}
