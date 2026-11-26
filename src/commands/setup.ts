import { ChannelType, EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLOURS, ephemeral, esc } from '../discord/helpers.js';
import type { StaffTier } from '../guilds/settings.js';
import { Tier, TIER_NAMES, tierLabel } from '../permissions/tiers.js';
import { imageFromAttachment, removeBanner, saveBanner } from '../posts/images.js';
import { DEFAULT_APPROVER_TIER } from '../posts/workflow.js';
import { NICKNAME_TOKENS } from '../linking/memberSync.js';
import { verifyPanel } from './verify.js';
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
  help: "This server's staff roles, audit channel, verified role, event calendar, and where posts and SSUs go.",
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
    )
    .addSubcommand((s) =>
      s
        .setName('event-channel')
        .setDescription('Channel for the event calendar and event announcements (leave empty to turn off)')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('event-ping')
        .setDescription('Role pinged when an event is about to start (leave empty for no ping)')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role')),
    )
    .addSubcommand((s) =>
      s
        .setName('event-sync')
        .setDescription("Mirror in-game events to and from this server's Events tab and event channel")
        .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('approval-channel')
        .setDescription('Where /post and /ssu requests wait for approval (staff-only channel; empty turns it off)')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s
        .setName('post-approvers')
        .setDescription('Lowest tier that can approve posts and SSUs, and post without approval')
        .addIntegerOption((o) =>
          o
            .setName('tier')
            .setDescription('Staff tier (default 3 Senior Moderator)')
            .setRequired(true)
            .addChoices(...TIER_CHOICES.filter((c) => c.value > 0)),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('post-channel')
        .setDescription('Default channel for /post (empty: they must pick one)')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('ssu-channel')
        .setDescription('Default channel for /ssu (empty: the post channel)')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('ssu-banner')
        .setDescription('Picture shown on every /ssu (empty removes it)')
        .addAttachmentOption((o) => o.setName('image').setDescription('PNG, JPG, GIF or WebP, up to 8 MB; wide pictures look best')),
    )
    .addSubcommand((s) =>
      s
        .setName('verify-panel')
        .setDescription('Post a Verify button anyone can press (like Bloxlink)')
        .addChannelOption((o) => o.setName('channel').setDescription('Where (default: this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('unverified-role')
        .setDescription('Role for members who have not verified (empty turns it off)')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role')),
    )
    .addSubcommand((s) =>
      s
        .setName('nickname')
        .setDescription('Nickname for verified members, e.g. {rank} | {roblox} (empty: leave nicknames alone)')
        .addStringOption((o) => o.setName('template').setDescription('Use {roblox} {display} {rank} {discord}').setMaxLength(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('bind')
        .setDescription('Give a role to members whose Roblox group rank is in a range')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role').setRequired(true))
        .addIntegerOption((o) => o.setName('min-rank').setDescription('Lowest rank number (1-255)').setRequired(true).setMinValue(1).setMaxValue(255))
        .addIntegerOption((o) => o.setName('max-rank').setDescription('Highest rank number (default: same as min)').setMinValue(1).setMaxValue(255))
        .addIntegerOption((o) => o.setName('group').setDescription('Roblox group ID (default: the army group)').setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('unbind')
        .setDescription('Remove all rank binds for a role')
        .addRoleOption((o) => o.setName('role').setDescription('Discord role').setRequired(true)),
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
            name: 'Events',
            value: [
              `Sync with the game: ${s.eventSync === false ? 'off' : 'on'}`,
              `Calendar channel: ${s.eventChannelId ? `<#${s.eventChannelId}>` : 'off'}`,
              `Reminder ping: ${s.eventPingRoleId ? `<@&${s.eventPingRoleId}>` : 'none'}`,
            ].join('\n'),
          },
          {
            name: 'Verification',
            value: [
              `Unverified role: ${s.unverifiedRoleId ? `<@&${s.unverifiedRoleId}>` : 'off'}`,
              `Nickname: ${s.nicknameTemplate ? `\`${s.nicknameTemplate}\`` : 'left alone'}`,
              `Rank binds: ${(s.rankBinds ?? []).map((b) => `<@&${b.roleId}> ← ${b.min === b.max ? b.min : `${b.min}-${b.max}`}${b.groupId !== services.config.roblox.armyGroupId ? ` in ${b.groupId}` : ''}`).join(', ') || 'none'}`,
            ].join('\n'),
          },
          {
            name: 'Posts and SSUs',
            value: [
              `Approval channel: ${s.approvalChannelId ? `<#${s.approvalChannelId}>` : 'none (only approvers can post)'}`,
              `Approvers: ${tierLabel((s.postApproverTier ?? DEFAULT_APPROVER_TIER) as StaffTier)} and above`,
              `Post channel: ${s.postChannelId ? `<#${s.postChannelId}>` : 'none (pick one each time)'}`,
              `SSU channel: ${s.ssuChannelId ? `<#${s.ssuChannelId}>` : s.postChannelId ? 'the post channel' : 'none'}`,
              `SSU banner: ${s.ssuBanner ? 'set' : 'none'}`,
            ].join('\n'),
          },
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

    if (sub === 'event-channel') {
      const picked = interaction.options.getChannel('channel');
      if (picked) {
        const ch = await interaction.client.channels.fetch(picked.id).catch(() => null);
        if (!ch?.isSendable()) {
          throw new UserFacingError(`I can't post in <#${picked.id}>. Give me View Channel, Send Messages, Embed Links and Read Message History there.`);
        }
      }
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (picked) s.eventChannelId = picked.id;
        else delete s.eventChannelId;
        delete s.calendarMessageId;
        delete s.eventState; // start fresh: old events aren't re-announced
      });
      services.eventSync.resetChannel(guildId);
      services.eventSync.syncSoon(1000);
      await audit('Event channel changed', picked ? `Now <#${picked.id}>` : 'Turned off');
      await interaction.reply({
        content: picked
          ? `✅ The event calendar will appear in <#${picked.id}> in a moment, with posts for new events, a reminder before each starts, and "starting now".`
          : '✅ Event calendar turned off.',
        ...ephemeral,
      });
      return;
    }

    if (sub === 'event-ping') {
      const role = interaction.options.getRole('role');
      if (role && role.managed) throw new UserFacingError('That role belongs to a bot or integration; pick a normal role.');
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (role) s.eventPingRoleId = role.id;
        else delete s.eventPingRoleId;
      });
      await audit('Event ping changed', role ? `Now ${esc(role.name)} (${role.id})` : 'No ping');
      const note = role && !(role as { mentionable?: boolean }).mentionable ? '\n⚠️ Turn on "Allow anyone to @mention this role" for it, or the ping will not go out.' : '';
      await interaction.reply({
        content: role ? `✅ <@&${role.id}> is pinged ${services.config.events.remindMinutes} minutes before each event.${note}` : '✅ No reminder ping.',
        allowedMentions: { parse: [] },
        ...ephemeral,
      });
      return;
    }

    if (sub === 'event-sync') {
      const on = interaction.options.getBoolean('on', true);
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        s.eventSync = on;
      });
      if (on) services.eventSync.syncSoon(1000);
      await audit('Event sync changed', on ? 'On' : 'Off');
      await interaction.reply({
        content: on
          ? "✅ In-game events now show in this server's Events tab, and staff events made there go into the game."
          : "✅ Event sync is off here. Existing Discord events stay; nothing new is added or cancelled.",
        ...ephemeral,
      });
      return;
    }

    if (sub === 'approval-channel' || sub === 'post-channel' || sub === 'ssu-channel') {
      const picked = interaction.options.getChannel('channel');
      if (picked) {
        const ch = await interaction.client.channels.fetch(picked.id).catch(() => null);
        if (!ch?.isSendable()) {
          throw new UserFacingError(`I can't post in <#${picked.id}>. Give me View Channel, Send Messages, Embed Links and Attach Files there.`);
        }
      }
      const key = sub === 'approval-channel' ? 'approvalChannelId' : sub === 'post-channel' ? 'postChannelId' : 'ssuChannelId';
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (picked) s[key] = picked.id;
        else delete s[key];
      });
      const what = sub === 'approval-channel' ? 'Approval channel' : sub === 'post-channel' ? 'Post channel' : 'SSU channel';
      await audit(`${what} changed`, picked ? `Now <#${picked.id}>` : 'Turned off');
      const done =
        sub === 'approval-channel'
          ? picked
            ? `✅ Posts and SSUs from below the approver tier now wait in <#${picked.id}>. Keep it staff-only.`
            : '✅ Approval channel turned off: only approvers can use /post and /ssu now.'
          : picked
            ? `✅ ${what} is now <#${picked.id}>.`
            : `✅ ${what} cleared.`;
      await interaction.reply({ content: done, ...ephemeral });
      return;
    }

    if (sub === 'post-approvers') {
      const tier = interaction.options.getInteger('tier', true) as StaffTier;
      if (caller.tier < 5 && tier > caller.tier) throw new UserFacingError(`You can't set it above your own tier (${tierLabel(caller.tier)}).`);
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        s.postApproverTier = tier;
      });
      await audit('Post approvers changed', `${tierLabel(tier)} and above`);
      await interaction.reply({ content: `✅ ${tierLabel(tier)} and above can approve posts and SSUs, and post without approval.`, ...ephemeral });
      return;
    }

    if (sub === 'ssu-banner') {
      const image = imageFromAttachment(interaction.options.getAttachment('image'), 'ssu-banner');
      await interaction.deferReply(ephemeral);
      const dataDir = services.config.dataDir;
      const rel = image ? await saveBanner(dataDir, guildId, image) : (await removeBanner(dataDir, guildId), undefined);
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (rel) s.ssuBanner = rel;
        else delete s.ssuBanner;
      });
      await audit('SSU banner changed', rel ? 'New picture' : 'Removed');
      await interaction.editReply({ content: rel ? '✅ Every /ssu now shows that picture (unless one is attached).' : '✅ SSU banner removed.' });
      return;
    }

    if (sub === 'verify-panel') {
      const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
      const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!ch?.isSendable()) throw new UserFacingError(`I can't post in <#${channelId}>. Give me View Channel, Send Messages and Embed Links there.`);
      await ch.send(verifyPanel(interaction.guild?.name ?? 'this server'));
      await audit('Verify panel posted', `In <#${channelId}>`);
      await interaction.reply({ content: `✅ Verify panel posted in <#${channelId}>.`, ...ephemeral });
      return;
    }

    if (sub === 'unverified-role') {
      const role = interaction.options.getRole('role');
      if (role && (role.id === guildId || role.managed)) throw new UserFacingError('Pick a normal role (not @everyone or a bot role).');
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (role) s.unverifiedRoleId = role.id;
        else delete s.unverifiedRoleId;
      });
      await audit('Unverified role changed', role ? `Now ${esc(role.name)} (${role.id})` : 'Turned off');
      await interaction.reply({ content: role ? `✅ Members who haven't verified get <@&${role.id}> (when they verify or /update).` : '✅ Unverified role turned off.', allowedMentions: { parse: [] }, ...ephemeral });
      return;
    }

    if (sub === 'nickname') {
      const template = interaction.options.getString('template')?.trim() ?? '';
      if (template && !NICKNAME_TOKENS.some((t) => template.includes(t))) throw new UserFacingError(`Use at least one of ${NICKNAME_TOKENS.join(' ')}.`);
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        if (template) s.nicknameTemplate = template;
        else delete s.nicknameTemplate;
      });
      await audit('Nickname template changed', template || 'Off');
      await interaction.reply({ content: template ? `✅ Verified members are named \`${template}\` (from their next verify or /update).` : '✅ Nicknames are left alone now.', ...ephemeral });
      return;
    }

    if (sub === 'bind') {
      const role = interaction.options.getRole('role', true);
      if (role.id === guildId || role.managed) throw new UserFacingError('Pick a normal role (not @everyone or a bot role).');
      const min = interaction.options.getInteger('min-rank', true);
      const max = interaction.options.getInteger('max-rank') ?? min;
      if (max < min) throw new UserFacingError('max-rank must be at least min-rank.');
      const groupId = interaction.options.getInteger('group') ?? services.config.roblox.armyGroupId;
      if ((await services.guilds.get(guildId)).staffRoles[role.id]) {
        throw new UserFacingError(`<@&${role.id}> is a staff role here. Binding it would hand out staff tiers by Roblox rank; use a separate role.`);
      }
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        s.rankBinds = [...(s.rankBinds ?? []).filter((b) => !(b.roleId === role.id && b.groupId === groupId)), { roleId: role.id, groupId, min, max }];
      });
      const range = min === max ? `rank ${min}` : `ranks ${min}-${max}`;
      await audit('Rank bind added', `${esc(role.name)} (${role.id}) ← ${range} in group ${groupId}`);
      await interaction.reply({ content: `✅ Members with ${range} in group ${groupId} get <@&${role.id}> (on verify or /update).`, allowedMentions: { parse: [] }, ...ephemeral });
      return;
    }

    if (sub === 'unbind') {
      const role = interaction.options.getRole('role', true);
      let had = false;
      await services.guilds.update(guildId, interaction.user.username, (s) => {
        const before = s.rankBinds?.length ?? 0;
        s.rankBinds = (s.rankBinds ?? []).filter((b) => b.roleId !== role.id);
        had = s.rankBinds.length < before;
      });
      if (had) await audit('Rank bind removed', `${esc(role.name)} (${role.id})`);
      await interaction.reply({ content: had ? `✅ <@&${role.id}> is no longer given by rank.` : `<@&${role.id}> had no rank binds.`, allowedMentions: { parse: [] }, ...ephemeral });
      return;
    }
  },
});
