import { randomBytes } from 'node:crypto';
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ModalSubmitInteraction,
  RepliableInteraction,
} from 'discord.js';
import { requiredTier, TIER_NAMES } from '../permissions/tiers.js';
import type { Command, CommandContext, Services } from '../types.js';
import { RobloxApiError, UserFacingError } from '../util/errors.js';
import { ephemeral, memberRoleIds } from './helpers.js';

/** Route one interaction to its command, after the tier check. Never throws. */
export async function handleInteraction(services: Services, interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) return await runChatInput(services, interaction);
    if (interaction.isAutocomplete()) return await runAutocomplete(services, interaction);
    if (interaction.isButton()) return await runButton(services, interaction);
    if (interaction.isModalSubmit()) return await runModal(services, interaction);
  } catch (err) {
    // last resort: anything that escaped the per-type handlers
    services.logger.error({ err }, 'interaction dispatch failed');
  }
}

async function contextFor<I extends ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction>(
  services: Services,
  interaction: I,
): Promise<CommandContext<I>> {
  const caller = await services.permissions.resolve({
    discordId: interaction.user.id,
    roleIds: memberRoleIds(interaction.member),
    guildId: interaction.guildId,
  });
  return {
    interaction,
    services,
    caller,
    logger: services.logger.child({ user: interaction.user.id, tier: caller.tier }),
  };
}

function denied(command: Command, sub: string | null, need: number): string {
  const label = sub ? `/${command.data.name} ${sub}` : `/${command.data.name}`;
  return `${label} needs ${TIER_NAMES[need as 0]} (${need}) or above.`;
}

async function runChatInput(services: Services, interaction: ChatInputCommandInteraction): Promise<void> {
  const command = services.commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({ content: 'That command is no longer available.', ...ephemeral });
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this in the server.', ...ephemeral });
    return;
  }
  let ctx: CommandContext | undefined;
  try {
    ctx = await contextFor(services, interaction);
    const sub = interaction.options.getSubcommand(false);
    const need = requiredTier(command, sub, services.config.permissions.commandTiers);
    if (ctx.caller.tier < need) {
      await interaction.reply({ content: denied(command, sub, need), ...ephemeral });
      return;
    }
    await command.execute(ctx);
  } catch (err) {
    await reportError(services, interaction, err, `/${interaction.commandName}`);
  }
}

async function runAutocomplete(services: Services, interaction: AutocompleteInteraction): Promise<void> {
  const command = services.commands.get(interaction.commandName);
  if (!command?.autocomplete) return;
  try {
    await command.autocomplete(interaction, services);
  } catch (err) {
    services.logger.warn({ err, command: interaction.commandName }, 'autocomplete failed');
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
  }
}

async function runButton(services: Services, interaction: ButtonInteraction): Promise<void> {
  const name = interaction.customId.split(':')[0] ?? '';
  const command = services.commands.get(name);
  if (!command?.button) return;
  try {
    const ctx = await contextFor(services, interaction);
    const need = requiredTier(command, null, services.config.permissions.commandTiers);
    if (ctx.caller.tier < need) {
      await interaction.reply({ content: denied(command, null, need), ...ephemeral });
      return;
    }
    await command.button(ctx);
  } catch (err) {
    await reportError(services, interaction, err, `button ${name}`);
  }
}

async function runModal(services: Services, interaction: ModalSubmitInteraction): Promise<void> {
  const name = interaction.customId.split(':')[0] ?? '';
  const command = services.commands.get(name);
  if (!command?.modal) return;
  try {
    const ctx = await contextFor(services, interaction);
    const need = requiredTier(command, null, services.config.permissions.commandTiers);
    if (ctx.caller.tier < need) {
      await interaction.reply({ content: denied(command, null, need), ...ephemeral });
      return;
    }
    await command.modal(ctx);
  } catch (err) {
    await reportError(services, interaction, err, `form ${name}`);
  }
}

/** Tell the user what went wrong (briefly) and log the details with a reference they can quote. */
export async function reportError(services: Services, interaction: RepliableInteraction, err: unknown, where: string): Promise<void> {
  let text: string;
  if (err instanceof UserFacingError) {
    text = err.message;
  } else {
    const ref = randomBytes(3).toString('hex');
    services.logger.error({ err, where, ref }, 'command failed');
    text = err instanceof RobloxApiError ? `${err.describe()} (ref ${ref})` : `Something went wrong (ref ${ref}). Staff can find it in the bot log.`;
  }
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: text, ...ephemeral });
    else await interaction.reply({ content: text, ...ephemeral });
  } catch (replyErr) {
    services.logger.warn({ err: replyErr }, 'could not send the error reply');
  }
}
