import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { COLOURS, ephemeral, esc, resolveRobloxTarget } from '../discord/helpers.js';
import { standing } from '../game/points.js';
import { assignable, changeRank, discordNote, rankGuard } from '../game/promotions.js';
import { Tier } from '../permissions/tiers.js';
import { profileUrl } from '../roblox/users.js';
import { defineCommand, type CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import type { ButtonInteraction } from 'discord.js';

/**
 * Promotion workflow on the army group (409406376) through Open Cloud:
 * /promote shows current rank -> new rank with their points standing, and asks for confirmation;
 * the Confirm button changes the role. Only the person who asked can confirm.
 */

export default defineCommand({
  tier: Tier.Administrator,
  help: 'Change someone\'s army group rank (asks for confirmation, shows their points standing).',
  data: new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Change a soldier\'s rank in the army group')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('rank').setDescription('New rank').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('For the audit log').setMaxLength(200)),

  async autocomplete(interaction, services) {
    const typed = interaction.options.getFocused().toLowerCase();
    const roles = await services.groups.listRoles(services.config.roblox.armyGroupId);
    await interaction.respond(
      assignable(roles)
        .filter((r) => `${r.rank} ${r.name}`.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((r) => ({ name: `${r.rank} · ${r.name}`.slice(0, 100), value: String(r.id) })),
    );
  },

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply(ephemeral);
    const group = services.config.roblox.armyGroupId;
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const roles = await services.groups.listRoles(group);
    const pick = interaction.options.getString('rank', true);
    const role = roles.find((r) => String(r.id) === pick) ?? roles.find((r) => r.name.toLowerCase() === pick.toLowerCase());
    if (!role) throw new UserFacingError('Pick a rank from the list.');
    const current = await services.groups.rankIn(group, user.id, { fresh: true });
    if (current.rank === 0) throw new UserFacingError(`${user.name} isn't in the army group. They need to join it first.`);
    if (current.roleId === role.id) throw new UserFacingError(`${user.name} is already ${role.name}.`);
    await rankGuard(services, { robloxId: ctx.caller.robloxId, tier: ctx.caller.tier }, current.rank, role.rank);

    const profile = await services.profiles.get(user.id);
    const st = profile ? standing(profile.data, current.rank) : null;
    const reason = interaction.options.getString('reason')?.trim() ?? '';
    const embed = new EmbedBuilder()
      .setColor(role.rank > current.rank ? COLOURS.ok : COLOURS.warn)
      .setTitle(`${role.rank > current.rank ? 'Promote' : 'Change rank of'} ${user.name}?`)
      .setURL(profileUrl(user.id))
      .setDescription(`**${esc(current.roleName)}** (${current.rank}) → **${esc(role.name)}** (${role.rank})${reason ? `\nReason: ${esc(reason)}` : ''}`)
      .addFields({
        name: 'Points record',
        value: !st
          ? 'No service record yet.'
          : st.next
            ? `${st.points} pts · ${st.next.haveTrainings} trainings · next on the record: ${st.next.next} (${st.next.points} pts, ${st.next.trainings} trainings)${st.eligible ? ' · ✅ eligible' : ' · not yet eligible'}`
            : `${st.points} pts · past the points ladder (selection).`,
      });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`promote:yes:${user.id}:${role.id}:${interaction.user.id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`promote:no:${user.id}:${role.id}:${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const { interaction, services } = ctx;
    const [, choice, userIdS, roleIdS, requester] = interaction.customId.split(':');
    if (requester !== interaction.user.id) {
      await interaction.reply({ content: 'Only the person who asked can confirm this.', ...ephemeral });
      return;
    }
    if (choice !== 'yes') {
      await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
      return;
    }
    await interaction.deferUpdate();
    const change = await changeRank(services, {
      client: interaction.client,
      userId: Number(userIdS),
      roleId: Number(roleIdS),
      actor: { robloxId: ctx.caller.robloxId, tier: ctx.caller.tier },
      audit: { actorId: interaction.user.id, actorName: `${interaction.user.username}${ctx.caller.robloxName ? ` / ${ctx.caller.robloxName}` : ''}`, guildId: interaction.guildId },
    });
    await interaction.editReply({ content: `✅ ${esc(change.user?.name ?? userIdS ?? '')} is now **${esc(change.to.name)}**. ${discordNote(change)} (In game it shows after they rejoin.)`, embeds: [], components: [] });
  },
});
