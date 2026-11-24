import { Events } from 'discord.js';
import { handleInteraction } from '../discord/dispatch.js';
import { defineEvent } from '../types.js';

export default defineEvent({
  name: Events.InteractionCreate,
  execute: (services, interaction) => handleInteraction(services, interaction),
});
