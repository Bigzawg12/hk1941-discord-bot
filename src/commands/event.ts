import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { eventsEmbed } from '../discord/embeds.js';
import { runLiveAction } from '../discord/liveAction.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { discordTime, parseWhen } from '../util/time.js';

export default defineCommand({
  tier: Tier.Everyone,
  subTiers: { schedule: Tier.Moderator, cancel: Tier.Moderator }, // ;event add / cancel are tier 2
  help: 'Scheduled events: list (everyone), schedule and cancel (Moderator). Same list as ;events in game.',
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Scheduled Hong Kong 1941 events')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('list').setDescription('Upcoming events'))
    .addSubcommand((s) =>
      s
        .setName('schedule')
        .setDescription('Post an event (shown in game and announced 15 minutes before)')
        .addStringOption((o) =>
          o.setName('when').setDescription('+2h, 19:00 (UTC), 2026-12-01 19:00 (UTC) or a Discord timestamp').setRequired(true).setMaxLength(40),
        )
        .addStringOption((o) => o.setName('title').setDescription('Title (60 characters)').setRequired(true).setMaxLength(60))
        .addStringOption((o) => o.setName('detail').setDescription('Details, e.g. where to meet (120 characters)').setMaxLength(120)),
    )
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Cancel an event')
        .addStringOption((o) => o.setName('id').setDescription('Event number from /event list').setRequired(true).setMaxLength(8)),
    ),

  async execute(ctx) {
    const { interaction, services } = ctx;
    const sub = interaction.options.getSubcommand(true);

    if (sub === 'list') {
      await interaction.deferReply();
      await interaction.editReply({ embeds: [eventsEmbed(await services.global.events())] });
      return;
    }

    if (sub === 'cancel') {
      const eventId = interaction.options.getString('id', true).replace(/^#/, '').trim();
      if (!/^\d{1,8}$/.test(eventId)) throw new UserFacingError('Event ids are numbers, e.g. 4821.');
      const r = await runLiveAction(ctx, 'event_cancel', { eventId }, { label: `Cancel event #${eventId}` });
      services.global.invalidate('HK1941_Events', 'list');
      if (r.ok) services.eventSync.syncSoon();
      await interaction.editReply(r.text);
      return;
    }

    // schedule
    const now = Math.floor(Date.now() / 1000);
    const start = parseWhen(interaction.options.getString('when', true), now);
    if (start === null) throw new UserFacingError('Time must be +30m / +2h / +1d, HH:MM (UTC), YYYY-MM-DD HH:MM (UTC) or a Discord timestamp.');
    if (start < now - 60) throw new UserFacingError('That time has already passed.');
    if (start > now + 60 * 86400) throw new UserFacingError('Events can be scheduled up to 60 days ahead.');
    const title = interaction.options.getString('title', true).trim();
    const detail = interaction.options.getString('detail')?.trim() ?? '';

    const r = await runLiveAction(ctx, 'event_add', { start, title, detail }, {
      label: 'Schedule event',
      detail: `${title}${detail ? ` — ${detail}` : ''} at ${discordTime(start, 'F')}`,
      noAckHint: 'No live server saved it, so it is NOT on the in-game list yet. Try again when a server is up, or use ;event add in game.',
    });
    services.global.invalidate('HK1941_Events', 'list');

    if (r.ok) services.eventSync.syncSoon(); // Events tabs and calendars pick it up
    const id = r.eventId ? ` #${r.eventId}` : '';
    await interaction.editReply(`🗓️ Event${id} **${title}** at ${discordTime(start, 'F')} (${discordTime(start, 'R')}).\n${r.text}`);
  },
});
