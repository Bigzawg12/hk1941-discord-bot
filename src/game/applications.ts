import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EmbedBuilder, type Client } from 'discord.js';
import { Tier } from '../permissions/tiers.js';
import type { Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { changeRank, discordNote } from './promotions.js';

/**
 * Division applications: someone runs /apply, answers the division's questions, and the
 * application waits in the division's review channel (and on the dashboard). Accepting lets them
 * into the Roblox group (their join request) at the division's starting rank.
 */

export interface Application {
  id: string;
  groupId: number;
  groupName: string;
  discordId: string;
  discordName: string;
  robloxId: number;
  robloxName: string;
  /** question and answer pairs */
  answers: { q: string; a: string }[];
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected';
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /** the review message with the buttons */
  review?: { channelId: string; messageId: string };
}

export class ApplicationStore {
  private items: Map<string, Application> | null = null;
  private writing: Promise<void> = Promise.resolve();
  static readonly KEEP_MS = 90 * 86400_000;

  constructor(private readonly file: string | null) {}

  private async load(): Promise<Map<string, Application>> {
    if (this.items) return this.items;
    this.items = new Map();
    if (!this.file) return this.items;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { applications?: Application[] };
      for (const a of raw.applications ?? []) if (a && typeof a.id === 'string' && typeof a.groupId === 'number') this.items.set(a.id, a);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this.items;
  }

  async get(id: string): Promise<Application | null> {
    const a = (await this.load()).get(id);
    return a ? structuredClone(a) : null;
  }

  async put(a: Application): Promise<void> {
    const items = await this.load();
    items.set(a.id, structuredClone(a));
    const now = Date.now();
    for (const [id, x] of items) if (x.status !== 'pending' && now - (x.decidedAt ?? x.createdAt) > ApplicationStore.KEEP_MS) items.delete(id);
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify({ version: 1, applications: [...items.values()] }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writing;
  }

  /** Newest first. */
  async list(filter: { groupId?: number; status?: Application['status']; robloxId?: number } = {}): Promise<Application[]> {
    return [...(await this.load()).values()]
      .filter(
        (a) =>
          (filter.groupId === undefined || a.groupId === filter.groupId) &&
          (!filter.status || a.status === filter.status) &&
          (filter.robloxId === undefined || a.robloxId === filter.robloxId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => structuredClone(a));
  }
}

export const robloxGroupUrl = (id: number) => `https://www.roblox.com/groups/${id}`;

export function applicationEmbed(a: Application, extra?: { armyRank?: string; points?: string }): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`Application: ${a.robloxName} → ${a.groupName}`)
    .setURL(`https://www.roblox.com/users/${a.robloxId}/profile`)
    .setDescription(`**Discord:** <@${a.discordId}>${extra?.armyRank ? `\n**Army rank:** ${extra.armyRank}` : ''}${extra?.points ? `\n**Record:** ${extra.points}` : ''}`)
    .setTimestamp(new Date(a.createdAt));
  for (const { q, a: ans } of a.answers) e.addFields({ name: q.slice(0, 256), value: (ans || '—').slice(0, 1024) });
  if (a.status === 'pending') return e.setColor(0x3a5f8a).setFooter({ text: 'Officers of this division can accept or reject' });
  const when = a.decidedAt ? `<t:${Math.floor(a.decidedAt / 1000)}:R>` : '';
  return e.setColor(a.status === 'accepted' ? 0x3b7d3b : 0xa33b3b).addFields({
    name: a.status === 'accepted' ? '✅ Accepted' : '❌ Rejected',
    value: `by ${a.decidedBy ?? '?'} ${when}${a.note ? `\n${a.note}` : ''}`.slice(0, 1024),
  });
}

/**
 * May this person decide applications for the group? Owners and dashboard/Discord admins (tier 4+),
 * or anyone holding the group's "who can change ranks here" rank in that group.
 */
export async function canReview(services: Services, groupId: number, who: { tier: number; robloxId?: number }): Promise<boolean> {
  if (who.tier >= Tier.Administrator) return true;
  const entry = await services.divisions.get(groupId);
  if (!entry?.managerRank || !who.robloxId) return false;
  const mine = await services.groups.rankIn(groupId, who.robloxId, { fresh: true }).catch(() => null);
  return (mine?.rank ?? 0) >= entry.managerRank;
}

const inFlight = new Set<string>();

/** Accept (let them in at the starting rank) or reject, update the review message and DM them. */
export async function decideApplication(
  services: Services,
  client: Client | null,
  id: string,
  d: { accept: boolean; byName: string; byDiscordId: string; tier: number; robloxId?: number; note?: string; dashboard?: boolean },
): Promise<{ app: Application; detail: string }> {
  const a = await services.applications.get(id);
  if (!a) throw new UserFacingError('That application is no longer on file.');
  if (a.status !== 'pending') throw new UserFacingError(`It was already ${a.status} by ${a.decidedBy ?? 'someone'}.`);
  if (!(await canReview(services, a.groupId, { tier: d.tier, robloxId: d.robloxId }))) {
    throw new UserFacingError('Only this division’s officers (its “who can change ranks here” rank) or admins can decide applications.');
  }
  if (inFlight.has(id)) throw new UserFacingError('Someone is deciding on this right now.');
  inFlight.add(id);
  try {
    let detail = '';
    const actorName = `${d.byName}${d.dashboard ? ' (dashboard)' : ''}`;
    if (d.accept) {
      const settings = (await services.divisions.get(a.groupId))?.applications;
      let member = await services.groups.rankIn(a.groupId, a.robloxId, { fresh: true });
      if (member.rank === 0) {
        const req = await services.groups.joinRequestFor(a.groupId, a.robloxId).catch(() => null);
        if (!req) {
          throw new UserFacingError(`${a.robloxName} hasn’t asked to join the Roblox group yet. They need to press Join on ${robloxGroupUrl(a.groupId)}, then you can accept.`);
        }
        try {
          await services.groups.acceptJoinRequest(req);
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 403 || status === 401) throw new UserFacingError("Roblox refused to accept the join request: the bot's Roblox account needs permission to accept join requests in that group.");
          throw err;
        }
        member = await services.groups.rankIn(a.groupId, a.robloxId, { fresh: true });
        detail = 'Let into the group.';
      }
      if (settings?.startRoleId && member.roleId !== settings.startRoleId) {
        const change = await changeRank(services, {
          groupId: a.groupId,
          userId: a.robloxId,
          roleId: settings.startRoleId,
          actor: { tier: Tier.Owner }, // the reviewer was checked above
          audit: { actorId: d.byDiscordId, actorName },
          reason: `Application accepted`,
          client,
        });
        detail = `${detail} Given ${change.to.name}. ${discordNote(change)}`.trim();
      }
    }
    a.status = d.accept ? 'accepted' : 'rejected';
    a.decidedBy = d.byName;
    a.decidedAt = Date.now();
    a.note = d.note?.trim().slice(0, 300) || undefined;
    await services.applications.put(a);
    await services.audit.record({
      actorId: d.byDiscordId,
      actorName,
      action: d.accept ? 'Application accepted' : 'Application rejected',
      target: `${a.robloxName} (${a.robloxId})`,
      detail: `${a.groupName}${detail ? `\n${detail}` : ''}${a.note ? `\n${a.note}` : ''}`,
      ok: true,
    });
    if (client && a.review) {
      const ch = await client.channels.fetch(a.review.channelId).catch(() => null);
      const msg = ch && 'messages' in ch ? await ch.messages.fetch(a.review.messageId).catch(() => null) : null;
      await msg?.edit({ embeds: [applicationEmbed(a)], components: [] }).catch((err) => services.logger.warn({ err }, 'could not update the application message'));
    }
    if (client) {
      const text = d.accept
        ? `✅ Your application to **${a.groupName}** was accepted by ${d.byName}. Welcome!${a.note ? `\n${a.note}` : ''}`
        : `❌ Your application to **${a.groupName}** was not accepted.${a.note ? `\nReason: ${a.note}` : ''}`;
      await client.users.send(a.discordId, { content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    return { app: a, detail };
  } finally {
    inFlight.delete(id);
  }
}
