import { Events } from 'discord.js';
import { defineEvent } from '../types.js';

/** Staff made an event in a server's Events tab: copy it into the game (see src/sync/eventSync.ts). */
export default defineEvent({
  name: Events.GuildScheduledEventCreate,
  async execute(services, ev) {
    await services.eventSync.onDiscordCreate(ev);
  },
});
