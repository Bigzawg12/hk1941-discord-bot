import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { COLOURS, ephemeral, esc } from '../discord/helpers.js';
import { describeSync, syncEverywhere } from '../linking/memberSync.js';
import { Tier } from '../permissions/tiers.js';
import { joinUrl } from '../posts/render.js';
import { field, modal } from '../posts/workflow.js';
import { profileUrl } from '../roblox/users.js';
import { defineCommand, type CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';

/**
 * Bloxlink-style verification, all inside Discord. Main way (GAME_VERIFY, on by default):
 *   /verify (or the Verify button on a panel) -> Join game -> type /verify in the game chat -> a private
 *   8-letter code appears on screen -> Enter code here -> linked. The code is made in game, so it proves the
 *   Roblox account, and it's typed in by the Discord account, so it proves that too.
 * Fallback (profile phrase):
 *   /verify (or the Verify button on a panel) -> "Enter my Roblox username" -> a phrase to put in
 *   the Roblox profile's About -> "Done" -> linked, and every server the bot shares with them gives
 *   the verified role, rank roles and nickname.
 */

const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(b);
const btn = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

/** The message posted by /setup verify-panel: anyone can press its button. */
export function verifyPanel(serverName: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLOURS.khaki)
        .setTitle(`Verify for ${serverName}`)
        .setDescription(
          [
            'Link your Roblox account to get your roles and nickname here.',
            '',
            '1. Press **Verify**.',
            '2. Join Hong Kong 1941 and type **/verify** in the chat. A code appears at the top of your screen.',
            '3. Press **Enter code** and type it in.',
            '',
            'Already linked? Press **Update** after a promotion to refresh your roles.',
          ].join('\n'),
        ),
    ],
    components: [row(btn('verify:begin', 'Verify', ButtonStyle.Success), btn('verify:update', 'Update'))],
  };
}

type Ctx = CommandContext<ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction>;

async function start(ctx: Ctx): Promise<void> {
  const { interaction, services } = ctx;
  const link = await services.links.get(interaction.user.id);
  if (link) {
    await interaction.reply({
      content: `You're linked to **${esc(link.robloxName)}** (${profileUrl(link.robloxId)}).`,
      components: [row(btn('verify:update', 'Update my roles', ButtonStyle.Primary), btn('verify:begin:new', 'Link a different account'))],
      ...ephemeral,
    });
    return;
  }
  await chooseWay(ctx);
}

/** How to verify: in game (main), or the profile phrase. */
async function chooseWay(ctx: Ctx): Promise<void> {
  const { interaction, services } = ctx;
  if (!services.links.gameLinking) return askUsername(ctx);
  const embed = new EmbedBuilder()
    .setColor(COLOURS.info)
    .setTitle('Verify in game')
    .setDescription(
      [
        '1. Join **Hong Kong 1941** with the Roblox account you want to link.',
        '2. Type **/verify** in the chat. A code appears at the top of your screen (only you can see it).',
        '3. Press **Enter code** here and type it in.',
        '',
        'Codes last 10 minutes. Never give yours to anyone.',
      ].join('\n'),
    );
  const buttons = [
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Hong Kong 1941').setURL(joinUrl(services.config.roblox.placeId)),
    btn('verify:code', 'Enter code', ButtonStyle.Success),
  ];
  if (services.links.codeLinking) buttons.push(btn('verify:begin:phrase', "Can't join? Use a profile phrase"));
  await interaction.reply({ embeds: [embed], components: [row(...buttons)], ...ephemeral });
}

async function askGameCode(ctx: CommandContext<ButtonInteraction>): Promise<void> {
  await ctx.interaction.showModal(
    modal('verify:gamecode', 'Enter your game code', [
      field('code', 'Code from the game (after typing /verify)', { required: true, max: 12, placeholder: 'QZTR KMPL' }),
    ]),
  );
}

async function checkGameCode(ctx: CommandContext<ModalSubmitInteraction>): Promise<void> {
  const { interaction, services } = ctx;
  await interaction.deferReply(ephemeral);
  let link;
  try {
    link = await services.links.verifyGameCode(interaction.user.id, interaction.fields.getTextInputValue('code'));
  } catch (err) {
    if (err instanceof UserFacingError) {
      await interaction.editReply({ content: err.message, components: [row(btn('verify:code', 'Enter code', ButtonStyle.Primary))] });
      return;
    }
    throw err;
  }
  await linked(ctx, link);
}

/** After any successful link: roles everywhere, audit, and the reply. */
async function linked(ctx: CommandContext<ButtonInteraction | ModalSubmitInteraction>, link: { robloxId: number; robloxName: string; method: string }): Promise<void> {
  const { interaction, services } = ctx;
  services.permissions.forget(interaction.user.id);
  const results = await syncEverywhere(services, interaction.client, interaction.user.id, `Verified as Roblox ${link.robloxName} (${link.robloxId})`);
  await services.audit.record({
    actorId: interaction.user.id,
    actorName: interaction.user.username,
    action: 'Account linked',
    target: `${link.robloxName} (${link.robloxId})`,
    detail: `Method: ${link.method}`,
    ok: true,
    guildId: interaction.guildId,
  });
  const summary = describeSync(results);
  await interaction.editReply({
    content: `✅ Verified as **${esc(link.robloxName)}**.${summary ? `\n${summary}` : ''}`,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function askUsername(ctx: Ctx): Promise<void> {
  const { interaction, services } = ctx;
  if (!services.links.codeLinking) {
    const name = services.links.mode === 'bloxlink' ? 'Bloxlink' : 'RoVer';
    await interaction.reply({ content: `This bot links through ${name}. Verify with ${name} first, then press Done.`, components: [row(btn('verify:check', 'Done', ButtonStyle.Success))], ...ephemeral });
    return;
  }
  if (interaction.isModalSubmit()) throw new UserFacingError('Press Verify again.');
  await interaction.showModal(modal('verify:username', 'Verify with Roblox', [field('username', 'Your Roblox username', { required: true, max: 20, placeholder: 'e.g. Maj_Test' })]));
}

async function giveCode(ctx: CommandContext<ModalSubmitInteraction>): Promise<void> {
  const { interaction, services } = ctx;
  await interaction.deferReply(ephemeral);
  const name = interaction.fields.getTextInputValue('username').trim();
  const user = await services.users.resolve(name);
  if (!user) throw new UserFacingError(`No Roblox user called "${name.slice(0, 40)}". Check the spelling and press Verify again.`);
  const taken = await services.links.findByRoblox(user.id);
  if (taken && taken.discordId !== interaction.user.id) throw new UserFacingError(`${user.name} is already linked to another Discord account. Ask staff if that's wrong.`);
  const { code, expiresInMin } = await services.links.start(interaction.user.id, user);
  const embed = new EmbedBuilder()
    .setColor(COLOURS.info)
    .setTitle(`Verify ${user.name}`)
    .setURL(profileUrl(user.id))
    .setDescription(
      [
        `1. Open your Roblox profile: ${profileUrl(user.id)}`,
        '2. Edit **About**, paste this phrase anywhere in it, and save:',
        `\`\`\`\n${code}\n\`\`\``,
        '3. Press **Done** below.',
        '',
        `The phrase works for ${expiresInMin} minutes. You can remove it once you're verified.`,
      ].join('\n'),
    );
  await interaction.editReply({ embeds: [embed], components: [row(btn('verify:check', 'Done', ButtonStyle.Success), btn('verify:cancel', 'Cancel'))] });
}

async function check(ctx: CommandContext<ButtonInteraction>): Promise<void> {
  const { interaction, services } = ctx;
  await interaction.deferUpdate();
  let link;
  try {
    link = await services.links.verify(interaction.user.id, interaction.guildId);
  } catch (err) {
    if (err instanceof UserFacingError) {
      await interaction.followUp({ content: err.message, ...ephemeral });
      return;
    }
    throw err;
  }
  await linked(ctx, link);
}

/** Refresh roles and nickname; for yourself, or (staff) for someone else. */
async function update(ctx: Ctx, discordId: string): Promise<void> {
  const { interaction, services } = ctx;
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply(ephemeral);
  const self = discordId === interaction.user.id;
  const link = await services.links.get(discordId);
  if (self && !link) {
    await interaction.editReply({ content: "You aren't verified yet.", components: [row(btn('verify:begin', 'Verify', ButtonStyle.Success))] });
    return;
  }
  const results = await syncEverywhere(services, interaction.client, discordId, self ? 'Update requested' : `Update by ${interaction.user.username}`);
  const here = results.find((r) => r.guildId === interaction.guildId);
  const who = self ? 'Your' : `<@${discordId}>'s`;
  await interaction.editReply({
    content: `${who} roles are up to date${link ? ` (Roblox: **${esc(link.robloxName)}**)` : ' (not linked)'}.\n${describeSync(here ? [here, ...results.filter((r) => r !== here)] : results) || 'They are not in any server with me.'}`,
    allowedMentions: { parse: [] },
  });
}

export default defineCommand({
  tier: Tier.Everyone,
  help: 'Link your Roblox account by typing /verify in the game (gets your roles and nickname), or update them.',
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Roblox account to get your roles and nickname')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx) {
    await start(ctx);
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const [, action, extra] = ctx.interaction.customId.split(':');
    if (action === 'begin') return extra === 'new' ? chooseWay(ctx) : extra === 'phrase' ? askUsername(ctx) : start(ctx);
    if (action === 'code') return askGameCode(ctx);
    if (action === 'check') return check(ctx);
    if (action === 'update') return update(ctx, ctx.interaction.user.id);
    if (action === 'cancel') {
      await ctx.interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
    }
  },

  async modal(ctx: CommandContext<ModalSubmitInteraction>) {
    if (ctx.interaction.customId === 'verify:username') return giveCode(ctx);
    if (ctx.interaction.customId === 'verify:gamecode') return checkGameCode(ctx);
  },
});

export { update as runUpdate };
