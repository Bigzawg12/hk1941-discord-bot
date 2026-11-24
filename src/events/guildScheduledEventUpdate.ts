import { Events, GuildScheduledEventStatus } from 'discord.js';
import { defineEvent } from '../types.js';

/** "Cancel event" in Discord arrives as an update to Canceled. */
export default defineEvent({
  name: Events.GuildScheduledEventUpdate,
  async execute(services, _old, ev) {
    if (ev.status === GuildScheduledEventStatus.Canceled) await services.eventSync.onDiscordCancel(ev);
  },
});
