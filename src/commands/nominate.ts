import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from 'discord.js';
import { COLOURS, ephemeral, esc, resolveRobloxTarget } from '../discord/helpers.js';
import { standing } from '../game/points.js';
import { assignable, changeRank, discordNote, type PromotionRequest } from '../game/promotions.js';
import { Tier, tierLabel } from '../permissions/tiers.js';
import { field, modal, newToken } from '../posts/workflow.js';
import { profileUrl } from '../roblox/users.js';
import { defineCommand, type CommandContext, type Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';

/**
 * /nominate: staff below the approvers ask for someone's promotion. The request waits in the
 * server's approval channel; an Administrator (the /promote tier) presses Approve, and the rank
 * changes then, checked against the approver's own rank. Also decided on the dashboard.
 */

/** Who may approve: the same tier as /promote. */
export const APPROVE_TIER = Tier.Administrator;

function requestEmbed(r: PromotionRequest, extra?: { standing?: string }): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`Promotion request: ${r.userName}`)
    .setURL(profileUrl(r.userId))
    .setDescription(`**${esc(r.fromName)}** → **${esc(r.toName)}**\n**Asked by:** <@${r.byId}>\n**Reason:** ${esc(r.reason)}`)
    .setTimestamp(new Date(r.createdAt));
  if (extra?.standing) e.addFields({ name: 'Points record', value: extra.standing });
  if (r.status === 'pending') return e.setColor(COLOURS.info).setFooter({ text: `${tierLabel(APPROVE_TIER)} or above can approve` });
  const when = r.decidedAt ? `<t:${Math.floor(r.decidedAt / 1000)}:R>` : '';
  e.setColor(r.status === 'approved' ? COLOURS.ok : COLOURS.bad).addFields({
    name: r.status === 'approved' ? '✅ Approved' : '❌ Rejected',
    value: `by ${esc(r.decidedBy ?? '?')} ${when}${r.note ? `\n${esc(r.note)}` : ''}`,
  });
  return e;
}

const buttons = (id: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`nominate:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nominate:reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );

const inFlight = new Set<string>();

/**
 * Approve (changes the rank) or reject a request, update its Discord message and tell the person
 * who asked. Shared by the buttons and the dashboard.
 */
export async function decideRequest(
  services: Services,
  client: Client | null,
  id: string,
  d: { approve: boolean; byName: string; byDiscordId: string; tier: number; robloxId?: number; note?: string; dashboard?: boolean },
): Promise<PromotionRequest> {
  const r = await services.promotionRequests.get(id);
  if (!r) throw new UserFacingError('That request is no longer on file.');
  if (r.status !== 'pending') throw new UserFacingError(`It was already ${r.status} by ${r.decidedBy ?? 'someone'}.`);
  if (d.tier < APPROVE_TIER) throw new UserFacingError(`Deciding promotion requests needs ${tierLabel(APPROVE_TIER)} or above.`);
  if (d.byDiscordId === r.byId && d.tier < Tier.Owner) throw new UserFacingError('Someone else has to decide on your own request.');
  if (inFlight.has(id)) throw new UserFacingError('Someone is deciding on this right now.');
  inFlight.add(id);
  try {
    let changed: { discordUpdated: boolean; discordLinked: boolean } | null = null;
    if (d.approve) {
      changed = await changeRank(services, {
        groupId: r.groupId,
        userId: r.userId,
        roleId: r.toRoleId,
        expectRoleId: r.fromRoleId,
        actor: { robloxId: d.robloxId, tier: d.tier },
        audit: { actorId: d.byDiscordId, actorName: `${d.byName}${d.dashboard ? ' (dashboard)' : ''}`, guildId: r.guildId },
        reason: `Requested by ${r.byName}: ${r.reason}`,
        client,
      });
    }
    r.status = d.approve ? 'approved' : 'rejected';
    r.decidedBy = d.byName;
    r.decidedAt = Date.now();
    r.note = d.note?.trim().slice(0, 300) || undefined;
    await services.promotionRequests.put(r);
    if (!d.approve) {
      await services.audit.record({
        actorId: d.byDiscordId,
        actorName: `${d.byName}${d.dashboard ? ' (dashboard)' : ''}`,
        action: 'Promotion request rejected',
        target: `${r.userName} (${r.userId})`,
        detail: `${r.fromName} → ${r.toName}${r.note ? `\n${r.note}` : ''}`,
        ok: true,
        guildId: r.guildId,
      });
    }
    if (client && r.queue) {
      const ch = await client.channels.fetch(r.queue.channelId).catch(() => null);
      const msg = ch && 'messages' in ch ? await ch.messages.fetch(r.queue.messageId).catch(() => null) : null;
      await msg?.edit({ embeds: [requestEmbed(r)], components: [] }).catch((err) => services.logger.warn({ err }, 'could not update the promotion request message'));
    }
    if (client) {
      const text = d.approve
        ? `✅ Your request to promote ${r.userName} to ${r.toName} was approved by ${d.byName}.${changed ? ` ${discordNote(changed)}` : ''}`
        : `❌ Your request to promote ${r.userName} to ${r.toName} was not approved by ${d.byName}.${r.note ? `\nReason: ${r.note}` : ''}`;
      await client.users.send(r.byId, { content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    return r;
  } finally {
    inFlight.delete(id);
  }
}

export default defineCommand({
  tier: Tier.TrialModerator,
  help: 'Ask for someone’s promotion in the army group. It waits in the approval channel until an Administrator approves it.',
  data: new SlashCommandBuilder()
    .setName('nominate')
    .setDescription('Request a promotion for a soldier; an Administrator approves it')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('rank').setDescription('Rank to give them').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why they should be promoted').setRequired(true).setMaxLength(300)),

  async autocomplete(interaction, services) {
    const typed = interaction.options.getFocused().toLowerCase();
    const roles = assignable(await services.groups.listRoles(services.config.roblox.armyGroupId));
    await interaction.respond(
      roles
        .filter((r) => `${r.rank} ${r.name}`.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((r) => ({ name: `${r.rank} · ${r.name}`.slice(0, 100), value: String(r.id) })),
    );
  },

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply(ephemeral);
    const guildId = interaction.guildId!;
    const settings = await services.guilds.get(guildId);
    if (!settings.approvalChannelId) throw new UserFacingError('This server has no approval channel yet. An Administrator can set one with /setup approval-channel.');
    const group = services.config.roblox.armyGroupId;
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const roles = assignable(await services.groups.listRoles(group));
    const pick = interaction.options.getString('rank', true);
    const to = roles.find((r) => String(r.id) === pick) ?? roles.find((r) => r.name.toLowerCase() === pick.toLowerCase());
    if (!to) throw new UserFacingError('Pick a rank from the list.');
    const from = await services.groups.rankIn(group, user.id, { fresh: true });
    if (from.rank === 0) throw new UserFacingError(`${user.name} isn't in the army group.`);
    if (from.roleId === to.id) throw new UserFacingError(`${user.name} is already ${to.name}.`);
    const open = (await services.promotionRequests.list({ status: 'pending', userId: user.id })).find((x) => x.toRoleId === to.id);
    if (open) throw new UserFacingError(`There's already a request to make ${user.name} ${to.name}, waiting since <t:${Math.floor(open.createdAt / 1000)}:R>.`);

    const queue = await interaction.client.channels.fetch(settings.approvalChannelId).catch(() => null);
    if (!queue?.isSendable()) throw new UserFacingError(`I can't post in <#${settings.approvalChannelId}>. Give me View Channel, Send Messages and Embed Links there.`);
    const profile = await services.profiles.get(user.id).catch(() => null);
    const st = profile ? standing(profile.data, from.rank) : null;
    const r: PromotionRequest = {
      id: newToken(),
      guildId,
      groupId: group,
      userId: user.id,
      userName: user.name,
      fromRoleId: from.roleId,
      fromName: from.roleName,
      toRoleId: to.id,
      toName: to.name,
      byId: interaction.user.id,
      byName: ctx.caller.robloxName ?? interaction.user.username,
      reason: interaction.options.getString('reason', true).trim().slice(0, 300),
      createdAt: Date.now(),
      status: 'pending',
    };
    const standingText = !st
      ? 'No service record yet.'
      : st.next
        ? `${st.points} pts · ${st.next.haveTrainings} trainings · ladder says next: ${st.next.next} (${st.next.points} pts, ${st.next.trainings} trainings)${st.eligible ? ' · ✅ eligible' : ' · not yet eligible'}`
        : `${st.points} pts · past the points ladder (by selection).`;
    const msg = await queue.send({ embeds: [requestEmbed(r, { standing: standingText })], components: [buttons(r.id)], allowedMentions: { parse: [] } });
    r.queue = { channelId: settings.approvalChannelId, messageId: msg.id };
    await services.promotionRequests.put(r);
    await services.audit.record({
      actorId: interaction.user.id,
      actorName: interaction.user.username,
      action: 'Promotion requested',
      target: `${user.name} (${user.id})`,
      detail: `${from.roleName} → ${to.name}\n${r.reason}`,
      ok: true,
      guildId,
    });
    await interaction.editReply({ content: `📝 Sent for approval in <#${settings.approvalChannelId}>. You'll get a DM when it's decided (if your DMs are open).` });
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const { interaction, services, caller } = ctx;
    const [, action, id = ''] = interaction.customId.split(':');
    const r = await services.promotionRequests.get(id);
    const say = (content: string) => interaction.reply({ content, ...ephemeral });
    if (!r) return void (await say('This request is no longer on file.'));
    if (r.status !== 'pending') return void (await say(`This was already ${r.status} by ${r.decidedBy ?? 'someone'}.`));
    if (caller.tier < APPROVE_TIER) return void (await say(`Deciding promotion requests needs ${tierLabel(APPROVE_TIER)} or above.`));
    if (action === 'reject') {
      await interaction.showModal(modal(`nominate:why:${id}`, 'Reject this request', [field('note', 'Reason (sent to whoever asked)', { long: true, max: 300, placeholder: 'Optional' })]));
      return;
    }
    if (action !== 'approve') return;
    await interaction.deferReply(ephemeral);
    const done = await decideRequest(services, interaction.client, id, {
      approve: true,
      byName: caller.robloxName ?? interaction.user.username,
      byDiscordId: interaction.user.id,
      tier: caller.tier,
      robloxId: caller.robloxId,
    });
    await interaction.editReply({ content: `✅ ${done.userName} is now ${done.toName}. (In game it shows after they rejoin.)` });
  },

  async modal(ctx: CommandContext<ModalSubmitInteraction>) {
    const { interaction, services, caller } = ctx;
    const [, , id = ''] = interaction.customId.split(':');
    await interaction.deferReply(ephemeral);
    await decideRequest(services, interaction.client, id, {
      approve: false,
      byName: caller.robloxName ?? interaction.user.username,
      byDiscordId: interaction.user.id,
      tier: caller.tier,
      robloxId: caller.robloxId,
      note: interaction.fields.getTextInputValue('note'),
    });
    await interaction.editReply({ content: 'Rejected. Whoever asked has been told.' });
  },
});
