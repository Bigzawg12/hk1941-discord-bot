import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelType, type Client, type Guild } from 'discord.js';
import type { GuildSettings, StaffTier } from '../guilds/settings.js';
import { describeSync, NICKNAME_TOKENS, syncEverywhere } from '../linking/memberSync.js';
import { TIER_NAMES } from '../permissions/tiers.js';
import { draftLabel } from '../posts/render.js';
import { decideFromDashboard, DEFAULT_APPROVER_TIER } from '../posts/workflow.js';
import type { FetchLike } from '../roblox/http.js';
import { profileUrl } from '../roblox/users.js';
import type { Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { verifyPanel } from '../commands/verify.js';
import { csrfField, html, Html, layout, select, STYLE, type Option } from './html.js';
import { DiscordOAuth, OAuthError, randomState } from './oauth.js';
import { sameToken, SessionStore, type Session } from './session.js';

/**
 * The private admin dashboard. Only the Discord accounts in DASHBOARD_ADMIN_IDS (else
 * OWNER_DISCORD_IDS) can get past the sign-in. It binds to 127.0.0.1 by default, so it's only
 * reachable from the machine the bot runs on unless you choose otherwise.
 */

export interface DashboardDeps {
  services: Services;
  /** the logged-in Discord client, or null while the bot is still connecting */
  client: () => Client | null;
  fetch?: FetchLike;
  now?: () => number;
}

interface Req {
  method: string;
  url: URL;
  session: Session;
  form: Record<string, string>;
}

class Redirect {
  constructor(readonly to: string) {}
}

const MAX_BODY = 64 * 1024;
const startedAt = Date.now();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserFacingError('Form too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
};

const TIER_OPTIONS: Option[] = ([1, 2, 3, 4, 5] as const).map((t) => ({ value: String(t), label: `${t} · ${TIER_NAMES[t]}` }));

function channelOptions(guild: Guild): Option[] {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => ('position' in a ? a.position : 0) - ('position' in b ? b.position : 0))
    .map((c) => ({ value: c.id, label: `#${c.name}` }));
}

function roleOptions(guild: Guild): Option[] {
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ value: r.id, label: `@${r.name}` }));
}

export function createDashboard(deps: DashboardDeps) {
  const { services } = deps;
  const cfg = services.config.web;
  const sessions = new SessionStore(cfg.sessionSecret ?? 'unused-when-disabled', cfg.publicUrl.startsWith('https://'), deps.now);
  const oauth = new DiscordOAuth({
    clientId: services.config.discord.clientId,
    clientSecret: cfg.discordClientSecret ?? '',
    redirectUri: `${cfg.publicUrl}/auth/discord/callback`,
    fetch: deps.fetch ?? ((i, init) => fetch(i, init)),
  });
  const isAdmin = (s: Session) => !!s.user && cfg.adminIds.includes(s.user.id);
  const flash = (s: Session, kind: 'ok' | 'bad', text: string) => {
    s.flash = { kind, text };
  };

  function client(): Client {
    const c = deps.client();
    if (!c) throw new UserFacingError('The bot is still connecting to Discord. Refresh in a moment.');
    return c;
  }

  function guildOr404(id: string): Guild {
    const g = client().guilds.cache.get(id);
    if (!g) throw new UserFacingError("The bot isn't in that server.");
    return g;
  }

  async function audit(r: Req, action: string, detail: string, guildId?: string) {
    await services.audit.record({ actorId: r.session.user!.id, actorName: `${r.session.user!.username} (dashboard)`, action, detail, ok: true, guildId });
  }

  // ---------- pages ----------

  function loginPage(s: Session, denied = false): string {
    return layout({
      title: 'Sign in',
      session: s,
      body: html`<div class="center card">
        <h1>HK1941 dashboard</h1>
        ${
          denied
            ? html`<p class="flash bad">That Discord account isn't on the dashboard's admin list.</p>`
            : html`<p class="muted">For the server owners only. Sign in with Discord to continue.</p>`
        }
        <p><a href="/auth/discord"><button type="button">Sign in with Discord</button></a></p>
      </div>`,
    });
  }

  async function overview(r: Req): Promise<string> {
    const c = deps.client();
    const [servers, links, posts] = await Promise.all([
      services.servers.list().catch(() => ({ source: 'none' as const, servers: [], error: 'unavailable' })),
      services.links.all(),
      services.posts.list(),
    ]);
    const pending = posts.filter((p) => p.status === 'pending');
    const players = servers.servers.reduce((n, x) => n + x.players, 0);
    const guildName = (id: string) => c?.guilds.cache.get(id)?.name ?? id;
    return layout({
      title: 'Overview',
      nav: 'home',
      session: r.session,
      body: html`<h1>Overview</h1>
      <p class="sub">Bot ${c?.isReady() ? 'online' : 'connecting'} · up ${ago(Date.now() - startedAt)}</p>
      <div class="grid">
        <div class="card"><h2>Game servers</h2><div class="stat">${servers.servers.length}</div><span class="muted">${players} playing${servers.source === 'public' ? ' (public servers only)' : ''}</span></div>
        <div class="card"><h2>Discord servers</h2><div class="stat">${c?.guilds.cache.size ?? '–'}</div><a href="/servers">Manage</a></div>
        <div class="card"><h2>Linked accounts</h2><div class="stat">${links.length}</div><a href="/links">Search</a></div>
        <div class="card"><h2>Waiting for approval</h2><div class="stat">${pending.length}</div><span class="muted">posts and SSUs</span></div>
      </div>
      ${
        servers.servers.length
          ? html`<div class="card"><h2>Live game servers</h2><table><tr><th>Server</th><th>Players</th><th>Up</th><th>Objectives</th></tr>
          ${servers.servers.map(
            (sv) => html`<tr><td><code>${sv.jobId.slice(0, 8)}</code>${sv.privateServer ? html` <span class="pill">private</span>` : ''}</td><td>${sv.players}${sv.maxPlayers ? `/${sv.maxPlayers}` : ''}</td><td>${sv.uptimeSec ? ago(sv.uptimeSec * 1000) : '–'}</td><td>${sv.capture ?? ''}</td></tr>`,
          )}</table></div>`
          : ''
      }
      ${
        pending.length
          ? html`<div class="card"><h2>Waiting for approval</h2><table><tr><th>What</th><th>Server</th><th>Sent</th><th></th></tr>
          ${pending.map((p) => html`<tr><td>${draftLabel(p.draft)}</td><td>${guildName(p.guildId)}</td><td>${ago(Date.now() - p.createdAt)} ago</td><td><a href="/servers/${p.guildId}#approvals">Review</a></td></tr>`)}
          </table></div>`
          : ''
      }`,
    });
  }

  function serversPage(r: Req): string {
    const guilds = [...client().guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    return layout({
      title: 'Servers',
      nav: 'servers',
      session: r.session,
      body: html`<h1>Servers</h1><p class="sub">Every Discord server the bot is in.</p>
      <div class="card"><table><tr><th>Server</th><th>Members</th><th></th></tr>
      ${guilds.map((g) => html`<tr><td>${g.name}</td><td>${g.memberCount}</td><td><a href="/servers/${g.id}">Settings</a></td></tr>`)}
      </table>${guilds.length ? '' : html`<p class="muted">Not in any server yet. Invite it with the link in the README.</p>`}</div>`,
    });
  }

  async function serverPage(r: Req, guild: Guild): Promise<string> {
    const s = await services.guilds.get(guild.id);
    const ch = channelOptions(guild);
    const roles = roleOptions(guild);
    const roleName = (id: string) => guild.roles.cache.get(id)?.name ?? `deleted role ${id}`;
    const chName = (id?: string) => (id ? `#${guild.channels.cache.get(id)?.name ?? id}` : '');
    const pending = (await services.posts.list(guild.id)).filter((p) => p.status === 'pending');
    const army = services.config.roblox.armyGroupId;
    let armyRanks: { rank: number; name: string }[] = [];
    try {
      armyRanks = (await services.groups.listRoles(army)).filter((x) => x.rank > 0).map((x) => ({ rank: x.rank, name: x.name }));
    } catch {
      armyRanks = [];
    }
    const form = (action: string, body: Html, button = 'Save') =>
      html`<form method="post">${csrfField(r.session)}<input type="hidden" name="action" value="${action}">${body}<button>${button}</button></form>`;
    const field = (label: string, name: string, control: Html) => html`<div><label for="${name}">${label}</label>${control}</div>`;
    return layout({
      title: guild.name,
      nav: 'servers',
      session: r.session,
      body: html`<h1>${guild.name}</h1><p class="sub">${guild.memberCount} members · <a href="/servers">all servers</a></p>

      <div class="card" id="approvals"><h2>Waiting for approval</h2>
      ${
        pending.length
          ? html`<table><tr><th>What</th><th>From</th><th>To</th><th>Sent</th><th></th></tr>
          ${pending.map(
            (p) => html`<tr><td>${draftLabel(p.draft)}</td><td>${client().users.cache.get(p.authorId)?.username ?? p.authorId}</td><td>${chName(p.channelId)}</td><td>${ago(Date.now() - p.createdAt)} ago</td>
            <td><form method="post" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="decide"><input type="hidden" name="id" value="${p.id}">
            <button name="decision" value="approve">Approve</button><input name="reason" placeholder="Reason, if rejecting" maxlength="500" style="max-width:200px"><button class="danger" name="decision" value="reject">Reject</button></form></td></tr>`,
          )}</table><p class="muted">The full preview is in ${s.approvalChannelId ? chName(s.approvalChannelId) : 'the approval channel'}.</p>`
          : html`<p class="muted">Nothing waiting.</p>`
      }</div>

      <div class="card"><h2>Channels</h2>
      ${form(
        'channels',
        html`<div class="fields">
          ${field('Audit log', 'auditChannelId', select('auditChannelId', ch, s.auditChannelId))}
          ${field('Event calendar', 'eventChannelId', select('eventChannelId', ch, s.eventChannelId))}
          ${field('Approval queue', 'approvalChannelId', select('approvalChannelId', ch, s.approvalChannelId))}
          ${field('Posts (default)', 'postChannelId', select('postChannelId', ch, s.postChannelId))}
          ${field('SSUs (default)', 'ssuChannelId', select('ssuChannelId', ch, s.ssuChannelId, { none: '— the post channel —' }))}
        </div>`,
      )}</div>

      <div class="card"><h2>Verification</h2>
      ${form(
        'verification',
        html`<div class="fields">
          ${field('Verified role', 'verifiedRoleId', select('verifiedRoleId', roles, s.verifiedRoleId))}
          ${field('Unverified role', 'unverifiedRoleId', select('unverifiedRoleId', roles, s.unverifiedRoleId))}
          ${field(`Nickname (${NICKNAME_TOKENS.join(' ')})`, 'nicknameTemplate', html`<input id="nicknameTemplate" name="nicknameTemplate" maxlength="60" value="${s.nicknameTemplate ?? ''}" placeholder="empty: leave nicknames alone">`)}
        </div>`,
      )}
      <h2 style="margin-top:20px">Rank binds</h2>
      <p class="muted">Members whose Roblox group rank is in the range get the role; it's taken away when they leave the range.</p>
      ${
        (s.rankBinds ?? []).length
          ? html`<table><tr><th>Role</th><th>Ranks</th><th>Group</th><th></th></tr>
          ${(s.rankBinds ?? []).map(
            (b) => html`<tr><td>@${roleName(b.roleId)}</td><td>${b.min === b.max ? b.min : `${b.min}–${b.max}`}</td><td>${b.groupId === army ? 'Army' : b.groupId}</td>
            <td><form method="post">${csrfField(r.session)}<input type="hidden" name="action" value="unbind"><input type="hidden" name="roleId" value="${b.roleId}"><input type="hidden" name="groupId" value="${b.groupId}"><button class="secondary">Remove</button></form></td></tr>`,
          )}</table>`
          : html`<p class="muted">No binds yet.</p>`
      }
      <form method="post" class="row" style="margin-top:12px">${csrfField(r.session)}<input type="hidden" name="action" value="bind">
        ${field('Role', 'bindRole', select('roleId', roles, undefined, { none: null }))}
        ${field('Lowest rank', 'min', html`<input name="min" type="number" min="1" max="255" required style="width:90px">`)}
        ${field('Highest rank', 'max', html`<input name="max" type="number" min="1" max="255" style="width:90px">`)}
        ${field('Group ID', 'groupId', html`<input name="groupId" type="number" min="1" value="${army}" style="width:130px">`)}
        <button>Add bind</button></form>
      ${armyRanks.length ? html`<p class="muted">Army ranks: ${armyRanks.map((x) => `${x.rank} ${x.name}`).join(' · ')}</p>` : ''}
      <h2 style="margin-top:20px">Verify panel</h2>
      <form method="post" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="verify-panel">${field('Channel', 'panelChannel', select('channelId', ch, undefined, { none: null }))}<button>Post Verify button</button></form>
      </div>

      <div class="card"><h2>Staff roles</h2>
      <p class="muted">Discord roles that count as an HKAdmin tier in this server.</p>
      ${
        Object.keys(s.staffRoles).length
          ? html`<table><tr><th>Role</th><th>Tier</th><th></th></tr>
          ${Object.entries(s.staffRoles)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([id, t]) => html`<tr><td>@${roleName(id)}</td><td>${t} · ${TIER_NAMES[t]}</td>
              <td><form method="post">${csrfField(r.session)}<input type="hidden" name="action" value="staff-role"><input type="hidden" name="roleId" value="${id}"><input type="hidden" name="tier" value="0"><button class="secondary">Remove</button></form></td></tr>`,
            )}</table>`
          : html`<p class="muted">None yet.</p>`
      }
      <form method="post" class="row" style="margin-top:12px">${csrfField(r.session)}<input type="hidden" name="action" value="staff-role">
        ${field('Role', 'staffRole', select('roleId', roles, undefined, { none: null }))}${field('Tier', 'tier', select('tier', TIER_OPTIONS, undefined, { none: null }))}<button>Set tier</button></form>
      </div>

      <div class="card"><h2>Posts and events</h2>
      ${form(
        'options',
        html`<div class="fields">
          ${field('Who approves posts and SSUs', 'postApproverTier', select('postApproverTier', TIER_OPTIONS, String(s.postApproverTier ?? DEFAULT_APPROVER_TIER), { none: null }))}
          ${field('Event reminder ping', 'eventPingRoleId', select('eventPingRoleId', roles, s.eventPingRoleId, { none: '— no ping —' }))}
          <div><label><input type="checkbox" name="eventSync" value="1"${s.eventSync === false ? '' : new Html(' checked')}> Sync events with the game</label></div>
        </div>`,
      )}</div>`,
    });
  }

  async function linksPage(r: Req): Promise<string> {
    const q = (r.url.searchParams.get('q') ?? '').trim();
    const all = await services.links.all();
    let rows = all.sort((a, b) => b.linkedAt - a.linkedAt);
    if (q) {
      const lower = q.toLowerCase();
      rows = rows.filter((l) => l.discordId === q || String(l.robloxId) === q || l.robloxName.toLowerCase().includes(lower));
    }
    const shown = rows.slice(0, 100);
    const c = deps.client();
    return layout({
      title: 'Linked accounts',
      nav: 'links',
      session: r.session,
      body: html`<h1>Linked accounts</h1><p class="sub">${all.length} linked in total.</p>
      <div class="card"><form method="get" class="row"><div style="flex:1"><label for="q">Discord ID, Roblox name or Roblox ID</label><input id="q" name="q" value="${q}"></div><button>Search</button></form></div>
      <div class="card"><table><tr><th>Discord</th><th>Roblox</th><th>How</th><th>Linked</th><th></th></tr>
      ${shown.map(
        (l) => html`<tr><td>${c?.users.cache.get(l.discordId)?.username ?? ''} <code>${l.discordId}</code></td><td><a href="${profileUrl(l.robloxId)}" rel="noreferrer" target="_blank">${l.robloxName}</a></td><td>${l.method}</td><td>${new Date(l.linkedAt * 1000).toISOString().slice(0, 10)}</td>
        <td><form method="post" class="inline">${csrfField(r.session)}<input type="hidden" name="discordId" value="${l.discordId}"><button class="secondary" name="action" value="update">Update roles</button> <button class="danger" name="action" value="unlink">Unlink</button></form></td></tr>`,
      )}</table>${rows.length > shown.length ? html`<p class="muted">Showing 100 of ${rows.length}. Search to narrow it down.</p>` : ''}${rows.length ? '' : html`<p class="muted">No matches.</p>`}</div>
      <div class="card"><h2>Link someone by hand</h2><p class="muted">For when someone can't verify. It replaces any link either account already has.</p>
      <form method="post" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="link">
        <div><label for="discordId">Discord user ID</label><input id="discordId" name="discordId" pattern="\\d{15,25}" required></div>
        <div><label for="roblox">Roblox username or ID</label><input id="roblox" name="roblox" required maxlength="40"></div><button>Link</button></form></div>`,
    });
  }

  // ---------- actions ----------

  async function serverAction(r: Req, guild: Guild): Promise<void> {
    const f = r.form;
    const by = r.session.user!.username;
    const inGuild = (opts: Option[], v: string | undefined) => (v && opts.some((o) => o.value === v) ? v : undefined);
    const ch = channelOptions(guild);
    const roles = roleOptions(guild);
    const set = (change: (s: GuildSettings) => void) => services.guilds.update(guild.id, `${by} (dashboard)`, change);

    switch (f.action) {
      case 'decide': {
        const approve = f.decision === 'approve';
        const post = await decideFromDashboard(services, client(), f.id ?? '', { approve, by: r.session.user!.globalName ?? by, byDiscordId: r.session.user!.id, reason: f.reason });
        flash(r.session, 'ok', approve ? `Approved and posted: ${post.postUrl}` : 'Rejected. The author has been told.');
        return;
      }
      case 'channels': {
        const before = await services.guilds.get(guild.id);
        const keys = ['auditChannelId', 'eventChannelId', 'approvalChannelId', 'postChannelId', 'ssuChannelId'] as const;
        await set((s) => {
          for (const k of keys) {
            const v = inGuild(ch, f[k]);
            if (v) s[k] = v;
            else delete s[k];
          }
          if (s.eventChannelId !== before.eventChannelId) {
            delete s.calendarMessageId;
            delete s.eventState;
          }
        });
        if (inGuild(ch, f.eventChannelId) !== before.eventChannelId) {
          services.eventSync.resetChannel(guild.id);
          services.eventSync.syncSoon(1000);
        }
        await audit(r, 'Channels changed', keys.map((k) => `${k}: ${f[k] ? `<#${f[k]}>` : 'off'}`).join('\n'), guild.id);
        flash(r.session, 'ok', 'Channels saved. Make sure the bot can post in each one.');
        return;
      }
      case 'verification': {
        const tpl = (f.nicknameTemplate ?? '').trim().slice(0, 60);
        if (tpl && !NICKNAME_TOKENS.some((t) => tpl.includes(t))) throw new UserFacingError(`The nickname needs at least one of ${NICKNAME_TOKENS.join(' ')}.`);
        await set((s) => {
          const v = inGuild(roles, f.verifiedRoleId);
          const u = inGuild(roles, f.unverifiedRoleId);
          if (v) s.verifiedRoleId = v;
          else delete s.verifiedRoleId;
          if (u) s.unverifiedRoleId = u;
          else delete s.unverifiedRoleId;
          if (tpl) s.nicknameTemplate = tpl;
          else delete s.nicknameTemplate;
        });
        await audit(r, 'Verification settings changed', `Verified ${f.verifiedRoleId || 'off'}, unverified ${f.unverifiedRoleId || 'off'}, nickname ${tpl || 'off'}`, guild.id);
        flash(r.session, 'ok', 'Saved. Members pick it up when they verify or press Update.');
        return;
      }
      case 'bind': {
        const roleId = inGuild(roles, f.roleId);
        const min = Number(f.min);
        const max = f.max ? Number(f.max) : min;
        const groupId = Number(f.groupId || services.config.roblox.armyGroupId);
        if (!roleId) throw new UserFacingError('Pick a role.');
        if (![min, max].every((n) => Number.isInteger(n) && n >= 1 && n <= 255) || max < min) throw new UserFacingError('Ranks are whole numbers from 1 to 255, lowest first.');
        if (!Number.isSafeInteger(groupId) || groupId < 1) throw new UserFacingError('That group ID is not valid.');
        if ((await services.guilds.get(guild.id)).staffRoles[roleId]) throw new UserFacingError("That's a staff role here. Use a separate role for rank binds.");
        await set((s) => {
          s.rankBinds = [...(s.rankBinds ?? []).filter((b) => !(b.roleId === roleId && b.groupId === groupId)), { roleId, groupId, min, max }];
        });
        await audit(r, 'Rank bind added', `<@&${roleId}> ← ranks ${min}-${max} in group ${groupId}`, guild.id);
        flash(r.session, 'ok', 'Bind added.');
        return;
      }
      case 'unbind': {
        await set((s) => {
          s.rankBinds = (s.rankBinds ?? []).filter((b) => !(b.roleId === f.roleId && String(b.groupId) === f.groupId));
        });
        await audit(r, 'Rank bind removed', `<@&${f.roleId}> in group ${f.groupId}`, guild.id);
        flash(r.session, 'ok', 'Bind removed.');
        return;
      }
      case 'verify-panel': {
        const id = inGuild(ch, f.channelId);
        if (!id) throw new UserFacingError('Pick a channel.');
        const target = await client().channels.fetch(id).catch(() => null);
        if (!target?.isSendable()) throw new UserFacingError("The bot can't post there. Give it View Channel, Send Messages and Embed Links.");
        await target.send(verifyPanel(guild.name));
        await audit(r, 'Verify panel posted', `In <#${id}>`, guild.id);
        flash(r.session, 'ok', 'Verify panel posted.');
        return;
      }
      case 'staff-role': {
        const roleId = f.roleId && (f.tier === '0' ? f.roleId : inGuild(roles, f.roleId));
        const tier = Number(f.tier);
        if (!roleId || !Number.isInteger(tier) || tier < 0 || tier > 5) throw new UserFacingError('Pick a role and a tier.');
        if (tier > 0 && (await services.guilds.get(guild.id)).rankBinds?.some((b) => b.roleId === roleId)) {
          throw new UserFacingError('That role is given out by a rank bind. Remove the bind first, or use another role.');
        }
        await set((s) => {
          if (tier === 0) delete s.staffRoles[roleId];
          else s.staffRoles[roleId] = tier as StaffTier;
        });
        services.permissions.forget();
        await audit(r, 'Staff role changed', `<@&${roleId}> → ${tier ? `${tier} ${TIER_NAMES[tier as StaffTier]}` : 'none'}`, guild.id);
        flash(r.session, 'ok', tier ? 'Staff tier set.' : 'Staff role removed.');
        return;
      }
      case 'options': {
        const tier = Number(f.postApproverTier);
        if (!Number.isInteger(tier) || tier < 1 || tier > 5) throw new UserFacingError('Pick a tier.');
        const sync = f.eventSync === '1';
        await set((s) => {
          s.postApproverTier = tier as StaffTier;
          const ping = inGuild(roles, f.eventPingRoleId);
          if (ping) s.eventPingRoleId = ping;
          else delete s.eventPingRoleId;
          s.eventSync = sync;
        });
        if (sync) services.eventSync.syncSoon(1000);
        await audit(r, 'Post and event options changed', `Approvers ${tier}+, event ping ${f.eventPingRoleId || 'none'}, sync ${sync ? 'on' : 'off'}`, guild.id);
        flash(r.session, 'ok', 'Saved.');
        return;
      }
      default:
        throw new UserFacingError('Unknown action.');
    }
  }

  async function linksAction(r: Req): Promise<void> {
    const f = r.form;
    const discordId = (f.discordId ?? '').trim();
    if (!/^\d{15,25}$/.test(discordId)) throw new UserFacingError('That is not a Discord user ID.');
    const c = client();
    if (f.action === 'unlink') {
      const had = await services.links.unlink(discordId);
      services.permissions.forget();
      if (had) {
        await syncEverywhere(services, c, discordId, 'Unlinked from the dashboard').catch(() => []);
        await audit(r, 'Account unlinked', `<@${discordId}>`);
      }
      flash(r.session, had ? 'ok' : 'bad', had ? 'Unlinked, and their verified and rank roles were taken away.' : 'They were not linked.');
      return;
    }
    if (f.action === 'update') {
      const results = await syncEverywhere(services, c, discordId, 'Update from the dashboard');
      flash(r.session, 'ok', describeSync(results).replace(/<@&(\d+)>/g, (_m, id: string) => `@${c.guilds.cache.find((g) => g.roles.cache.has(id))?.roles.cache.get(id)?.name ?? id}`).replace(/\*\*/g, '') || 'They are not in any server with the bot.');
      return;
    }
    if (f.action === 'link') {
      const user = await services.users.resolve((f.roblox ?? '').trim());
      if (!user) throw new UserFacingError(`No Roblox user called "${(f.roblox ?? '').slice(0, 40)}".`);
      const link = await services.links.linkVerified(discordId, user, 'manual');
      services.permissions.forget();
      await syncEverywhere(services, c, discordId, `Linked to Roblox ${user.name} by an admin`).catch(() => []);
      await audit(r, 'Account linked by hand', `<@${discordId}> → ${link.robloxName} (${link.robloxId})`);
      flash(r.session, 'ok', `Linked to ${link.robloxName} and roles updated.`);
      return;
    }
    throw new UserFacingError('Unknown action.');
  }

  // ---------- routing ----------

  async function route(r: Req): Promise<string | Redirect> {
    const path = r.url.pathname;
    const s = r.session;

    if (path === '/login') return isAdmin(s) ? new Redirect('/') : loginPage(s);
    if (path === '/auth/discord' && r.method === 'GET') {
      const state = randomState();
      s.oauth = { state, next: s.oauth?.next };
      return new Redirect(oauth.authorizeUrl(state));
    }
    if (path === '/auth/discord/callback' && r.method === 'GET') {
      const want = s.oauth;
      s.oauth = undefined;
      const code = r.url.searchParams.get('code');
      if (!want || !code || !sameToken(r.url.searchParams.get('state') ?? undefined, want.state)) {
        flash(s, 'bad', 'Sign-in expired or was cancelled. Try again.');
        return new Redirect('/login');
      }
      const user = await oauth.finish(code);
      if (!cfg.adminIds.includes(user.id)) {
        services.logger.warn({ user: user.id }, 'dashboard sign-in refused: not an admin');
        return loginPage(s, true);
      }
      throw new SignedIn(user, want.next);
    }
    if (path === '/logout' && r.method === 'POST') throw new SignedOut();

    if (!isAdmin(s)) {
      if (r.method === 'GET') s.oauth = { state: '', next: path + r.url.search };
      return new Redirect('/login');
    }

    if (r.method === 'POST') {
      const m = /^\/servers\/(\d{15,25})$/.exec(path);
      try {
        if (m) await serverAction(r, guildOr404(m[1]!));
        else if (path === '/links') await linksAction(r);
        else throw new UserFacingError('Unknown form.');
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        flash(s, 'bad', err.message);
      }
      return new Redirect(path + (m ? '' : r.url.search));
    }

    if (path === '/') return overview(r);
    if (path === '/servers') return serversPage(r);
    const sm = /^\/servers\/(\d{15,25})$/.exec(path);
    if (sm) return serverPage(r, guildOr404(sm[1]!));
    if (path === '/links') return linksPage(r);
    throw new NotFound();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {
      'content-security-policy':
        "default-src 'none'; style-src 'self'; img-src 'self' https://cdn.discordapp.com; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
    };
    const url = new URL(req.url ?? '/', cfg.publicUrl);
    if (url.pathname === '/static/style.css') {
      res.writeHead(200, { ...headers, 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(STYLE);
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    const cookies: string[] = [];
    let { session, setCookie } = sessions.fromCookie(req.headers.cookie);
    if (setCookie) cookies.push(setCookie);
    const send = (status: number, body: string, extra: Record<string, string> = {}) => {
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(body);
    };
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      let form: Record<string, string> = {};
      if (method === 'POST') {
        form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        if (!sameToken(form._csrf, session.csrf)) {
          send(403, layout({ title: 'Expired', session, body: html`<div class="card"><h1>That form expired</h1><p><a href="${url.pathname}">Go back</a> and try again.</p></div>` }));
          return;
        }
      } else if (method !== 'GET' && method !== 'HEAD') {
        send(405, 'Method not allowed', { allow: 'GET, POST' });
        return;
      }
      const out = await route({ method, url, session, form });
      if (out instanceof Redirect) send(303, '', { location: out.to });
      else send(200, out);
    } catch (err) {
      if (err instanceof SignedIn) {
        const fresh = sessions.renew(session, { user: err.user });
        cookies.splice(0, cookies.length, fresh.setCookie);
        services.logger.info({ user: err.user.id }, 'dashboard sign-in');
        const next = err.next && err.next.startsWith('/') && !err.next.startsWith('//') ? err.next : '/';
        send(303, '', { location: next });
      } else if (err instanceof SignedOut) {
        cookies.splice(0, cookies.length, sessions.destroy(session));
        send(303, '', { location: '/login' });
      } else if (err instanceof NotFound) {
        send(404, layout({ title: 'Not found', session, body: html`<div class="card"><h1>Not found</h1><p><a href="/">Overview</a></p></div>` }));
      } else if (err instanceof UserFacingError || err instanceof OAuthError) {
        send(400, layout({ title: 'Problem', session, body: html`<div class="card"><h1>Something's not right</h1><p>${err.message}</p><p><a href="/">Overview</a></p></div>` }));
      } else {
        services.logger.error({ err, path: url.pathname }, 'dashboard request failed');
        send(500, layout({ title: 'Error', session, body: html`<div class="card"><h1>Something went wrong</h1><p>It's in the bot log.</p></div>` }));
      }
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    /** Start listening; resolves with the actual port (useful with port 0 in tests). */
    listen(port = cfg.port, host = cfg.host): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

class SignedIn {
  constructor(
    readonly user: import('./session.js').WebUser,
    readonly next?: string,
  ) {}
}
class SignedOut {}
class NotFound {}
