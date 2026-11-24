import { ChannelType, EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLOURS, ephemeral, esc } from '../discord/helpers.js';
import type { StaffTier } from '../guilds/settings.js';
import { Tier, TIER_NAMES, tierLabel } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';

const TIER_CHOICES = ([0, 1, 2, 3, 4, 5] as const).map((t) => ({ name: t === 0 ? 'None (remove)' : `${t} ${TIER_NAMES[t]}`, value: t }));

/**
 * Per-server settings, so the bot works in any server without IDs in .env.
 *
 * Who can change them: tier 4+ worked out WITHOUT this server's own role map counting for more than
 * the setter already has: you can only map a role to a tier below your own (owners: any tier).
 * So a server admin who invites the bot can't make themselves game staff: they need an owner-list
 * entry, a staff army rank on their linked Roblox account, or a role an existing senior mapped.
 */
export default defineCommand({
  tier: Tier.Administrator,
  subTiers: { show: Tier.TrialModerator },
  help: "This server's staff roles, audit channel and verified role.",
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription("Set up the bot for this server")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('show').setDescription("This server's settings"))
    .addSubcommand((s) =>
      s
        .setName('staff-role')
        .setDescription('Give a role a staff tier in this server (None removes it)')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role').setRequired(true))
        .addIntegerOption((o) => o.setName('tier').setDescription('Staff tier, the same numbers as in game').setRequired(true).addChoices(...TIER_CHOICES)),
    )
    .addSubcommand((s) =>
      s
        .setName('audit-channel')
        .setDescription("Where this server's staff actions are posted (leave empty to turn off)")
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('verified-role')
        .setDescription('Role given after /link verify (leave empty to turn off)')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role')),
    ),

  async execute(ctx) {
    const { interaction, services, caller } = ctx;
    const guildId = interaction.guildId;
    if (!guildId) throw new UserFacingError('Use this in a server.');
    const sub = interaction.options.getSubcommand(true);
    const by = interaction.user.id;
    const audit = (action: string, detail: string) =>
      services.audit.record({ actorId: by, actorName: interaction.user.username, action, detail, ok: true, guildId });

    if (sub === 'show') {
      const s = await services.guilds.get(guildId);
      const roles = Object.entries(s.staffRoles)
        .sort((a, b) => b[1] - a[1])
        .map(([id, t]) => `<@&${id}> → ${tierLabel(t)}`);
      const embed = new EmbedBuilder()
        .setColor(COLOURS.khaki)
        .setTitle(`Bot settings for ${esc(interaction.guild?.name ?? 'this server')}`)
        .addFields(
          { name: 'Staff roles', value: roles.join('\n') || 'None yet. Use /setup staff-role.' },
          { name: 'Audit channel', value: s.auditChannelId ? `<#${s.auditChannelId}>` : 'Off' },
          { name: 'Verified role', value: s.verifiedRoleId ? `<@&${s.verifiedRoleId}>` : 'Off' },
          {
            name: 'Also counted everywhere',
            value: 'Owner list and TIERn_ROLE_IDS from the bot config, and staff army ranks of linked Roblox accounts.',
          },
        )
        .setFooter({ text: s.updatedBy ? `Last changed by ${s.updatedBy}` : 'Not set up yet' });
      if (s.updatedAt) embed.setTimestamp(new Date(s.updatedAt));
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, ...ephemeral });
      return;
    }

    if (sub === 'staff-role') {
      const role = interaction.options.getRole('role', true);
      const tier = interaction.options.getInteger('tier', true) as 0 | StaffTier;
      if (role.id === guildId) throw new UserFacingError("@everyone can't be a staff role.");
      if (role.managed) throw new UserFacingError("That role belongs to a bot or integration; pick a normal role.");
      const current = (await services.guilds.get(guildId)).staffRoles[role.id] ?? 0;
      if (caller.tier < 5) {
        if (tier >= caller.tier) throw new UserFacingError(`You can only give tiers below your own (${tierLabel(caller.tier)}).`);
        if (current >= caller.tier) throw new UserFacingError(`That role is ${tierLabel(current as StaffTier)}; only someone above that can change it.`);
      }
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (tier === 0) delete s.staffRoles[role.id];
        else s.staffRoles[role.id] = tier;
      });
      services.permissions.forget();
      const text = tier === 0 ? `<@&${role.id}> is no longer a staff role here.` : `<@&${role.id}> is now ${tierLabel(tier)} in this server.`;
      await audit('Staff role changed', `${esc(role.name)} (${role.id}): ${current ? tierLabel(current as StaffTier) : 'none'} → ${tier ? tierLabel(tier) : 'none'}`);
      await interaction.reply({ content: `✅ ${text}`, allowedMentions: { parse: [] }, ...ephemeral });
      return;
    }

    if (sub === 'audit-channel') {
      const picked = interaction.options.getChannel('channel');
      if (picked) {
        // prove the bot can post there before saving it
        try {
          const ch = await interaction.client.channels.fetch(picked.id);
          if (!ch?.isSendable()) throw new Error('not sendable');
          await ch.send({ content: `This channel now receives Hong Kong 1941 staff actions (set by <@${by}>).`, allowedMentions: { parse: [] } });
        } catch {
          throw new UserFacingError(`I can't post in <#${picked.id}>. Give me View Channel, Send Messages and Embed Links there, then try again.`);
        }
      }
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (picked) s.auditChannelId = picked.id;
        else delete s.auditChannelId;
      });
      await audit('Audit channel changed', picked ? `Now <#${picked.id}>` : 'Turned off');
      await interaction.reply({ content: picked ? `✅ Staff actions will be posted in <#${picked.id}>.` : '✅ Audit channel turned off.', ...ephemeral });
      return;
    }

    if (sub === 'verified-role') {
      const role = interaction.options.getRole('role');
      let note = '';
      if (role) {
        if (role.id === guildId) throw new UserFacingError("@everyone can't be the verified role.");
        if (role.managed) throw new UserFacingError('That role belongs to a bot or integration; pick a normal role.');
        const me = interaction.guild?.members.me;
        if (me) {
          if (!me.permissions.has('ManageRoles')) note = '\n⚠️ I need the Manage Roles permission to give it.';
          else if (me.roles.highest.position <= (role as { position: number }).position) note = `\n⚠️ Move my role above <@&${role.id}> in Server Settings → Roles, or I can't give it.`;
        }
      }
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (role) s.verifiedRoleId = role.id;
        else delete s.verifiedRoleId;
      });
      await audit('Verified role changed', role ? `Now ${esc(role.name)} (${role.id})` : 'Turned off');
      await interaction.reply({
        content: role ? `✅ Members get <@&${role.id}> after /link verify.${note}` : '✅ Verified role turned off.',
        allowedMentions: { parse: [] },
        ...ephemeral,
      });
      return;
    }
  },
});
