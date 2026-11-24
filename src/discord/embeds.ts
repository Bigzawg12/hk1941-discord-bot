import { EmbedBuilder } from 'discord.js';
import { CERT_BY_ID, CERT_RANK, MEDAL_BY_ID, MEDAL_RANK } from '../game/gameConfig.js';
import { computePoints, hours, standing } from '../game/points.js';
import type { ArrestEntry, ProfileSnapshot } from '../game/profile.js';
import type { ArrestLogEntry, GameEvent } from '../roblox/globalData.js';
import type { UserRank } from '../roblox/groups.js';
import type { LiveServer, ServerList } from '../roblox/servers.js';
import { profileUrl, type RobloxUser } from '../roblox/users.js';
import { discordTime } from '../util/time.js';
import { clip, COLOURS, esc } from './helpers.js';

const n = (x: number) => x.toLocaleString('en-GB');

export function medalLines(p: ProfileSnapshot): string[] {
  return Object.entries(p.data.medals.a)
    .filter(([id]) => MEDAL_BY_ID.has(id))
    .sort(([a], [b]) => (MEDAL_RANK.get(a) ?? 99) - (MEDAL_RANK.get(b) ?? 99))
    .map(([id, rec]) => {
      const m = MEDAL_BY_ID.get(id)!;
      const times = (rec.n ?? 1) > 1 ? ` ×${rec.n}` : '';
      const cite = rec.c ? ` — *${esc(rec.c).slice(0, 120)}*` : '';
      return `**${m.name}**${times}${cite}`;
    });
}

export function tabNames(p: ProfileSnapshot): string[] {
  return Object.keys(p.data.medals.q)
    .filter((id) => CERT_BY_ID.has(id))
    .sort((a, b) => (CERT_RANK.get(a) ?? 99) - (CERT_RANK.get(b) ?? 99))
    .map((id) => CERT_BY_ID.get(id)!.name);
}

export function recordEmbed(
  user: RobloxUser,
  p: ProfileSnapshot,
  army: UserRank,
  opts: { headshot?: string | null; showArrests: boolean; showLog: boolean },
): EmbedBuilder {
  const d = p.data;
  const s = d.service;
  const t = d.training;
  const st = standing(d, army.rank);
  const { parts } = computePoints(d);
  const role = army.rank > 0 ? army.roleName : 'Not in the army group';

  const e = new EmbedBuilder()
    .setColor(st.eligible ? COLOURS.ok : COLOURS.khaki)
    .setAuthor({ name: `${user.displayName} (@${user.name})`, url: profileUrl(user.id) })
    .setTitle(`Service record · ${role}`)
    .setDescription(
      [
        `**${n(st.points)} points**`,
        st.next
          ? `Next: **${st.next.next}** · ${n(st.points)}/${n(st.next.points)} points · ${st.next.haveTrainings}/${st.next.trainings} trainings${st.eligible ? ' · ✅ **ELIGIBLE**' : ''}`
          : 'No further rank on the points record (officers are commissioned by selection).',
        p.activeSession?.jobId ? `🟢 In game now (server ${p.activeSession.jobId.slice(0, 8)})` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  if (opts.headshot) e.setThumbnail(opts.headshot);

  e.addFields(
    {
      name: 'Service',
      value: [
        `Time in service: ${hours(s.playtime)}`,
        `Time in the field: ${hours(s.deployedTime)}`,
        `Deployments: ${n(s.deployments)}`,
        `Events attended: ${n(s.events)}`,
        s.firstJoin ? `Enlisted: ${discordTime(s.firstJoin, 'D')}` : null,
        s.lastJoin ? `Last seen: ${discordTime(s.lastJoin, 'R')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      inline: true,
    },
    {
      name: 'Training',
      value: [`Attended: ${t.attended}`, `Passed: ${t.passed}`, `Failed: ${t.failed}`, `Hosted: ${t.hosted}`].join('\n'),
      inline: true,
    },
    {
      name: 'Combat',
      value: [`Points captured: ${n(s.captures)}`, `Enemy killed: ${n(s.kills)}`, `AI IJA killed: ${n(s.aiKills)}`, `Times killed: ${n(s.deaths)}`].join(
        '\n',
      ),
      inline: true,
    },
  );

  const medals = medalLines(p);
  e.addFields({ name: `Medals (${medals.length})`, value: clip(medals.join('\n') || 'None') });
  const tabs = tabNames(p);
  e.addFields({ name: `Qualification tabs (${tabs.length})`, value: clip(tabs.join(', ') || 'None') });

  const breakdown = parts.filter(([, v]) => v !== 0).map(([label, v]) => `${label}: ${v > 0 ? '+' : ''}${v}`);
  if (breakdown.length) e.addFields({ name: 'Points breakdown', value: clip(breakdown.join('\n')), inline: true });

  const hist = t.history.slice(0, 4).map((h) => `${h.t ? discordTime(h.t, 'd') : '?'} ${esc(String(h.title ?? 'Training'))}${h.result ? ` · ${h.result}` : ''}`);
  if (hist.length) e.addFields({ name: 'Recent trainings', value: clip(hist.join('\n')), inline: true });

  if (opts.showLog && s.log.length) {
    const log = s.log.slice(0, 4).map((l) => `${l.t ? discordTime(l.t, 'd') : '?'} ${(l.n ?? 0) >= 0 ? '+' : ''}${l.n ?? 0} by ${esc(l.by ?? '?')}${l.reason ? `: ${esc(l.reason)}` : ''}`);
    e.addFields({ name: 'Point adjustments', value: clip(log.join('\n')) });
  }
  if (opts.showArrests) {
    const jail = d.mp.jailLeft > 0 ? ` · ⛓ ${Math.ceil(d.mp.jailLeft / 60)} min left to serve` : '';
    e.addFields({ name: 'Military police', value: `Arrests on record: ${d.mp.arrests.length} · Arrests made: ${d.mp.made}${jail}` });
  }
  e.setFooter({ text: `Roblox ID ${user.id}` });
  if (p.updatedAt) e.setTimestamp(new Date(p.updatedAt));
  return e;
}

export function medalsEmbed(user: RobloxUser, p: ProfileSnapshot | null): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOURS.khaki).setAuthor({ name: `${user.displayName} (@${user.name})`, url: profileUrl(user.id) }).setTitle('Medals and qualifications');
  if (!p) return e.setDescription('No record yet: they haven\'t played since service records started.');
  const medals = medalLines(p);
  const tabs = tabNames(p);
  e.addFields(
    { name: `Medals (${medals.length})`, value: clip(medals.join('\n') || 'None') },
    { name: `Qualification tabs (${tabs.length})`, value: clip(tabs.join(', ') || 'None') },
  );
  if (!p.data.medals.wear) e.setFooter({ text: 'Not wearing medals on their uniform' });
  return e;
}

function chargesText(c?: string[]) {
  return c && c.length ? c.map(esc).join('; ') : 'no charge given';
}

export function arrestLogEmbed(entries: ArrestLogEntry[], limit = 10): EmbedBuilder {
  const lines = entries
    .slice(0, limit)
    .map((a) => `${a.t ? discordTime(a.t, 'f') : '?'} **${esc(a.who ?? '?')}** by ${esc(a.by ?? '?')}, ${a.minutes ?? 0} min: ${chargesText(a.charges)}`);
  return new EmbedBuilder()
    .setColor(COLOURS.info)
    .setTitle('Latest arrests')
    .setDescription(clip(lines.join('\n') || 'No arrests logged yet.', 4000));
}

export function playerArrestsEmbed(user: RobloxUser, p: ProfileSnapshot | null, limit = 8): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOURS.info).setAuthor({ name: `${user.displayName} (@${user.name})`, url: profileUrl(user.id) }).setTitle('Arrest record');
  if (!p) return e.setDescription('No record yet.');
  const arrests: ArrestEntry[] = p.data.mp.arrests;
  const lines = arrests.slice(0, limit).map((a) => `${a.t ? discordTime(a.t, 'd') : '?'} ${a.minutes ?? 0} min by ${esc(a.by ?? '?')}: ${chargesText(a.charges)}`);
  e.setDescription(clip(lines.join('\n') || `${user.name} has a clean record.`, 4000));
  if (p.data.mp.jailLeft > 0) {
    e.addFields({ name: 'Serving', value: `${Math.ceil(p.data.mp.jailLeft / 60)} min left · ${esc(p.data.mp.jailCharges || '?')} (by ${esc(p.data.mp.jailBy || '?')})` });
  }
  e.setFooter({ text: `${arrests.length} on record · ${p.data.mp.made} made as MP` });
  return e;
}

export function eventsEmbed(events: GameEvent[]): EmbedBuilder {
  const lines = events.map(
    (ev) => `**#${esc(ev.id)}** ${discordTime(ev.start, 'F')} (${discordTime(ev.start, 'R')})\n${esc(ev.title)}${ev.detail ? ` — ${esc(ev.detail)}` : ''} · host ${esc(ev.host)}`,
  );
  return new EmbedBuilder()
    .setColor(COLOURS.khaki)
    .setTitle('Scheduled events')
    .setDescription(clip(lines.join('\n\n') || 'No events scheduled.', 4000))
    .setFooter({ text: 'Times are shown in your own time zone. In game they are UTC.' });
}

function serverLine(s: LiveServer): string {
  const cap = s.maxPlayers ? `/${s.maxPlayers}` : '';
  const up = s.uptimeSec ? ` · up ${Math.floor(s.uptimeSec / 3600)}h${String(Math.floor((s.uptimeSec % 3600) / 60)).padStart(2, '0')}` : '';
  const priv = s.privateServer ? ' · private' : '';
  const names = s.names?.length ? `\n${clip(s.names.map(esc).join(', '), 300)}` : '';
  return `\`${s.jobId.slice(0, 8)}\` **${s.players}${cap}** players${up}${priv}${names}`;
}

export function statusEmbed(list: ServerList, placeId: number): EmbedBuilder {
  const total = list.servers.reduce((sum, s) => sum + s.players, 0);
  const e = new EmbedBuilder()
    .setColor(list.servers.length ? COLOURS.ok : COLOURS.warn)
    .setTitle('Hong Kong 1941 · live servers')
    .setURL(`https://www.roblox.com/games/${placeId}`)
    .setDescription(
      list.servers.length
        ? `**${list.servers.length}** server${list.servers.length === 1 ? '' : 's'} · **${total}** player${total === 1 ? '' : 's'}`
        : 'No live servers.',
    );
  for (const s of list.servers.slice(0, 10)) {
    e.addFields({ name: '​', value: clip(serverLine(s)) });
    if (s.capture) e.addFields({ name: 'Objectives', value: clip('```\n' + s.capture + '\n```') });
  }
  e.setFooter({
    text:
      list.source === 'bridge'
        ? 'From the in-game bridge heartbeat'
        : list.source === 'public'
          ? 'Public servers only (bridge heartbeat not available)'
          : `Could not read servers${list.error ? `: ${list.error.slice(0, 80)}` : ''}`,
  });
  return e;
}
