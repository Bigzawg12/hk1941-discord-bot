import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './loaders/commands.js';
import { loadEvents } from './loaders/events.js';
import { createLogger } from './logger.js';
import { createServices } from './services.js';
import { ConfigError } from './util/errors.js';
import { createDashboard } from './web/server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, 'bot');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message + '\n\nCopy .env.example to .env and fill it in (see README).');
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.log.level, config.log.pretty);
  const services = createServices(config, logger);
  services.commands = await loadCommands();

  // No privileged intents by default (member roles come with each interaction). AUTO_UPDATE_ON_JOIN
  // adds Server Members, which must also be switched on in the Developer Portal.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents];
  if (config.linking.autoUpdateOnJoin) intents.push(GatewayIntentBits.GuildMembers);
  const client = new Client({
    intents,
    partials: [Partials.GuildMember, Partials.GuildScheduledEvent],
  });
  const events = await loadEvents(client, services);
  logger.info({ commands: [...services.commands.keys()], events }, 'loaded');

  let dashboard: ReturnType<typeof createDashboard> | undefined;
  if (config.web.enabled) {
    dashboard = createDashboard({ services, client: () => (client.isReady() ? client : null) });
    const port = await dashboard.listen();
    logger.info({ url: config.web.publicUrl, host: config.web.host, port, admins: config.web.adminIds.length }, 'dashboard listening');
  } else {
    logger.info('dashboard off (set DISCORD_CLIENT_SECRET and SESSION_SECRET to turn it on)');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    services.eventSync.stop();
    await dashboard?.close();
    await client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

  await client.login(config.discord.token);
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
