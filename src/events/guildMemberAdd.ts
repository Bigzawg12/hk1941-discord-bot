import { Events } from 'discord.js';
import { syncMember } from '../linking/memberSync.js';
import { defineEvent } from '../types.js';

/** With AUTO_UPDATE_ON_JOIN (and the Server Members Intent), linked members get their roles on joining. */
export default defineEvent({
  name: Events.GuildMemberAdd,
  async execute(services, member) {
    if (!services.config.linking.autoUpdateOnJoin || member.user.bot) return;
    try {
      await syncMember(services, member.client, member.guild.id, member.id, 'Joined the server');
    } catch (err) {
      services.logger.warn({ err, guildId: member.guild.id, user: member.id }, 'could not update a new member');
    }
  },
});
