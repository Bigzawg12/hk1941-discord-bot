import { Events } from 'discord.js';
import { defineEvent } from '../types.js';

/** A synced event was deleted in Discord: cancel it in game if staff did it. */
export default defineEvent({
  name: Events.GuildScheduledEventDelete,
  async execute(services, ev) {
    await services.eventSync.onDiscordCancel(ev);
  },
});
