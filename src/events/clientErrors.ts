import { Events } from 'discord.js';
import { defineEvent } from '../types.js';

/** discord.js reports websocket and REST problems here; log them instead of crashing. */
export default defineEvent({
  name: Events.Error,
  execute(services, error) {
    services.logger.error({ err: error }, 'discord client error');
  },
});
