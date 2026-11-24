import { ActivityType, Events } from 'discord.js';
import { defineEvent } from '../types.js';

export default defineEvent({
  name: Events.ClientReady,
  once: true,
  execute(services, client) {
    services.audit.attach(client);
    client.user.setPresence({ activities: [{ name: 'Hong Kong 1941', type: ActivityType.Watching }], status: 'online' });
    services.logger.info(
      { user: client.user.tag, guilds: client.guilds.cache.size, commands: services.commands.size },
      'bot ready',
    );
    const guildId = services.config.discord.guildId;
    if (guildId && !client.guilds.cache.has(guildId)) {
      services.logger.warn({ guildId }, 'DISCORD_GUILD_ID is set but the bot is not in that server; invite it (see README).');
    }
  },
});
