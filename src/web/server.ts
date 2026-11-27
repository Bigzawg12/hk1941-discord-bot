import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelType, type Client, type Guild } from 'discord.js';
import { verifyPanel } from '../commands/verify.js';
import { commandOf, type GameLogEntry } from '../game/adminLogArchive.js';
import type { GuildSettings, StaffTier } from '../guilds/settings.js';
import { describeSync, NICKNAME_TOKENS, syncEverywhere } from '../linking/memberSync.js';
import type { AccountLink } from '../linking/store.js';
import { TIER_NAMES } from '../permissions/tiers.js';
import { draftLabel, POST_KINDS, type Draft } from '../posts/render.js';
import type { PendingPost } from '../posts/store.js';
import { decideFromDashboard, DEFAULT_APPROVER_TIER } from '../posts/workflow.js';
import type { FetchLike } from '../roblox/http.js';
import { profileUrl } from '../roblox/users.js';
import type { Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import {
  ago,
  badge,
  card,
  csrfField,
  empty,
  FAVICON,
  field,
  html,
  Html,
  icon,
  layout,
  pageHead,
  select,
  STYLE,
  utc,
  type Option,
  type Tone,
} from './html.js';
import { DiscordOAuth, OAuthError, randomState } from './oauth.js';
import { sameToken, SessionStore, type Session } from './session.js';

/**
 * The private admin dashboard. Only the Discord accounts in DASHBOARD_ADMIN_IDS (else
 * OWNER_DISCORD_IDS) can get past the sign-in. It binds to 127.0.0.1 by default, so it's only
 * reachable from the machine the bot runs on unless you choose otherwise (SSH tunnel, Tailscale).
 * No JavaScript: every page is plain HTML and forms, under a strict Content-Security-Policy.
 */

export interface DashboardDeps {
  services: Services;
  /** the logged-in Discord client, or null while the bot is still connecting */
  client: () => Client | null;
  fetch?: FetchLike;
  now?: () => number;
  /** how often to copy the in-game admin log (ms); 0 = only when the Game log page is opened */
  gameLogPollMs?: number;
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
class Raw {
  constructor(
    readonly body: string,
    readonly type: string,
    readonly headers: Record<string, string> = {},
  ) {}
}

const MAX_BODY = 64 * 1024;
const PAGE_SIZE = 50;
const startedAt = Date.now();
/** Game log: read the game again when the page is opened and the copy is older than this. */
const GAME_LOG_FRESH_MS = 60_000;
/** Pages a sign-in may return to (never /favicon.ico and the like). */
const RETURNABLE = /^\/(approvals|game-log|servers(\/\d{15,25})?|links)?$/;

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

const uptime = (ms: number) => ago(ms).replace(' ago', '').replace('just now', 'under a minute');
const TIER_OPTIONS: Option[] = ([1, 2, 3, 4, 5] as const).map((t) => ({ value: String(t), label: `${t} · ${TIER_NAMES[t]}` }));
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '#');
const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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

function guildIcon(g: Guild, size = 44): Html {
  const url = typeof g.iconURL === 'function' ? g.iconURL({ size: 64 }) : null;
  return url ? html`<img src="${url}" alt="" width="${size}" height="${size}">` : html`<span class="server-ph">${initials(g.name)}</span>`;
}

interface DiscordFace {
  id: string;
  name: string;
  avatar: string | null;
}

/** One person in the game log: their Roblox account and, when linked, their Discord account. */
interface StaffInfo {
  robloxId?: number;
  link?: AccountLink;
}

const SERVER_TABS = [
  ['channels', 'Channels'],
  ['verification', 'Verification'],
  ['binds', 'Rank binds'],
  ['staff', 'Staff roles'],
  ['posts', 'Posts & events'],
] as const;
type ServerTab = (typeof SERVER_TABS)[number][0];
const isTab = (t: string | null | undefined): t is ServerTab => SERVER_TABS.some(([k]) => k === t);

export function createDashboard(deps: DashboardDeps) {
  const { services } = deps;
  const cfg = services.config.web;
  const now = deps.now ?? Date.now;
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

  async function pendingPosts(guildId?: string): Promise<PendingPost[]> {
    return (await services.posts.list(guildId)).filter((p) => p.status === 'pending');
  }

  async function page(r: Req, opts: { title: string; nav?: string; body: Html }): Promise<string> {
    const approvals = (await pendingPosts().catch(() => [])).length;
    return layout({ ...opts, session: r.session, counts: { approvals } });
  }

  /** Discord name and avatar; fetches at most `budget.n` users that aren't cached yet. */
  async function face(id: string, budget = { n: 10 }): Promise<DiscordFace> {
    const c = deps.client();
    let u = c?.users.cache.get(id) as { username?: string; globalName?: string | null; displayAvatarURL?: (o: object) => string } | undefined;
    if (!u && c && budget.n > 0 && typeof c.users.fetch === 'function') {
      budget.n--;
      u = (await c.users.fetch(id).catch(() => undefined)) as typeof u;
    }
    return {
      id,
      name: u?.globalName || u?.username || `User ${id.slice(-4)}`,
      avatar: u && typeof u.displayAvatarURL === 'function' ? u.displayAvatarURL({ size: 64, extension: 'png' }) : null,
    };
  }

  const faceHtml = (f: DiscordFace, sub?: string | Html) =>
    html`<span class="who">${f.avatar ? html`<img src="${f.avatar}" alt="" width="28" height="28">` : html`<span class="avatar-ph">${initials(f.name)}</span>`}<span class="stack-sm"><span>${f.name}</span>${sub ? html`<small>${sub}</small>` : ''}</span></span>`;

  /** Match Roblox usernames from the game log to Roblox ids and linked Discord accounts. */
  async function staffDirectory(names: string[], lookups = 15): Promise<Map<string, StaffInfo>> {
    const out = new Map<string, StaffInfo>();
    const want = [...new Set(names.filter((n) => n && n !== 'server').map((n) => n.toLowerCase()))];
    if (!want.length) return out;
    const links = await services.links.all();
    const byName = new Map(links.map((l) => [l.robloxName.toLowerCase(), l]));
    const byId = new Map(links.map((l) => [l.robloxId, l]));
    const staff = await services.global.staff().catch(() => ({}) as Record<string, { name?: string }>);
    const staffIds = new Map(Object.entries(staff).flatMap(([id, e]) => (e?.name ? [[e.name.toLowerCase(), Number(id)] as const] : [])));
    for (const name of want) {
      let link = byName.get(name);
      let robloxId = link?.robloxId ?? staffIds.get(name);
      if (!robloxId && lookups > 0) {
        lookups--;
        robloxId = (await services.users.getByUsername(name).catch(() => null))?.id;
      }
      if (!link && robloxId) link = byId.get(robloxId);
      out.set(name, { robloxId, link });
    }
    return out;
  }

  // ---------- sign in ----------

  function loginPage(s: Session, denied = false): string {
    return layout({
      title: 'Sign in',
      session: s,
      bare: true,
      body: html`<div class="login"><div class="login-card">
        ${icon('shield', 'ic brand-ic')}
        <h1>HK1941 dashboard</h1>
        ${
          denied
            ? html`<p class="flash bad">${icon('x')}<span>That Discord account isn't on the dashboard's admin list.</span></p>`
            : html`<p class="muted">For the server owners only. Sign in with your Discord account to continue.</p>`
        }
        <a class="btn" href="/auth/discord">Sign in with Discord</a>
      </div></div>`,
    });
  }

  // ---------- overview ----------

  async function overview(r: Req): Promise<string> {
    const c = deps.client();
    const [servers, links, pending, log] = await Promise.all([
      services.servers.list().catch(() => ({ source: 'none' as const, servers: [], error: 'unavailable' })),
      services.links.all(),
      pendingPosts(),
      freshGameLog(),
    ]);
    const players = servers.servers.reduce((n, x) => n + x.players, 0);
    const guildName = (id: string) => c?.guilds.cache.get(id)?.name ?? id;
    const dayAgo = now() / 1000 - 86400;
    const recent = log.slice(0, 8);
    const dir = await staffDirectory(recent.map((e) => e.by), 5);
    const budget = { n: 6 };
    const recentRows = await Promise.all(
      recent.map(async (e) => {
        const info = dir.get(e.by.toLowerCase());
        const discord = info?.link ? await face(info.link.discordId, budget) : null;
        return html`<li><span class="grow"><span class="title">${e.by}${e.viaDiscord ? html` ${badge('via Discord', 'info')}` : ''}</span><span class="cmd">${e.text}</span></span><span class="muted nowrap">${discord ? discord.name : ''}<br><small>${ago(now() - e.t * 1000)}</small></span></li>`;
      }),
    );
    const stat = (href: string | null, ic: string, tone: string, n: string | number, label: string, extra = '') =>
      href
        ? html`<a class="stat" href="${href}"><span class="stat-ic ${tone}">${icon(ic)}</span><span><span class="stat-n">${n}</span><span class="stat-l">${label}${extra}</span></span></a>`
        : html`<div class="stat"><span class="stat-ic ${tone}">${icon(ic)}</span><span><span class="stat-n">${n}</span><span class="stat-l">${label}${extra}</span></span></div>`;
    return page(r, {
      title: 'Overview',
      nav: 'home',
      body: html`${pageHead('Overview', html`${badge(c?.isReady() ? 'Bot online' : 'Bot connecting', c?.isReady() ? 'ok' : 'warn')} <span class="muted">· up ${uptime(Date.now() - startedAt)}</span>`)}
      <div class="stats">
        ${stat(null, 'game', 'ok', servers.servers.length, `live game server${servers.servers.length === 1 ? '' : 's'}`, ` · ${players} playing`)}
        ${stat('/approvals', 'inbox', pending.length ? 'warn' : '', pending.length, 'waiting for approval')}
        ${stat('/game-log', 'log', 'info', log.filter((e) => e.t >= dayAgo).length, 'game commands today')}
        ${stat('/links', 'link', '', links.length, 'linked accounts')}
        ${stat('/servers', 'server', '', c?.guilds.cache.size ?? '–', 'Discord servers')}
      </div>
      <div class="grid-2">
        <div class="stack">
          ${card(
            'Waiting for approval',
            pending.length
              ? html`<ul class="list">${pending.slice(0, 5).map(
                  (p) => html`<li><span class="grow"><span class="title">${draftLabel(p.draft)}</span><small class="muted">${guildName(p.guildId)} · ${ago(now() - p.createdAt)}</small></span><a class="btn sm secondary" href="/approvals#p-${p.id}">Review</a></li>`,
                )}</ul>`
              : empty('Nothing waiting', 'New posts and SSUs from staff show up here.', 'check'),
            { action: html`<a href="/approvals">All approvals ${icon('arrow')}</a>` },
          )}
          ${card(
            'Live game servers',
            servers.servers.length
              ? html`<div class="table-wrap"><table><thead><tr><th>Server</th><th>Players</th><th>Up</th><th>Objectives</th></tr></thead><tbody>
                ${servers.servers.map(
                  (sv) => html`<tr><td><code>${sv.jobId.slice(0, 8)}</code>${sv.privateServer ? html` ${badge('private')}` : ''}</td><td>${sv.players}${sv.maxPlayers ? `/${sv.maxPlayers}` : ''}</td><td class="nowrap">${sv.uptimeSec ? uptime(sv.uptimeSec * 1000) : '–'}</td><td>${sv.capture ?? ''}</td></tr>`,
                )}</tbody></table></div>`
              : empty('No live servers', servers.source === 'none' ? "Couldn't reach Roblox just now." : 'Nobody is playing right now.', 'game'),
          )}
        </div>
        ${card(
          'Recent game commands',
          recent.length ? html`<ul class="list">${recentRows}</ul>` : empty('No commands yet', 'Admin commands run in game appear here.', 'log'),
          { action: html`<a href="/game-log">Full log ${icon('arrow')}</a>` },
        )}
      </div>`,
    });
  }

  // ---------- approvals ----------

  async function queueImage(p: PendingPost): Promise<string | null> {
    if (!p.draft.imageName || !p.queue) return null;
    try {
      const ch = await client().channels.fetch(p.queue.channelId);
      if (!ch || !('messages' in ch)) return null;
      const msg = await ch.messages.fetch(p.queue.messageId);
      const a = msg.attachments.first();
      return a?.url ?? null;
    } catch {
      return null;
    }
  }

  function draftBody(d: Draft, guild: Guild | undefined): Html {
    const ping = d.ping.kind === 'none' ? 'No ping' : d.ping.kind === 'role' ? `@${guild?.roles.cache.get(d.ping.roleId)?.name ?? 'deleted role'}` : `@${d.ping.kind}`;
    if (d.type === 'ssu') {
      return html`<div class="approval-top">${badge('SSU', 'bad')}${badge(ping, d.ping.kind === 'none' ? 'muted' : 'warn')}</div>
        <h3>Server Start Up</h3>
        <p class="muted">Event: ${d.event || 'the game’s current or next event, picked when it’s posted'}</p>
        <div class="preview">${d.message || '(no message)'}</div>`;
    }
    const kind = POST_KINDS[d.kind];
    return html`<div class="approval-top">${badge(kind?.label ?? d.kind, 'accent')}${badge(ping, d.ping.kind === 'none' ? 'muted' : 'warn')}</div>
      ${d.title ? html`<h3>${d.title}</h3>` : ''}${d.subtitle ? html`<p class="muted">${d.subtitle}</p>` : ''}
      <div class="preview">${d.body}${d.signature ? `\n\n— ${d.signature}` : ''}</div>
      ${d.buttons.length ? html`<div class="links-out">${d.buttons.map((b) => html`<a class="btn sm secondary" href="${safeUrl(b.url)}" target="_blank" rel="noreferrer noopener">${b.label} ${icon('external')}</a>`)}</div>` : ''}`;
  }

  async function approvalsPage(r: Req): Promise<string> {
    const c = deps.client();
    const all = await services.posts.list();
    const pending = all.filter((p) => p.status === 'pending');
    const decided = all.filter((p) => p.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 25);
    const budget = { n: 10 };
    const cards = await Promise.all(
      pending.map(async (p) => {
        const guild = c?.guilds.cache.get(p.guildId);
        const [author, img] = await Promise.all([face(p.authorId, budget), queueImage(p)]);
        const kindClass = p.draft.type === 'ssu' ? 'kind-ssu' : `kind-${p.draft.kind}`;
        const chName = guild?.channels.cache.get(p.channelId)?.name;
        return html`<section class="card approval" id="p-${p.id}">
          <div class="approval-main ${kindClass}">${draftBody(p.draft, guild)}${img ? html`<img class="preview-img" src="${img}" alt="Picture sent with the post">` : ''}</div>
          <div class="approval-side">
            <dl class="meta">
              <dt>From</dt><dd>${faceHtml(author)}</dd>
              <dt>Server</dt><dd>${guild?.name ?? p.guildId}</dd>
              <dt>Posts in</dt><dd>${chName ? `#${chName}` : 'unknown channel'}</dd>
              <dt>Sent</dt><dd title="${utc(p.createdAt)}">${ago(now() - p.createdAt)}</dd>
            </dl>
            <form method="post" action="/approvals" class="stack">
              ${csrfField(r.session)}<input type="hidden" name="action" value="decide"><input type="hidden" name="id" value="${p.id}">
              ${field('Reason (sent to them if you reject)', `reason-${p.id}`, html`<textarea id="reason-${p.id}" name="reason" rows="2" maxlength="500" placeholder="Optional"></textarea>`)}
              <div class="btn-row"><button class="ok" name="decision" value="approve">${icon('check')}Approve & post</button><button class="danger" name="decision" value="reject">${icon('x')}Reject</button></div>
            </form>
          </div>
        </section>`;
      }),
    );
    return page(r, {
      title: 'Approvals',
      nav: 'approvals',
      body: html`${pageHead('Approvals', 'Posts and SSUs from staff below the approver tier wait here until someone approves them. Approving posts it straight away.')}
      ${pending.length ? cards : card(null, empty('All caught up', 'Nothing is waiting for approval.', 'check'))}
      ${card(
        'Recently decided',
        decided.length
          ? html`<div class="table-wrap"><table><thead><tr><th>What</th><th>Server</th><th>Result</th><th>By</th><th>When</th><th></th></tr></thead><tbody>
            ${decided.map(
              (p) => html`<tr><td>${draftLabel(p.draft)}</td><td>${c?.guilds.cache.get(p.guildId)?.name ?? p.guildId}</td>
              <td>${p.status === 'approved' ? badge('Approved', 'ok') : badge('Rejected', 'bad')}${p.reason ? html` <small class="muted">${p.reason}</small>` : ''}</td>
              <td>${p.decidedBy ?? ''}</td><td class="nowrap">${p.decidedAt ? ago(now() - p.decidedAt) : ''}</td>
              <td>${p.postUrl ? html`<a href="${safeUrl(p.postUrl)}" target="_blank" rel="noreferrer noopener">Open ${icon('external')}</a>` : ''}</td></tr>`,
            )}</tbody></table></div>`
          : empty('Nothing decided yet', 'Approved and rejected posts from the last 30 days show here.', 'clock'),
        { flush: true },
      )}`,
    });
  }

  async function approvalsAction(r: Req): Promise<void> {
    if (r.form.action !== 'decide') throw new UserFacingError('Unknown action.');
    const approve = r.form.decision === 'approve';
    const by = r.session.user!;
    const post = await decideFromDashboard(services, client(), r.form.id ?? '', { approve, by: by.globalName ?? by.username, byDiscordId: by.id, reason: r.form.reason });
    flash(r.session, 'ok', approve ? `Approved and posted${post.postUrl ? `: ${post.postUrl}` : '.'}` : 'Rejected. The author has been told.');
  }

  // ---------- game log ----------

  async function freshGameLog(): Promise<GameLogEntry[]> {
    if (now() - services.adminLog.lastRefresh > GAME_LOG_FRESH_MS) {
      await services.adminLog.refresh().catch((err) => services.logger.warn({ err }, 'game log refresh failed'));
    }
    return services.adminLog.list();
  }

  interface LogFilter {
    q: string;
    who: string;
    cmd: string;
    src: 'all' | 'game' | 'discord';
    page: number;
  }

  function readFilter(u: URL): LogFilter {
    const src = u.searchParams.get('src');
    return {
      q: (u.searchParams.get('q') ?? '').trim().slice(0, 100),
      who: (u.searchParams.get('who') ?? '').trim().slice(0, 40),
      cmd: (u.searchParams.get('cmd') ?? '').trim().toLowerCase().slice(0, 30),
      src: src === 'game' || src === 'discord' ? src : 'all',
      page: Math.max(1, Math.min(10_000, Number(u.searchParams.get('page')) || 1)),
    };
  }

  function applyFilter(all: GameLogEntry[], f: LogFilter): GameLogEntry[] {
    const q = f.q.toLowerCase();
    const who = f.who.toLowerCase();
    return all.filter(
      (e) =>
        (!q || e.text.toLowerCase().includes(q) || e.by.toLowerCase().includes(q)) &&
        (!who || e.by.toLowerCase() === who) &&
        (!f.cmd || commandOf(e) === f.cmd) &&
        (f.src === 'all' || (f.src === 'discord') === e.viaDiscord),
    );
  }

  const filterQuery = (f: LogFilter, page?: number) => {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.who) p.set('who', f.who);
    if (f.cmd) p.set('cmd', f.cmd);
    if (f.src !== 'all') p.set('src', f.src);
    if (page && page > 1) p.set('page', String(page));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  const CMD_TONE: Record<string, Tone> = { ban: 'bad', kick: 'bad', unban: 'ok', warn: 'warn', announce: 'info', gannounce: 'info', system: 'muted' };

  async function gameLogPage(r: Req): Promise<string> {
    const all = await freshGameLog();
    const f = readFilter(r.url);
    const rows = applyFilter(all, f);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const pageNo = Math.min(f.page, pages);
    const shown = rows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
    const dir = await staffDirectory(shown.map((e) => e.by));
    const budget = { n: 15 };
    const commands = [...new Set(all.map(commandOf))].sort();
    const people = [...new Set(all.map((e) => e.by))].sort((a, b) => a.localeCompare(b));
    const a = services.adminLog;
    const status = a.lastError
      ? badge(`Couldn't read the game: ${a.lastError.slice(0, 80)}`, 'bad')
      : a.lastRefresh
        ? html`<span class="muted">Synced ${ago(now() - a.lastRefresh)} · ${all.length.toLocaleString('en-GB')} commands kept</span>`
        : html`<span class="muted">Not synced yet</span>`;
    const body = await Promise.all(
      shown.map(async (e) => {
        const info = dir.get(e.by.toLowerCase());
        const cmd = commandOf(e);
        const detail = cmd === 'system' ? e.text : e.text.replace(/^\s*[;:!/]?[A-Za-z_]+\s*/, '');
        const roblox =
          e.by === 'server'
            ? html`<span class="muted">Game (automatic)</span>`
            : html`<span class="who"><span class="stack-sm">${info?.robloxId ? html`<a href="${profileUrl(info.robloxId)}" target="_blank" rel="noreferrer noopener">${e.by}</a>` : html`<span>${e.by}</span>`}</span><a class="icon-btn" href="/game-log${filterQuery({ ...f, who: e.by, page: 1 })}" title="Only ${e.by}'s commands" aria-label="Only ${e.by}'s commands">${icon('search', 'ic sm')}</a></span>`;
        const discord = info?.link ? faceHtml(await face(info.link.discordId, budget), html`<code>${info.link.discordId}</code>`) : e.by === 'server' ? '' : badge('Not linked', 'muted');
        return html`<tr>
          <td class="nowrap" title="${utc(e.t * 1000)}">${ago(now() - e.t * 1000)}<br><small class="muted">${utc(e.t * 1000).slice(5)}</small></td>
          <td>${roblox}</td>
          <td>${discord}</td>
          <td class="nowrap">${badge(cmd, CMD_TONE[cmd] ?? 'accent')}${e.viaDiscord ? html` ${badge('via Discord', 'info')}` : ''}</td>
          <td class="wrap"><span class="cmd">${detail || '—'}</span></td>
        </tr>`;
      }),
    );
    const opt = (v: string, label: string, cur: string) => html`<option value="${v}"${v === cur ? new Html(' selected') : ''}>${label}</option>`;
    return page(r, {
      title: 'Game log',
      nav: 'gamelog',
      body: html`${pageHead(
        'Game log',
        html`Every admin command run in Hong Kong 1941, with who ran it and their linked Discord account. ${status}`,
        html`<form method="post" action="/game-log">${csrfField(r.session)}<input type="hidden" name="action" value="refresh"><button class="secondary">${icon('refresh')}Sync now</button></form>
        <a class="btn secondary" href="/game-log.csv${filterQuery({ ...f, page: 1 })}">${icon('download')}Download CSV</a>`,
      )}
      <section class="card flush">
        <form method="get" action="/game-log" class="toolbar">
          <div class="field grow"><label for="q">Search</label><span class="input-ic">${icon('search')}<input id="q" name="q" value="${f.q}" placeholder="Name, command or reason"></span></div>
          <div class="field"><label for="who">Staff member</label><select id="who" name="who">${opt('', 'Everyone', f.who)}${people.map((p) => opt(p, p === 'server' ? 'Game (automatic)' : p, f.who))}</select></div>
          <div class="field"><label for="cmd">Command</label><select id="cmd" name="cmd">${opt('', 'All commands', f.cmd)}${commands.map((c) => opt(c, c, f.cmd))}</select></div>
          <div class="field"><label for="src">Run from</label><select id="src" name="src">${opt('all', 'Game and Discord', f.src)}${opt('game', 'In game', f.src)}${opt('discord', 'Discord bot', f.src)}</select></div>
          <button>${icon('search')}Filter</button>${f.q || f.who || f.cmd || f.src !== 'all' ? html`<a class="btn secondary" href="/game-log">Clear</a>` : ''}
        </form>
        ${
          shown.length
            ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Roblox</th><th>Discord</th><th>Command</th><th>Details</th></tr></thead><tbody>${body}</tbody></table></div>
            <div class="pager"><span class="muted">${rows.length.toLocaleString('en-GB')} command${rows.length === 1 ? '' : 's'}${rows.length !== all.length ? ` (of ${all.length.toLocaleString('en-GB')})` : ''} · page ${pageNo} of ${pages}</span>
            <span class="btn-row">${pageNo > 1 ? html`<a class="btn sm secondary" href="/game-log${filterQuery(f, pageNo - 1)}">Newer</a>` : ''}${pageNo < pages ? html`<a class="btn sm secondary" href="/game-log${filterQuery(f, pageNo + 1)}">Older</a>` : ''}</span></div>`
            : empty(all.length ? 'No commands match' : 'No commands yet', all.length ? 'Try a different search or clear the filters.' : 'Commands staff run in game (;kick, ;ban, ;award…) appear here within a few minutes.', 'log')
        }
      </section>
      <p class="muted">The game itself keeps the latest 200 commands; the bot saves a copy every few minutes, so this history grows over time. Names are matched to Discord through linked accounts.</p>`,
    });
  }

  async function gameLogCsv(r: Req): Promise<Raw> {
    const rows = applyFilter(await services.adminLog.list(), readFilter(r.url));
    const dir = await staffDirectory(rows.map((e) => e.by), 0);
    const lines = [['time_utc', 'roblox_name', 'roblox_id', 'discord_id', 'command', 'text', 'run_from'].join(',')];
    for (const e of rows) {
      const info = dir.get(e.by.toLowerCase());
      lines.push([utc(e.t * 1000), e.by, info?.robloxId ?? '', info?.link?.discordId ?? '', commandOf(e), e.text, e.viaDiscord ? 'discord' : 'game'].map(csvCell).join(','));
    }
    return new Raw(lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="hk1941-game-log.csv"' });
  }

  async function gameLogAction(r: Req): Promise<void> {
    if (r.form.action !== 'refresh') throw new UserFacingError('Unknown action.');
    try {
      const added = await services.adminLog.refresh();
      flash(r.session, 'ok', added ? `Synced: ${added} new command${added === 1 ? '' : 's'}.` : 'Synced. Nothing new.');
    } catch (err) {
      throw new UserFacingError(`Couldn't read the game's log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- servers ----------

  async function serversPage(r: Req): Promise<string> {
    const guilds = [...client().guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    const pending = await pendingPosts();
    const cards = await Promise.all(
      guilds.map(async (g) => {
        const s = await services.guilds.get(g.id);
        const waiting = pending.filter((p) => p.guildId === g.id).length;
        const check = (ok: boolean, text: string) => html`<li><span class="dot ${ok ? 'ok' : ''}"></span>${text}</li>`;
        return html`<section class="card server-card">
          <div class="server-top">${guildIcon(g)}<div><h2>${g.name}</h2><span class="muted">${g.memberCount.toLocaleString('en-GB')} members</span></div></div>
          <ul class="checklist">
            ${check(Object.keys(s.staffRoles).length > 0, `${Object.keys(s.staffRoles).length} staff role${Object.keys(s.staffRoles).length === 1 ? '' : 's'}`)}
            ${check(!!s.verifiedRoleId, s.verifiedRoleId ? 'Verified role set' : 'No verified role')}
            ${check((s.rankBinds ?? []).length > 0, `${(s.rankBinds ?? []).length} rank bind${(s.rankBinds ?? []).length === 1 ? '' : 's'}`)}
            ${check(!!s.approvalChannelId, s.approvalChannelId ? 'Approval queue set' : 'No approval queue')}
            ${check(!!s.auditChannelId, s.auditChannelId ? 'Audit log set' : 'No audit log')}
          </ul>
          <div class="btn-row"><a class="btn" href="/servers/${g.id}">Manage</a>${waiting ? html`<a class="btn secondary" href="/approvals">${waiting} waiting</a>` : ''}</div>
        </section>`;
      }),
    );
    return page(r, {
      title: 'Servers',
      nav: 'servers',
      body: html`${pageHead('Servers', 'Every Discord server the bot is in. Green dots are set up.')}
      ${guilds.length ? html`<div class="grid">${cards}</div>` : card(null, empty('Not in any server yet', 'Invite the bot with the link in the README.', 'server'))}`,
    });
  }

  async function serverPage(r: Req, guild: Guild): Promise<string> {
    const s = await services.guilds.get(guild.id);
    const tab: ServerTab = isTab(r.url.searchParams.get('tab')) ? (r.url.searchParams.get('tab') as ServerTab) : 'channels';
    const ch = channelOptions(guild);
    const roles = roleOptions(guild);
    const roleName = (id: string) => guild.roles.cache.get(id)?.name ?? `deleted role ${id}`;
    const army = services.config.roblox.armyGroupId;
    const hidden = (action: string) => html`${csrfField(r.session)}<input type="hidden" name="action" value="${action}"><input type="hidden" name="tab" value="${tab}">`;
    const save = (label = 'Save changes') => html`<div class="btn-row"><button>${icon('check')}${label}</button></div>`;
    let content: Html;

    if (tab === 'channels') {
      content = card(
        'Channels',
        html`<form method="post">${hidden('channels')}<div class="fields">
          ${field('Audit log', 'auditChannelId', select('auditChannelId', ch, s.auditChannelId), 'Every staff action from Discord is logged here.')}
          ${field('Event calendar', 'eventChannelId', select('eventChannelId', ch, s.eventChannelId), 'A live list of upcoming in-game events.')}
          ${field('Approval queue', 'approvalChannelId', select('approvalChannelId', ch, s.approvalChannelId), 'Posts waiting for approval are also shown here.')}
          ${field('Posts (default)', 'postChannelId', select('postChannelId', ch, s.postChannelId), 'Where /post sends to unless a channel is picked.')}
          ${field('SSUs (default)', 'ssuChannelId', select('ssuChannelId', ch, s.ssuChannelId, { none: '— the post channel —' }), 'Where /ssu sends to.')}
        </div>${save()}</form>`,
      );
    } else if (tab === 'verification') {
      content = html`${card(
        'Verification',
        html`<form method="post">${hidden('verification')}<div class="fields">
          ${field('Verified role', 'verifiedRoleId', select('verifiedRoleId', roles, s.verifiedRoleId), 'Given to everyone who links their Roblox account.')}
          ${field('Unverified role', 'unverifiedRoleId', select('unverifiedRoleId', roles, s.unverifiedRoleId), 'Taken away when they verify.')}
          ${field('Nickname', 'nicknameTemplate', html`<input id="nicknameTemplate" name="nicknameTemplate" maxlength="60" value="${s.nicknameTemplate ?? ''}" placeholder="e.g. {rank} | {roblox}">`, `Use ${NICKNAME_TOKENS.join(' ')}. Leave empty to leave nicknames alone.`)}
        </div>${save()}</form>`,
      )}
      ${card(
        'Verify panel',
        html`<p class="muted">Posts a message with Verify and Update buttons that anyone can press.</p>
        <form method="post" class="row">${hidden('verify-panel')}${field('Channel', 'panelChannel', select('channelId', ch, undefined, { none: null, id: 'panelChannel' }))}<button>Post panel</button></form>`,
      )}`;
    } else if (tab === 'binds') {
      let armyRanks: { rank: number; name: string }[] = [];
      try {
        armyRanks = (await services.groups.listRoles(army)).filter((x) => x.rank > 0).map((x) => ({ rank: x.rank, name: x.name }));
      } catch {
        armyRanks = [];
      }
      const rankName = (n: number) => armyRanks.find((x) => x.rank === n)?.name;
      content = html`${card(
        'Rank binds',
        (s.rankBinds ?? []).length
          ? html`<div class="table-wrap"><table><thead><tr><th>Role</th><th>Ranks</th><th>Group</th><th></th></tr></thead><tbody>
            ${(s.rankBinds ?? []).map(
              (b) => html`<tr><td>@${roleName(b.roleId)}</td><td>${b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`}${b.groupId === army && rankName(b.min) ? html` <small class="muted">${rankName(b.min)}${b.max !== b.min && rankName(b.max) ? ` – ${rankName(b.max)}` : ''}</small>` : ''}</td><td>${b.groupId === army ? 'Army' : b.groupId}</td>
              <td><form method="post">${hidden('unbind')}<input type="hidden" name="roleId" value="${b.roleId}"><input type="hidden" name="groupId" value="${b.groupId}"><button class="secondary sm">Remove</button></form></td></tr>`,
            )}</tbody></table></div>`
          : empty('No binds yet', 'Add one below to give a role to everyone in a range of Roblox ranks.', 'users'),
        { flush: (s.rankBinds ?? []).length > 0 },
      )}
      ${card(
        'Add a bind',
        html`<p class="muted">Members whose Roblox group rank is in the range get the role, and lose it when they leave the range.</p>
        <form method="post" class="row">${hidden('bind')}
          ${field('Role', 'bindRole', select('roleId', roles, undefined, { none: null, id: 'bindRole' }))}
          <div class="field narrow"><label for="min">Lowest rank</label><input id="min" name="min" type="number" min="1" max="255" required></div>
          <div class="field narrow"><label for="max">Highest rank</label><input id="max" name="max" type="number" min="1" max="255" placeholder="same"></div>
          <div class="field narrow"><label for="groupId">Group ID</label><input id="groupId" name="groupId" type="number" min="1" value="${army}"></div>
          <button>Add bind</button></form>
        ${armyRanks.length ? html`<p class="hint">Army ranks: ${armyRanks.map((x) => `${x.rank} ${x.name}`).join(' · ')}</p>` : ''}`,
      )}`;
    } else if (tab === 'staff') {
      const entries = Object.entries(s.staffRoles).sort((a, b) => b[1] - a[1]);
      content = html`${card(
        'Staff roles',
        entries.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Role</th><th>Tier</th><th></th></tr></thead><tbody>
            ${entries.map(
              ([id, t]) => html`<tr><td>@${roleName(id)}</td><td>${badge(`${t} · ${TIER_NAMES[t]}`, t >= 4 ? 'bad' : t >= 3 ? 'warn' : 'info')}</td>
              <td><form method="post">${hidden('staff-role')}<input type="hidden" name="roleId" value="${id}"><input type="hidden" name="tier" value="0"><button class="secondary sm">Remove</button></form></td></tr>`,
            )}</tbody></table></div>`
          : empty('No staff roles', 'Give a Discord role an HKAdmin tier below.', 'shield'),
        { flush: entries.length > 0 },
      )}
      ${card(
        'Set a staff tier',
        html`<p class="muted">Discord roles that count as an HKAdmin tier in this server. Same numbers as in game.</p>
        <form method="post" class="row">${hidden('staff-role')}${field('Role', 'staffRole', select('roleId', roles, undefined, { none: null, id: 'staffRole' }))}${field('Tier', 'tier', select('tier', TIER_OPTIONS, undefined, { none: null }))}<button>Set tier</button></form>`,
      )}`;
    } else {
      content = card(
        'Posts and events',
        html`<form method="post">${hidden('options')}<div class="fields">
          ${field('Who can post without approval', 'postApproverTier', select('postApproverTier', TIER_OPTIONS, String(s.postApproverTier ?? DEFAULT_APPROVER_TIER), { none: null }), 'This tier and above also approve other people’s posts.')}
          ${field('Event reminder ping', 'eventPingRoleId', select('eventPingRoleId', roles, s.eventPingRoleId, { none: '— no ping —' }))}
          <div class="field"><label>Game events</label><label class="check"><input type="checkbox" name="eventSync" value="1"${s.eventSync === false ? '' : new Html(' checked')}> Sync events with the game</label></div>
        </div>${save()}</form>`,
      );
    }

    const waiting = (await pendingPosts(guild.id)).length;
    return page(r, {
      title: guild.name,
      nav: 'servers',
      body: html`<header class="page-head"><div class="server-top">${guildIcon(guild, 52)}<div><h1>${guild.name}</h1><p class="sub">${guild.memberCount.toLocaleString('en-GB')} members · <a href="/servers">All servers</a>${waiting ? html` · <a href="/approvals">${waiting} waiting for approval</a>` : ''}</p></div></div></header>
      <nav class="tabs" aria-label="Server settings">${SERVER_TABS.map(([k, label]) => html`<a href="/servers/${guild.id}?tab=${k}"${k === tab ? new Html(' aria-current="page"') : ''}>${label}</a>`)}</nav>
      ${content}`,
    });
  }

  // ---------- linked accounts ----------

  async function linksPage(r: Req): Promise<string> {
    const q = (r.url.searchParams.get('q') ?? '').trim().slice(0, 60);
    const pageWanted = Math.max(1, Number(r.url.searchParams.get('page')) || 1);
    const all = await services.links.all();
    let rows = all.sort((a, b) => b.linkedAt - a.linkedAt);
    if (q) {
      const lower = q.toLowerCase();
      rows = rows.filter((l) => l.discordId === q || String(l.robloxId) === q || l.robloxName.toLowerCase().includes(lower) || (deps.client()?.users.cache.get(l.discordId)?.username ?? '').toLowerCase().includes(lower));
    }
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const pageNo = Math.min(pageWanted, pages);
    const shown = rows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
    const budget = { n: 10 };
    const body = await Promise.all(
      shown.map(
        async (l) => html`<tr><td>${faceHtml(await face(l.discordId, budget), html`<code>${l.discordId}</code>`)}</td>
        <td><a href="${profileUrl(l.robloxId)}" rel="noreferrer noopener" target="_blank">${l.robloxName}</a><br><small class="muted">${l.robloxId}</small></td>
        <td>${badge(l.method === 'game' ? 'In game' : l.method === 'manual' ? 'By hand' : l.method === 'blurb' ? 'Profile phrase' : l.method, l.method === 'manual' ? 'warn' : 'muted')}</td>
        <td class="nowrap">${new Date(l.linkedAt * 1000).toISOString().slice(0, 10)}</td>
        <td><form method="post" class="inline">${csrfField(r.session)}<input type="hidden" name="discordId" value="${l.discordId}"><button class="secondary sm" name="action" value="update">Update roles</button><button class="danger sm" name="action" value="unlink">Unlink</button></form></td></tr>`,
      ),
    );
    const qs = (p: number) => `/links?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) }).toString()}`;
    return page(r, {
      title: 'Linked accounts',
      nav: 'links',
      body: html`${pageHead('Linked accounts', `${all.length.toLocaleString('en-GB')} Discord accounts linked to Roblox.`)}
      <section class="card flush">
        <form method="get" class="toolbar"><div class="field grow"><label for="q">Search</label><span class="input-ic">${icon('search')}<input id="q" name="q" value="${q}" placeholder="Discord name or ID, Roblox name or ID"></span></div><button>${icon('search')}Search</button>${q ? html`<a class="btn secondary" href="/links">Clear</a>` : ''}</form>
        ${
          shown.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Discord</th><th>Roblox</th><th>How</th><th>Linked</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
            <div class="pager"><span class="muted">${rows.length} match${rows.length === 1 ? '' : 'es'} · page ${pageNo} of ${pages}</span><span class="btn-row">${pageNo > 1 ? html`<a class="btn sm secondary" href="${qs(pageNo - 1)}">Previous</a>` : ''}${pageNo < pages ? html`<a class="btn sm secondary" href="${qs(pageNo + 1)}">Next</a>` : ''}</span></div>`
            : empty(q ? 'No matches' : 'Nobody has linked yet', q ? 'Try another name or ID.' : 'Members link with /verify in Discord.', 'link')
        }
      </section>
      ${card(
        'Link someone by hand',
        html`<p class="muted">For when someone can't verify. It replaces any link either account already has.</p>
        <form method="post" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="link">
          ${field('Discord user ID', 'discordId', html`<input id="discordId" name="discordId" pattern="\\d{15,25}" required placeholder="e.g. 427963750492078…">`)}
          ${field('Roblox username or ID', 'roblox', html`<input id="roblox" name="roblox" required maxlength="40">`)}
          <button>Link accounts</button></form>`,
      )}`,
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
      case 'decide':
        return approvalsAction(r);
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

  async function route(r: Req): Promise<string | Redirect | Raw> {
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
      // remember where they were going, but only real pages (not /favicon.ico and friends)
      if (r.method === 'GET' && RETURNABLE.test(path)) s.oauth = { state: '', next: path + r.url.search };
      return new Redirect('/login');
    }

    if (r.method === 'POST') {
      const m = /^\/servers\/(\d{15,25})$/.exec(path);
      let back = path;
      try {
        if (m) {
          await serverAction(r, guildOr404(m[1]!));
          if (isTab(r.form.tab)) back = `${path}?tab=${r.form.tab}`;
        } else if (path === '/approvals') await approvalsAction(r);
        else if (path === '/game-log') await gameLogAction(r);
        else if (path === '/links') {
          await linksAction(r);
          back = path + r.url.search;
        } else throw new UserFacingError('Unknown form.');
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        flash(s, 'bad', err.message);
        if (m && isTab(r.form.tab)) back = `${path}?tab=${r.form.tab}`;
      }
      return new Redirect(back);
    }

    if (path === '/') return overview(r);
    if (path === '/approvals') return approvalsPage(r);
    if (path === '/game-log') return gameLogPage(r);
    if (path === '/game-log.csv') return gameLogCsv(r);
    if (path === '/servers') return serversPage(r);
    const sm = /^\/servers\/(\d{15,25})$/.exec(path);
    if (sm) return serverPage(r, guildOr404(sm[1]!));
    if (path === '/links') return linksPage(r);
    throw new NotFound();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {
      'content-security-policy':
        "default-src 'none'; style-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
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
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      res.writeHead(200, { ...headers, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      res.end(FAVICON);
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
    const problem = (title: string, text: string, status: number) =>
      send(status, layout({ title, session, counts: {}, body: html`${card(null, html`${empty(title, text, 'x')}<p class="btn-row"><a class="btn secondary" href="/">Back to the overview</a></p>`)}` }));
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      let form: Record<string, string> = {};
      if (method === 'POST') {
        form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        if (!sameToken(form._csrf, session.csrf)) {
          problem('That form expired', 'Go back, refresh the page and try again.', 403);
          return;
        }
      } else if (method !== 'GET' && method !== 'HEAD') {
        send(405, 'Method not allowed', { allow: 'GET, POST' });
        return;
      }
      const out = await route({ method, url, session, form });
      if (out instanceof Redirect) send(303, '', { location: out.to });
      else if (out instanceof Raw) send(200, out.body, { 'content-type': out.type, ...out.headers });
      else send(200, out);
    } catch (err) {
      if (err instanceof SignedIn) {
        const fresh = sessions.renew(session, { user: err.user });
        cookies.splice(0, cookies.length, fresh.setCookie);
        services.logger.info({ user: err.user.id }, 'dashboard sign-in');
        const next = err.next && err.next.startsWith('/') && !err.next.startsWith('//') && RETURNABLE.test(err.next.split('?')[0]!) ? err.next : '/';
        send(303, '', { location: next });
      } else if (err instanceof SignedOut) {
        cookies.splice(0, cookies.length, sessions.destroy(session));
        send(303, '', { location: '/login' });
      } else if (err instanceof NotFound) {
        problem('Page not found', 'That page doesn’t exist.', 404);
      } else if (err instanceof UserFacingError || err instanceof OAuthError) {
        problem("Something's not right", err.message, 400);
      } else {
        services.logger.error({ err, path: url.pathname }, 'dashboard request failed');
        problem('Something went wrong', 'The details are in the bot log.', 500);
      }
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  // keep copying the in-game admin log, so its history outlives the game's 200-entry limit
  const pollMs = deps.gameLogPollMs ?? 3 * 60_000;
  let poll: NodeJS.Timeout | undefined;
  let firstPoll: NodeJS.Timeout | undefined;
  const pollOnce = () => {
    services.adminLog.refresh().catch((err) => services.logger.debug({ err }, 'game log copy failed'));
  };

  return {
    server,
    /** Start listening; resolves with the actual port (useful with port 0 in tests). */
    listen(port = cfg.port, host = cfg.host): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          if (pollMs > 0) {
            firstPoll = setTimeout(pollOnce, 5_000).unref();
            poll = setInterval(pollOnce, pollMs).unref();
          }
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close(): Promise<void> {
      clearTimeout(firstPoll);
      clearInterval(poll);
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
