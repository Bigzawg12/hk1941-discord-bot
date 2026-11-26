import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { describeSync, syncEverywhere } from '../linking/memberSync.js';
import { COLOURS, ephemeral, esc, needTier } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { profileUrl } from '../roblox/users.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { discordTime } from '../util/time.js';

export default defineCommand({
  tier: Tier.Everyone,
  subTiers: { whois: Tier.TrialModerator },
  help: 'Link your Discord and Roblox accounts (needed for /record without a name, and for all staff actions).',
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your Roblox account')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Step 1: get a code to put in your Roblox profile')
        .addStringOption((o) => o.setName('username').setDescription('Your Roblox username').setRequired(true).setMaxLength(40)),
    )
    .addSubcommand((s) => s.setName('verify').setDescription('Step 2: check the code and finish linking'))
    .addSubcommand((s) => s.setName('status').setDescription('Which Roblox account you are linked to'))
    .addSubcommand((s) => s.setName('remove').setDescription('Unlink your accounts'))
    .addSubcommand((s) =>
      s
        .setName('whois')
        .setDescription('Staff: look up a link either way')
        .addUserOption((o) => o.setName('member').setDescription('Discord member'))
        .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setMaxLength(100)),
    ),

  async execute(ctx) {
    const { interaction, services } = ctx;
    const sub = interaction.options.getSubcommand(true);
    const links = services.links;

    if (sub === 'start') {
      if (links.mode !== 'blurb') {
        await interaction.reply({ content: `This server links through ${links.mode === 'bloxlink' ? 'Bloxlink' : 'RoVer'}. Verify there, then run **/link verify**.`, ...ephemeral });
        return;
      }
      await interaction.deferReply(ephemeral);
      const name = interaction.options.getString('username', true);
      const user = await services.users.resolve(name);
      if (!user) throw new UserFacingError(`No Roblox user called "${name.slice(0, 40)}".`);
      const taken = await links.findByRoblox(user.id);
      if (taken && taken.discordId !== interaction.user.id) {
        throw new UserFacingError(`${user.name} is already linked to another Discord account. Ask staff if that's wrong.`);
      }
      const { code, expiresInMin } = await links.start(interaction.user.id, user);
      const embed = new EmbedBuilder()
        .setColor(COLOURS.info)
        .setTitle(`Link ${user.name}`)
        .setDescription(
          [
            `1. Open your Roblox profile: ${profileUrl(user.id)}`,
            '2. Edit **About** and paste this phrase anywhere in it, then save:',
            `\`\`\`\n${code}\n\`\`\``,
            '3. Run **/link verify** here.',
            '',
            `The phrase works for ${expiresInMin} minutes. You can delete it from your profile once you're linked.`,
          ].join('\n'),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'verify') {
      await interaction.deferReply(ephemeral);
      const link = await links.verify(interaction.user.id, interaction.guildId);
      services.permissions.forget(interaction.user.id);
      const synced = describeSync(await syncEverywhere(services, interaction.client, interaction.user.id, `Linked to Roblox ${link.robloxName} (${link.robloxId})`));
      const roleNote = synced ? `
${synced}` : '';
      await services.audit.record({ actorId: interaction.user.id, actorName: interaction.user.username, action: 'Account linked', target: `${link.robloxName} (${link.robloxId})`, detail: `Method: ${link.method}`, ok: true, guildId: interaction.guildId });
      await interaction.editReply({ content: `✅ Linked to **${esc(link.robloxName)}** (${link.robloxId}).${roleNote}`, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'status') {
      const link = await links.get(interaction.user.id);
      await interaction.reply({
        content: link
          ? `Linked to **${esc(link.robloxName)}** (${link.robloxId}) since ${discordTime(link.linkedAt, 'D')} via ${link.method}.`
          : 'Not linked. Start with **/link start**.',
        ...ephemeral,
      });
      return;
    }

    if (sub === 'remove') {
      const had = await links.unlink(interaction.user.id);
      services.permissions.forget(interaction.user.id);
      if (had) await syncEverywhere(services, interaction.client, interaction.user.id, 'Unlinked').catch(() => undefined);
      if (had) await services.audit.record({ actorId: interaction.user.id, actorName: interaction.user.username, action: 'Account unlinked', ok: true, guildId: interaction.guildId });
      await interaction.reply({ content: had ? 'Unlinked.' : 'You were not linked.', ...ephemeral });
      return;
    }

    // whois
    needTier(ctx, Tier.TrialModerator, '/link whois');
    const member = interaction.options.getUser('member');
    const query = interaction.options.getString('user');
    if (member) {
      const link = await links.get(member.id);
      await interaction.reply({ content: link ? `<@${member.id}> → **${esc(link.robloxName)}** (${link.robloxId}) ${profileUrl(link.robloxId)}` : `<@${member.id}> isn't linked.`, ...ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (query) {
      const user = await services.users.resolve(query);
      if (!user) throw new UserFacingError(`No Roblox user called "${query.slice(0, 40)}".`);
      const link = await links.findByRoblox(user.id);
      await interaction.reply({ content: link ? `**${esc(user.name)}** → <@${link.discordId}>` : `**${esc(user.name)}** isn't linked to anyone here.`, ...ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    throw new UserFacingError('Give a Discord member or a Roblox user.');
  },
});
