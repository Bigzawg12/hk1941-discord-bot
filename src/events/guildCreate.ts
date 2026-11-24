import { Events } from 'discord.js';
import { defineEvent } from '../types.js';

export default defineEvent({
  name: Events.GuildCreate,
  execute(services, guild) {
    services.logger.info({ guildId: guild.id, name: guild.name, members: guild.memberCount }, 'added to a server; staff there should run /setup');
  },
});
