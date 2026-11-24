import { Events } from 'discord.js';
import { defineEvent } from '../types.js';

export default defineEvent({
  name: Events.Warn,
  execute(services, message) {
    services.logger.warn({ discord: message }, 'discord client warning');
  },
});
