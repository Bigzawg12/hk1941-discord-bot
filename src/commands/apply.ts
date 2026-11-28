import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ephemeral } from '../discord/helpers.js';
import { applicationEmbed, decideApplication, robloxGroupUrl, type Application } from '../game/applications.js';
import { standing } from '../game/points.js';
import { Tier } from '../permissions/tiers.js';
import { field, modal, newToken } from '../posts/workflow.js';
import { defineCommand, type CommandContext, type Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';

/**
 * /apply: join a division. The division's questions come up in a form; the answers go to its
 * review channel with Accept / Reject for its officers. Set up on the dashboard (group → Applications).
 */

async function openDivisions(services: Services): Promise<{ groupId: number; name: string }[]> {
  const out: { groupId: number; name: string }[] = [];
  for (const e of await services.divisions.list()) {
    if (!e.applications?.open || !e.applications.channelId || !e.applications.questions.length) continue;
    const info = await services.groups.getGroup(e.groupId).catch(() => null);
    out.push({ groupId: e.groupId, name: e.label || info?.name || `Group ${e.groupId}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export default defineCommand({
  tier: Tier.Everyone,
  help: 'Apply to join a division. Needs a linked Roblox account (/verify).',
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Apply to join a division')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('division').setDescription('Which division').setRequired(true).setAutocomplete(true)),

  async autocomplete(interaction, services) {
    const typed = interaction.options.getFocused().toLowerCase();
    const list = await openDivisions(services);
    await interaction.respond(
      list
        .filter((d) => d.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((d) => ({ name: d.name.slice(0, 100), value: String(d.groupId) })),
    );
  },

  async execute(ctx) {
    const { interaction, services } = ctx;
    const picked = interaction.options.getString('division', true);
    const list = await openDivisions(services);
    const div = list.find((d) => String(d.groupId) === picked) ?? list.find((d) => d.name.toLowerCase() === picked.toLowerCase());
    if (!div) throw new UserFacingError(list.length ? 'Pick a division from the list.' : 'No division is taking applications right now.');
    const link = await services.links.get(interaction.user.id);
    if (!link) throw new UserFacingError('Link your Roblox account first with /verify, then apply again.');
    const pending = await services.applications.list({ groupId: div.groupId, status: 'pending', robloxId: link.robloxId });
    if (pending.length) throw new UserFacingError(`You already have an application to ${div.name} waiting.`);
    const member = await services.groups.rankIn(div.groupId, link.robloxId, { fresh: true }).catch(() => null);
    const start = (await services.divisions.get(div.groupId))?.applications?.startRoleId;
    if (member && member.rank > 0 && (!start || member.roleId === start || member.rank > ((await services.groups.listRoles(div.groupId)).find((r) => r.id === start)?.rank ?? 255))) {
      throw new UserFacingError(`You're already in ${div.name}.`);
    }
    const questions = (await services.divisions.get(div.groupId))!.applications!.questions.slice(0, 5);
    await interaction.showModal(
      modal(
        `apply:form:${div.groupId}`,
        `Apply: ${div.name}`,
        questions.map((q, i) => field(`q${i}`, q.length <= 45 ? q : `Question ${i + 1}`, { long: true, required: true, max: 1000, description: q.length > 45 ? q : undefined })),
      ),
    );
  },

  async modal(ctx: CommandContext<ModalSubmitInteraction>) {
    const { interaction, services } = ctx;
    const [, kind, arg = ''] = interaction.customId.split(':');
    if (kind === 'why') {
      await interaction.deferReply(ephemeral);
      await decideApplication(services, interaction.client, arg, {
        accept: false,
        byName: ctx.caller.robloxName ?? interaction.user.username,
        byDiscordId: interaction.user.id,
        tier: ctx.caller.tier,
        robloxId: ctx.caller.robloxId,
        note: interaction.fields.getTextInputValue('note'),
      });
      await interaction.editReply({ content: 'Rejected. They have been told.' });
      return;
    }
    if (kind !== 'form') return;
    const groupId = Number(arg);
    const entry = await services.divisions.get(groupId);
    const settings = entry?.applications;
    if (!settings?.open || !settings.channelId) throw new UserFacingError('This division stopped taking applications.');
    const link = await services.links.get(interaction.user.id);
    if (!link) throw new UserFacingError('Link your Roblox account first with /verify, then apply again.');
    await interaction.deferReply(ephemeral);
    const info = await services.groups.getGroup(groupId).catch(() => null);
    const name = entry?.label || info?.name || `Group ${groupId}`;
    const answers = settings.questions.slice(0, 5).map((q, i) => {
      let a = '';
      try {
        a = interaction.fields.getTextInputValue(`q${i}`).trim();
      } catch {
        a = '';
      }
      return { q, a: a.slice(0, 1000) };
    });
    const app: Application = {
      id: newToken(),
      groupId,
      groupName: name,
      discordId: interaction.user.id,
      discordName: interaction.user.username,
      robloxId: link.robloxId,
      robloxName: link.robloxName,
      answers,
      createdAt: Date.now(),
      status: 'pending',
    };
    const ch = await interaction.client.channels.fetch(settings.channelId).catch(() => null);
    if (!ch?.isSendable()) throw new UserFacingError('The bot can’t post in this division’s review channel. Tell an officer.');
    const [army, profile] = await Promise.all([
      services.groups.rankIn(services.config.roblox.armyGroupId, link.robloxId).catch(() => null),
      services.profiles.get(link.robloxId).catch(() => null),
    ]);
    const st = profile && army ? standing(profile.data, army.rank) : null;
    const msg = await ch.send({
      embeds: [applicationEmbed(app, { armyRank: army?.rank ? `${army.roleName} (${army.rank})` : 'Not in the army group', points: st ? `${st.points} points · ${profile!.data.training.attended} trainings` : 'No service record' })],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`apply:accept:${app.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`apply:reject:${app.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { parse: [] },
    });
    app.review = { channelId: settings.channelId, messageId: msg.id };
    await services.applications.put(app);
    const member = await services.groups.rankIn(groupId, link.robloxId, { fresh: true }).catch(() => null);
    await interaction.editReply({
      content: `📝 Your application to **${name}** is in. You'll get a DM when it's decided (if your DMs are open).${member?.rank ? '' : `\nAlso press **Join** on the Roblox group so they can let you in: ${robloxGroupUrl(groupId)}`}`,
    });
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const { interaction, services, caller } = ctx;
    const [, action, id = ''] = interaction.customId.split(':');
    if (action === 'reject') {
      const app = await services.applications.get(id);
      if (!app || app.status !== 'pending') {
        await interaction.reply({ content: 'This application was already decided.', ...ephemeral });
        return;
      }
      await interaction.showModal(modal(`apply:why:${id}`, 'Reject this application', [field('note', 'Reason (sent to them)', { long: true, max: 300, placeholder: 'Optional' })]));
      return;
    }
    if (action !== 'accept') return;
    await interaction.deferReply(ephemeral);
    const { app, detail } = await decideApplication(services, interaction.client, id, {
      accept: true,
      byName: caller.robloxName ?? interaction.user.username,
      byDiscordId: interaction.user.id,
      tier: caller.tier,
      robloxId: caller.robloxId,
    });
    await interaction.editReply({ content: `✅ Accepted ${app.robloxName} into ${app.groupName}. ${detail}`.trim() });
  },
});
