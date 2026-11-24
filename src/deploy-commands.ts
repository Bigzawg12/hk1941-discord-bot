import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './loaders/commands.js';
import { ConfigError } from './util/errors.js';

/**
 * Registers the slash commands with Discord. The bot also does this itself on start
 * (REGISTER_COMMANDS=true), so you only need this script to clear them or to test.
 *   npm run deploy-commands                 -> globally: every server the bot is in
 *   npm run deploy-commands -- --guild <id> -> only in that server, instantly (for testing)
 *   npm run deploy-commands -- --clear      -> remove them (add --guild <id> to clear one server's test copy)
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const clear = argv.includes('--clear');
  const gi = argv.indexOf('--guild');
  const guildId = gi >= 0 ? argv[gi + 1] : undefined;
  if (gi >= 0 && !/^\d{15,25}$/.test(guildId ?? '')) {
    console.error('--guild needs a server ID, e.g. --guild 123456789012345678');
    process.exit(1);
  }
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
  const body = clear ? [] : [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, guildId)
    : Routes.applicationCommands(config.discord.clientId);
  const result = (await rest.put(route, { body })) as unknown[];
  console.log(`${clear ? 'Cleared' : 'Registered'} ${result.length} command(s) ${guildId ? `in server ${guildId} only` : 'globally'}.`);
  if (!clear) console.log(body.map((c) => `/${c.name}`).join('  '));
}

main().catch((err: unknown) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
