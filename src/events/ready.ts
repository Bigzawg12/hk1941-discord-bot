import { ActivityType, Events } from 'discord.js';
import { defineEvent } from '../types.js';

export default defineEvent({
  name: Events.ClientReady,
  once: true,
  async execute(services, client) {
    services.audit.attach(client);
    client.user.setPresence({ activities: [{ name: 'Hong Kong 1941', type: ActivityType.Watching }], status: 'online' });
    services.logger.info(
      { user: client.user.tag, servers: client.guilds.cache.size, commands: services.commands.size },
      'bot ready',
    );
    if (!client.guilds.cache.size) services.logger.warn('the bot is not in any server yet; invite it with the link in the README');

    // Global commands work in every server the bot is in, so there is no server ID to set.
    // Re-sending an unchanged list is harmless; Discord only updates what changed.
    if (services.config.discord.registerCommands) {
      try {
        const body = [...services.commands.values()].map((c) => c.data.toJSON());
        const set = await client.application.commands.set(body);
        services.logger.info({ count: set.size }, 'slash commands registered globally');
      } catch (err) {
        services.logger.error({ err }, 'could not register the slash commands; run npm run deploy-commands');
      }
    }
  },
});
