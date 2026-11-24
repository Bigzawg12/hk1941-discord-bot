import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './loaders/commands.js';
import { ConfigError } from './util/errors.js';

/**
 * Registers the slash commands with Discord.
 *   npm run deploy-commands            -> to DISCORD_GUILD_ID (instant), or globally if it isn't set
 *   npm run deploy-commands -- --global -> globally (can take up to an hour to appear)
 *   npm run deploy-commands -- --clear  -> remove them (guild, or global with --global)
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  let config;
  try {
    config = loadConfig(process.env, 'deploy');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const commands = await loadCommands();
  const body = args.has('--clear') ? [] : [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const global = args.has('--global') || !config.discord.guildId;
  const route = global
    ? Routes.applicationCommands(config.discord.clientId)
    : Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId!);
  const result = (await rest.put(route, { body })) as unknown[];
  console.log(`${args.has('--clear') ? 'Cleared' : 'Registered'} ${result.length} command(s) ${global ? 'globally' : `in guild ${config.discord.guildId}`}.`);
  if (!args.has('--clear')) console.log(body.map((c) => `/${c.name}`).join('  '));
}

main().catch((err: unknown) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
