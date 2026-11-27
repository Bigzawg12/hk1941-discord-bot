import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelType, type Client, type Guild } from 'discord.js';
import { verifyPanel } from '../commands/verify.js';
import { commandOf, type GameLogEntry } from '../game/adminLogArchive.js';
import { CERT_BY_ID, MAX_STRIPES, MEDAL_BY_ID, RANKS } from '../game/gameConfig.js';
import { computePoints, hours, standing } from '../game/points.js';
import { assignable, changeRank, nextRole, progressOf, rosterFor, type Roster } from '../game/promotions.js';
import type { GuildSettings, StaffTier } from '../guilds/settings.js';
import { describeSync, NICKNAME_TOKENS, syncEverywhere } from '../linking/memberSync.js';
import type { AccountLink } from '../linking/store.js';
import { Tier, TIER_NAMES } from '../permissions/tiers.js';
import type { ImageFile } from '../posts/images.js';
import { fetchPanelMessage, readPanel, savePanel } from '../posts/panels.js';
import {
  collapseText,
  COLOUR_CHOICES,
  colourNameOf,
  draftLabel,
  expandText,
  parseButtons,
  POST_KINDS,
  type ColourName,
  type Draft,
  type PanelDraft,
} from '../posts/render.js';
import type { PendingPost } from '../posts/store.js';
import { decideFromDashboard, DEFAULT_APPROVER_TIER } from '../posts/workflow.js';
import type { GroupRole } from '../roblox/groups.js';
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
import { discordMarkdown } from './markdown.js';
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
  /** how long a Promotions page waits for a group scan before showing the last one (ms) */
  scanWaitMs?: number;
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
/** The group's crest (assets/logo.png), shown in the sidebar, on the sign-in page and as the tab icon. */
const LOGO: Buffer | null = (() => {
  try {
    return readFileSync(new URL('../../assets/logo.png', import.meta.url));
  } catch {
    return null;
  }
})();
const PAGE_SIZE = 50;
const startedAt = Date.now();
/** Game log: read the game again when the page is opened and the copy is older than this. */
const GAME_LOG_FRESH_MS = 60_000;
/** Pages a sign-in may return to (never /favicon.ico and the like). */
const RETURNABLE = /^\/(approvals|promotions|members(\/\d{1,19})?|game-log|servers(\/\d{15,25})?|panels(\/new|\/\d{15,25})?|links)?$/;

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

  async function page(r: Req, opts: { title: string; nav?: string; body: Html; refreshSec?: number }): Promise<string> {
    const approvals = (await pendingPosts().catch(() => [])).length;
    return layout({ ...opts, session: r.session, counts: { approvals }, path: r.url.pathname + r.url.search });
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
        <img class="login-logo" src="/static/logo.png" alt="" width="88" height="88">
        <h1>Hong Kong 1941</h1>
        <p class="kicker">Staff dashboard</p>
        ${
          denied
            ? html`<p class="flash bad">That Discord account isn't on the dashboard's admin list.</p>`
            : html`<p class="muted">Sign in with your Discord account to continue.</p>`
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
        return html`<li><span class="grow"><span class="title">${info?.robloxId ? html`<a href="/members/${info.robloxId}">${e.by}</a>` : e.by}${e.viaDiscord ? html` ${badge('via Discord', 'info')}` : ''}</span><span class="cmd">${e.text}</span></span><span class="muted nowrap">${discord ? discord.name : ''}<br><small>${ago(now() - e.t * 1000)}</small></span></li>`;
      }),
    );
    const stat = (href: string | null, _ic: string, tone: string, n: string | number, label: string, extra = '') =>
      href
        ? html`<a class="stat ${tone}" href="${href}"><span class="stat-n">${n}</span><span class="stat-l">${label}${extra}</span></a>`
        : html`<div class="stat ${tone}"><span class="stat-n">${n}</span><span class="stat-l">${label}${extra}</span></div>`;
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
            : html`<span class="who"><span class="stack-sm">${info?.robloxId ? html`<a href="/members/${info.robloxId}">${e.by}</a>` : html`<span>${e.by}</span>`}</span><a class="icon-btn" href="/game-log${filterQuery({ ...f, who: e.by, page: 1 })}" title="Only ${e.by}'s commands" aria-label="Only ${e.by}'s commands">${icon('search', 'ic sm')}</a></span>`;
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
        <td><a href="/members/${l.robloxId}">${l.robloxName}</a><br><small class="muted">${l.robloxId}</small></td>
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

  // ---------- promotions ----------

  const PROMO_TABS = [
    ['queue', 'Ready for promotion'],
    ['progress', 'Progress by rank'],
    ['history', 'History'],
  ] as const;
  type PromoTab = (typeof PROMO_TABS)[number][0];
  const LADDER = Object.keys(RANKS).map(Number).sort((a, b) => a - b);
  const memberLink = (id: number, name: string) => html`<a class="strong" href="/members/${id}">${name}</a>`;

  /** Avatar + name (linked to their member page) for a list of Roblox users. */
  async function people(ids: number[]): Promise<(id: number, sub?: string | Html) => Html> {
    const [names, heads] = await Promise.all([services.users.namesFor(ids), services.users.headshots(ids)]);
    return (id, sub) => {
      const name = names.get(id)?.name ?? `User ${id}`;
      const img = heads.get(id);
      return html`<span class="who">${img ? html`<img src="${img}" alt="" width="28" height="28">` : html`<span class="avatar-ph">${initials(name)}</span>`}<span class="stack-sm">${memberLink(id, name)}${sub ? html`<small>${sub}</small>` : ''}</span></span>`;
    };
  }

  const bar = (have: number, need: number) =>
    html`<span class="bar"><progress max="${Math.max(need, 1)}" value="${Math.min(have, Math.max(need, 1))}"></progress><small>${have.toLocaleString('en-GB')} / ${need.toLocaleString('en-GB')}</small></span>`;

  /** A scan to show: fresh if it finishes quickly, else the last one (and a scan keeps going). */
  async function rosterNow(onlyRank: number | null): Promise<{ roster: Roster | null; updating: boolean; error?: string }> {
    const scanner = rosterFor(services);
    const run = scanner.load(onlyRank).catch(() => null);
    const waited = await Promise.race([run, new Promise<null>((res) => setTimeout(() => res(null), deps.scanWaitMs ?? 6000).unref())]);
    const roster = waited ?? scanner.cached(onlyRank);
    const key = onlyRank === null ? 'all' : String(onlyRank);
    return { roster, updating: scanner.isRunning(onlyRank), error: scanner.errors.get(key) };
  }

  function scanStatus(onlyRank: number | null, s: { roster: Roster | null; updating: boolean; error?: string }): Html {
    const key = onlyRank === null ? 'all' : String(onlyRank);
    const p = rosterFor(services).progress.get(key);
    if (s.error && !s.updating) return badge(`Couldn't read the group: ${s.error.slice(0, 80)}`, 'bad');
    if (s.updating) return html`<span class="muted">Checking the group${p?.total ? ` · ${p.done} of ${p.total} records read` : ''}…</span>`;
    if (!s.roster) return html`<span class="muted">Not checked yet</span>`;
    return html`<span class="muted">Checked ${ago(now() - s.roster.at)} · ${s.roster.checked} members${s.roster.capped ? ' (stopped at ELIGIBLE_MAX_PROFILES)' : ''}</span>`;
  }

  async function promotionsPage(r: Req): Promise<string> {
    const tabParam = r.url.searchParams.get('tab');
    const tab: PromoTab = PROMO_TABS.some(([k]) => k === tabParam) ? (tabParam as PromoTab) : 'queue';
    const group = services.config.roblox.armyGroupId;
    const roles = await services.groups.listRoles(group).catch(() => [] as GroupRole[]);
    const roleAt = (rank: number) => roles.find((x) => x.rank === rank);
    let content: Html;
    let scanFor: number | null = null;
    let status: Html = html``;
    let refresh = false;

    if (tab === 'history') {
      const list = (await services.promotionLog.list()).slice(0, 200);
      const who = await people(list.map((e) => e.userId));
      content = card(
        null,
        list.length
          ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Member</th><th>Change</th><th>By</th><th>Reason</th></tr></thead><tbody>
            ${list.map(
              (e) => html`<tr><td class="nowrap" title="${utc(e.t)}">${ago(now() - e.t)}</td><td>${who(e.userId)}</td>
              <td class="nowrap">${e.from} → <b>${e.to}</b> ${e.toRank > e.fromRank ? badge('Promotion', 'ok') : badge('Rank change', 'warn')}</td>
              <td>${e.by}</td><td class="wrap">${e.reason ?? ''}</td></tr>`,
            )}</tbody></table></div>`
          : empty('No rank changes yet', 'Promotions made with /promote or on this dashboard are listed here.'),
        { flush: list.length > 0 },
      );
    } else if (tab === 'progress') {
      const want = Number(r.url.searchParams.get('rank'));
      const rank = LADDER.includes(want) ? want : LADDER[0]!;
      scanFor = rank;
      const s = await rosterNow(rank);
      status = scanStatus(rank, s);
      refresh = s.updating && !s.roster;
      const chips = html`<nav class="chips" aria-label="Rank">${LADDER.map((k) => html`<a href="/promotions?tab=progress&rank=${k}"${k === rank ? new Html(' aria-current="page"') : ''}>${roleAt(k)?.name ?? `Rank ${k}`}</a>`)}</nav>`;
      const req = RANKS[rank]!;
      const rows = (s.roster?.entries ?? []).slice().sort((a, b) => progressOf(b) - progressOf(a) || b.points - a.points);
      const pageNo = Math.max(1, Math.min(Math.ceil(rows.length / PAGE_SIZE) || 1, Number(r.url.searchParams.get('page')) || 1));
      const shown = rows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
      const who = await people(shown.map((e) => e.userId));
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      content = html`${chips}
      ${card(
        null,
        html`<div class="card-head pad"><h2>${roleAt(rank)?.name ?? `Rank ${rank}`} → ${req.next}</h2><span class="muted">Needs ${req.points} points and ${req.trainings} trainings</span></div>
        ${
          shown.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Member</th><th>Points</th><th>Trainings</th><th>Status</th><th></th></tr></thead><tbody>
              ${shown.map(
                (e) => html`<tr><td>${who(e.userId)}</td><td>${bar(e.points, req.points)}</td><td>${bar(e.trainings, req.trainings)}</td>
                <td class="nowrap">${!e.hasProfile ? badge('No record', 'muted') : e.eligible ? badge('Ready', 'ok') : html`<span class="muted">${Math.round(progressOf(e) * 100)}%</span>`}</td>
                <td class="nowrap right"><a class="btn sm secondary" href="/members/${e.userId}">Open</a></td></tr>`,
              )}</tbody></table></div>
              ${pages > 1 ? html`<div class="pager"><span class="muted">${rows.length} members · page ${pageNo} of ${pages}</span><span class="btn-row">${pageNo > 1 ? html`<a class="btn sm secondary" href="/promotions?tab=progress&rank=${rank}&page=${pageNo - 1}">Previous</a>` : ''}${pageNo < pages ? html`<a class="btn sm secondary" href="/promotions?tab=progress&rank=${rank}&page=${pageNo + 1}">Next</a>` : ''}</span></div>` : ''}`
            : s.roster
              ? empty('Nobody at this rank', 'Nobody in the army group holds this rank right now.')
              : empty('Checking the group…', 'This page refreshes by itself.')
        }`,
        { flush: true },
      )}`;
    } else {
      const s = await rosterNow(null);
      status = scanStatus(null, s);
      refresh = s.updating && !s.roster;
      const ready = (s.roster?.entries ?? []).filter((e) => e.eligible && e.next).sort((a, b) => a.rank - b.rank || b.points - a.points);
      const who = await people(ready.map((e) => e.userId));
      const links = await services.links.all();
      const linkOf = new Map(links.map((l) => [l.robloxId, l]));
      const budget = { n: 10 };
      const rows = await Promise.all(
        ready.map(async (e) => {
          const to = nextRole(roles, e.rank);
          const l = linkOf.get(e.userId);
          return html`<tr><td>${who(e.userId)}</td>
            <td class="nowrap">${e.roleName} → <b>${to?.name ?? e.next!.next}</b></td>
            <td class="nowrap">${e.points} <small class="muted">/ ${e.next!.points}</small></td>
            <td class="nowrap">${e.trainings} <small class="muted">/ ${e.next!.trainings}</small></td>
            <td>${l ? faceHtml(await face(l.discordId, budget)) : badge('Not linked', 'muted')}</td>
            <td class="nowrap right">${to ? html`<a class="btn sm secondary" href="/members/${e.userId}?promote=${to.id}">Review & promote</a>` : ''}</td></tr>`;
        }),
      );
      content = card(
        null,
        ready.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Member</th><th>Promotion</th><th>Points</th><th>Trainings</th><th>Discord</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : s.roster
            ? empty('Nobody is ready right now', 'Members show up here once they have the points and trainings for their next rank.')
            : empty('Checking the group…', 'Reading everyone’s service record. This page refreshes by itself.'),
        { flush: ready.length > 0 },
      );
    }

    return page(r, {
      title: 'Promotions',
      nav: 'promotions',
      refreshSec: refresh ? 5 : undefined,
      body: html`${pageHead(
        'Promotions',
        html`Points-ladder ranks in the army group. Officer ranks are by selection: change those from a member’s page. ${tab === 'history' ? '' : status}`,
        html`<form method="get" action="/members" class="search-inline"><input name="q" placeholder="Roblox name or ID" aria-label="Find a member" required><button class="secondary">Find</button></form>
        ${tab === 'history' ? '' : html`<form method="post" action="/promotions">${csrfField(r.session)}<input type="hidden" name="action" value="refresh"><input type="hidden" name="back" value="${r.url.pathname + r.url.search}"><input type="hidden" name="rank" value="${scanFor ?? ''}"><button class="secondary">Check again</button></form>`}`,
      )}
      <nav class="tabs" aria-label="Promotions">${PROMO_TABS.map(([k, label]) => html`<a href="/promotions?tab=${k}"${k === tab ? new Html(' aria-current="page"') : ''}>${label}</a>`)}</nav>
      ${content}`,
    });
  }

  async function promotionsAction(r: Req): Promise<Redirect> {
    if (r.form.action !== 'refresh') throw new UserFacingError('Unknown action.');
    const rank = Number(r.form.rank);
    rosterFor(services)
      .load(LADDER.includes(rank) ? rank : null, { force: true })
      .catch((err) => services.logger.warn({ err }, 'roster scan failed'));
    flash(r.session, 'ok', 'Checking the group again. It takes a moment for a big group.');
    const back = r.form.back ?? '/promotions';
    return new Redirect(back.startsWith('/promotions') ? back : '/promotions');
  }

  // ---------- members ----------

  async function membersPage(r: Req): Promise<string | Redirect> {
    const q = (r.url.searchParams.get('q') ?? '').trim().slice(0, 100);
    let notFound = false;
    if (q) {
      const u = await services.users.resolve(q).catch(() => null);
      if (u) return new Redirect(`/members/${u.id}`);
      notFound = true;
    }
    const recent = (await services.promotionLog.list()).slice(0, 8);
    const who = await people(recent.map((e) => e.userId));
    return page(r, {
      title: 'Members',
      nav: 'members',
      body: html`${pageHead('Members', 'Look up anyone by their Roblox name or ID to see their rank, progress, medals and record.')}
      ${card(
        null,
        html`<form method="get" action="/members" class="row"><div class="field grow"><label for="q">Roblox name, ID or profile link</label><span class="input-ic">${icon('search')}<input id="q" name="q" value="${q}" required autofocus></span></div><button>Find</button></form>
        ${notFound ? html`<p class="flash bad">No Roblox user called “${q}”.</p>` : ''}`,
      )}
      ${card(
        'Recently promoted',
        recent.length
          ? html`<ul class="list">${recent.map((e) => html`<li><span class="grow">${who(e.userId, `${e.from} → ${e.to}`)}</span><span class="muted nowrap">${ago(now() - e.t)}</span></li>`)}</ul>`
          : empty('Nothing yet', 'Rank changes made through the bot show here.'),
        { action: html`<a href="/promotions?tab=history">History</a>` },
      )}`,
    });
  }

  const PUNISH = new Set(['kick', 'ban', 'unban', 'warn', 'jail', 'unjail', 'mute', 'unmute', 'release', 'arrest', 'pban', 'tban']);

  async function memberPage(r: Req, id: number): Promise<string> {
    const user = await services.users.getById(id);
    if (!user) throw new UserFacingError('There is no Roblox user with that ID.');
    const group = services.config.roblox.armyGroupId;
    const [rank, roles, profile, ban, link, heads, history, log, staff] = await Promise.all([
      services.groups.rankIn(group, id).catch(() => null),
      services.groups.listRoles(group).catch(() => [] as GroupRole[]),
      services.profiles.get(id).catch(() => null),
      services.global.ban(id).catch(() => null),
      services.links.findByRoblox(id),
      services.users.headshots([id]),
      services.promotionLog.list(id),
      services.adminLog.list(),
      services.global.staff().catch(() => ({}) as Record<string, { tier?: number }>),
    ]);
    const d = profile?.data;
    const nowSec = now() / 1000;
    const st = d && rank ? standing(d, rank.rank) : null;
    const to = rank ? nextRole(roles, rank.rank) : undefined;
    const want = Number(r.url.searchParams.get('promote'));
    const proposed = assignable(roles).find((x) => x.id === want);
    const staffTier = staff[String(id)]?.tier;
    const banned = ban && (ban.untilT === 0 || ban.untilT > nowSec);
    const lower = user.name.toLowerCase();
    const nameRe = new RegExp(`(^|[^A-Za-z0-9_])${user.name.replace(/[^A-Za-z0-9_]/g, '')}([^A-Za-z0-9_]|$)`, 'i');
    const mentions = log.filter((e) => e.by.toLowerCase() !== lower && nameRe.test(e.text)).slice(0, 40);
    const ran = log.filter((e) => e.by.toLowerCase() === lower).length;
    const discord = link ? await face(link.discordId) : null;
    const date = (sec?: number) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '–');

    // header
    const head = html`<header class="page-head member-head">
      <div class="server-top">${heads.get(id) ? html`<img class="member-img" src="${heads.get(id)}" alt="" width="72" height="72">` : html`<span class="server-ph">${initials(user.name)}</span>`}
        <div><h1>${user.name}</h1><p class="sub">${user.displayName !== user.name ? html`${user.displayName} · ` : ''}${rank?.rank ? html`<b>${rank.roleName}</b> (rank ${rank.rank})` : 'Not in the army group'}
        ${staffTier ? html` · ${badge(`Staff ${staffTier} · ${TIER_NAMES[staffTier as StaffTier] ?? ''}`, 'info')}` : ''}${banned ? html` · ${badge(ban!.untilT === 0 ? 'Banned for good' : 'Banned', 'bad')}` : ''}${d && d.mp.jailLeft > 0 ? html` · ${badge('In jail', 'warn')}` : ''}</p>
        <p class="sub"><a href="${profileUrl(id)}" target="_blank" rel="noreferrer noopener">Roblox profile</a> · ID <code>${id}</code>${discord ? html` · Discord: <b>${discord.name}</b>` : ' · Discord: not linked'}${ran ? html` · <a href="/game-log?who=${encodeURIComponent(user.name)}">${ran} staff commands run</a>` : ''}</p></div>
      </div></header>`;

    // promotion
    const options = assignable(roles).map((x) => ({ value: String(x.id), label: `${x.rank} · ${x.name}` }));
    const pick = proposed ?? to;
    const promoForm = rank?.rank
      ? html`<form method="post" action="/members/${id}" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="rank"><input type="hidden" name="expectRoleId" value="${rank.roleId}">
          ${field('New rank', 'roleId', select('roleId', options, pick ? String(pick.id) : undefined, { none: null }))}
          ${field('Reason (for the audit log)', 'reason', html`<input id="reason" name="reason" maxlength="200" placeholder="Optional">`)}
          <button>${proposed ? `Promote to ${proposed.name}` : 'Change rank'}</button></form>`
      : html`<p class="muted">They need to join the army group before they can be given a rank.</p>`;
    const promo = card(
      'Promotion',
      html`${
        proposed && rank?.rank
          ? html`<div class="flash ok confirm">Promote <b>${user.name}</b> from <b>${rank.roleName}</b> to <b>${proposed.name}</b>? Check their record below, then confirm.</div>`
          : ''
      }
      ${
        st?.next
          ? html`<div class="progress-grid">
              <div><span class="label">Next on the ladder</span><b>${st.next.next}</b> ${st.eligible ? badge('Ready', 'ok') : badge(`${Math.round(progressOf({ points: st.points, trainings: st.next.haveTrainings, next: st.next }) * 100)}%`, 'muted')}</div>
              <div><span class="label">Points</span>${bar(st.points, st.next.points)}</div>
              <div><span class="label">Trainings</span>${bar(st.next.haveTrainings, st.next.trainings)}</div>
            </div>`
          : html`<p class="muted">${rank?.rank ? 'Past the points ladder: officer ranks are by selection.' : ''}${!d ? ' No service record yet.' : ''}</p>`
      }
      ${promoForm}
      ${history.length ? html`<h3 class="sub-h">Rank changes through the bot</h3><ul class="list compact">${history.slice(0, 10).map((e) => html`<li><span class="grow">${e.from} → <b>${e.to}</b>${e.reason ? html` <small class="muted">· ${e.reason}</small>` : ''}</span><span class="muted nowrap">${e.by} · ${date(e.t / 1000)}</span></li>`)}</ul>` : ''}`,
    );

    if (!d) {
      return page(r, { title: user.name, nav: 'members', body: html`${head}${promo}${card('Service record', empty('No service record', 'They have never played Hong Kong 1941, or their record could not be read.'))}` });
    }

    const pts = computePoints(d);
    const s = d.service;
    const medals = Object.entries(d.medals.a).map(([mid, a]) => ({ m: MEDAL_BY_ID.get(mid), mid, a })).sort((x, y) => (x.m ? 0 : 1) - (y.m ? 0 : 1));
    const quals = Object.entries(d.medals.q).map(([cid, q]) => ({ c: CERT_BY_ID.get(cid), cid, q }));
    const arrests = d.mp.arrests.slice(0, 15);

    const stats = html`<div class="stats">
      <div class="stat"><span class="stat-n">${pts.total}</span><span class="stat-l">points</span></div>
      <div class="stat"><span class="stat-n">${d.training.attended}</span><span class="stat-l">trainings</span></div>
      <div class="stat"><span class="stat-n">${hours(s.deployedTime)}</span><span class="stat-l">in the field</span></div>
      <div class="stat"><span class="stat-n">${hours(s.playtime)}</span><span class="stat-l">played</span></div>
      <div class="stat"><span class="stat-n">${Object.keys(d.medals.a).length}</span><span class="stat-l">medals</span></div>
    </div>`;

    const discipline = card(
      'Discipline',
      html`<dl class="meta">
        <dt>Ban</dt><dd>${ban ? html`${banned ? badge(ban.untilT === 0 ? 'Permanent' : `Until ${utc(ban.untilT * 1000)}`, 'bad') : html`<span class="muted">Expired ${utc(ban.untilT * 1000)}</span>`} ${ban.reason ?? ''}${ban.by ? html` <small class="muted">by ${ban.by}</small>` : ''}` : html`<span class="muted">None</span>`}</dd>
        <dt>Jail</dt><dd>${d.mp.jailLeft > 0 ? html`${badge(`${Math.ceil(d.mp.jailLeft / 60)} min left`, 'warn')} ${d.mp.jailCharges} <small class="muted">by ${d.mp.jailBy}</small>` : html`<span class="muted">Not in jail</span>`}</dd>
        <dt>Arrests</dt><dd>${d.mp.arrests.length}</dd>
      </dl>
      ${
        arrests.length
          ? html`<h3 class="sub-h">Arrest record</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Charges</th><th>Time</th><th>By</th></tr></thead><tbody>
            ${arrests.map((a) => html`<tr><td class="nowrap">${date(a.t)}</td><td class="wrap">${(a.charges ?? []).join(', ') || '–'}${a.notes ? html`<br><small class="muted">${a.notes}</small>` : ''}</td><td class="nowrap">${a.minutes ? `${a.minutes} min` : ''}</td><td>${a.by ?? ''}</td></tr>`)}
            </tbody></table></div>`
          : ''
      }
      ${
        mentions.length
          ? html`<h3 class="sub-h">Staff commands naming them</h3><ul class="list compact">${mentions.map(
              (e) => html`<li><span class="grow">${badge(commandOf(e), PUNISH.has(commandOf(e)) ? 'bad' : 'muted')} <span class="cmd">${e.text}</span></span><span class="muted nowrap">${e.by} · ${ago(now() - e.t * 1000)}</span></li>`,
            )}</ul>`
          : html`<p class="muted">No staff commands in the game log name them.</p>`
      }`,
    );

    const medalsCard = card(
      'Medals and qualifications',
      medals.length || quals.length
        ? html`${medals.length ? html`<ul class="list compact">${medals.map((x) => html`<li><span class="grow"><b>${x.m?.name ?? x.mid}</b>${(x.a.n ?? 1) > 1 ? html` <small class="muted">×${x.a.n}</small>` : ''}${x.a.c ? html`<br><small class="muted">${x.a.c}</small>` : ''}</span><span class="muted nowrap">${x.a.by ?? ''} · ${date(x.a.t)}</span></li>`)}</ul>` : ''}
          ${quals.length ? html`<p class="tags">${quals.map((x) => badge(x.c?.stripes ? `${Math.max(1, Math.min(MAX_STRIPES, x.q.n ?? 1))} service stripe${(x.q.n ?? 1) === 1 ? '' : 's'}` : (x.c?.name ?? x.cid), 'accent'))}</p>` : ''}`
        : empty('None yet'),
    );

    const pointsCard = card(
      'Points breakdown',
      html`<table class="kv"><tbody>${pts.parts.filter(([, n]) => n !== 0).map(([label, n]) => html`<tr><td>${label}</td><td class="right">${n}</td></tr>`)}<tr class="total"><td>Total</td><td class="right">${pts.total}</td></tr></tbody></table>`,
    );

    const serviceCard = card(
      'Service',
      html`<dl class="meta">
        <dt>First joined</dt><dd>${date(s.firstJoin)}</dd><dt>Last seen</dt><dd>${s.lastJoin ? ago(now() - s.lastJoin * 1000) : '–'}</dd>
        <dt>Joins</dt><dd>${s.joins}</dd><dt>Deployments</dt><dd>${s.deployments}</dd>
        <dt>Kills</dt><dd>${s.kills} players · ${s.aiKills} AI</dd><dt>Deaths</dt><dd>${s.deaths}</dd>
        <dt>Captures</dt><dd>${s.captures}</dd><dt>Events</dt><dd>${s.events}</dd>
        <dt>Trainings</dt><dd>${d.training.attended} attended · ${d.training.passed} passed · ${d.training.failed} failed · ${d.training.hosted} hosted</dd>
        <dt>Arrests made</dt><dd>${d.mp.made}</dd>
      </dl>`,
    );

    const trainings = d.training.history.slice(0, 10);
    const trainingCard = card(
      'Recent trainings',
      trainings.length
        ? html`<ul class="list compact">${trainings.map((t) => html`<li><span class="grow">${String(t.title ?? 'Training')}${t.result ? html` ${badge(String(t.result), /pass/i.test(String(t.result)) ? 'ok' : /fail/i.test(String(t.result)) ? 'bad' : 'muted')}` : ''}</span><span class="muted nowrap">${t.host ? `${String(t.host)} · ` : ''}${date(t.t)}</span></li>`)}</ul>`
        : empty('No trainings on record'),
    );

    const adjust = s.log.slice(0, 10);
    const adjustCard = adjust.length
      ? card(
          'Points awarded by staff',
          html`<ul class="list compact">${adjust.map((e) => html`<li><span class="grow"><b>${(e.n ?? 0) > 0 ? `+${e.n}` : e.n}</b> ${e.reason ? html`<span class="muted">${e.reason}</span>` : ''}</span><span class="muted nowrap">${e.by ?? ''} · ${date(e.t)}</span></li>`)}</ul>`,
        )
      : '';

    return page(r, {
      title: user.name,
      nav: 'members',
      body: html`${head}${stats}
      <div class="grid-2">
        <div class="stack">${promo}${discipline}${trainingCard}</div>
        <div class="stack">${medalsCard}${pointsCard}${serviceCard}${adjustCard}</div>
      </div>`,
    });
  }

  async function memberAction(r: Req, id: number): Promise<void> {
    if (r.form.action !== 'rank') throw new UserFacingError('Unknown action.');
    const by = r.session.user!;
    const { user, from, to } = await changeRank(services, {
      userId: id,
      roleId: Number(r.form.roleId),
      expectRoleId: r.form.expectRoleId ? Number(r.form.expectRoleId) : undefined,
      actor: { tier: Tier.Owner }, // dashboard admins are the owners
      audit: { actorId: by.id, actorName: `${by.globalName ?? by.username} (dashboard)` },
      reason: r.form.reason,
    });
    flash(r.session, 'ok', `${user?.name ?? id} is now ${to.name} (was ${from.roleName}). In game it shows after they rejoin.`);
  }

  // ---------- panels ----------

  interface PanelValues {
    guildId: string;
    channelId: string;
    title: string;
    body: string;
    buttons: string;
    footer: string;
    colour: ColourName;
    imageUrl: string;
    keepImage: boolean;
  }

  const COLOUR_OPTIONS: Option[] = (Object.keys(COLOUR_CHOICES) as ColourName[]).map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }));
  const panelLink = (p: { guildId: string; channelId: string; messageId: string }) => `https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId}`;
  const onDiscordCdn = (u: string) => /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//i.test(u);

  function readPanelForm(f: Record<string, string>): PanelValues {
    const colour = (f.colour ?? '') as ColourName;
    return {
      guildId: (f.guildId ?? '').trim(),
      channelId: (f.channelId ?? '').trim(),
      title: (f.title ?? '').trim().slice(0, 256),
      body: (f.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000),
      buttons: (f.buttons ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000),
      footer: (f.footer ?? '').trim().slice(0, 200),
      colour: colour in COLOUR_CHOICES ? colour : 'khaki',
      imageUrl: (f.imageUrl ?? '').trim().slice(0, 500),
      keepImage: f.keepImage === '1',
    };
  }

  /** Check the form and turn it into what Discord gets. Throws UserFacingError with what to fix. */
  function panelDraft(v: PanelValues, guild: Guild): PanelDraft {
    if (!v.title) throw new UserFacingError('Give the panel a title.');
    if (!v.body) throw new UserFacingError('The panel needs some text.');
    if (v.imageUrl) {
      let ok = false;
      try {
        ok = new URL(v.imageUrl).protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) throw new UserFacingError('The picture link must be a full link starting with https://');
    }
    return {
      title: expandText(v.title, guild),
      body: expandText(v.body, guild),
      footer: v.footer || undefined,
      buttons: parseButtons(v.buttons),
      colour: COLOUR_CHOICES[v.colour],
      imageUrl: v.imageUrl || undefined,
    };
  }

  /** Roughly what Discord will show. */
  function panelPreview(v: PanelValues, guild: Guild, currentImage?: string): Html {
    if (!v.title && !v.body) return html`<p class="muted">Start typing and press <b>Update preview</b> to see the panel here.</p>`;
    let buttons: { label: string; url: string }[] = [];
    let buttonError = '';
    try {
      buttons = parseButtons(v.buttons);
    } catch (err) {
      buttonError = err instanceof Error ? err.message : String(err);
    }
    const img = v.keepImage && currentImage ? currentImage : v.imageUrl;
    const iconUrl = typeof guild.iconURL === 'function' ? guild.iconURL({ size: 32 }) : null;
    return html`<div class="dc">
      <div class="dc-embed c-${v.colour}">
        ${v.title ? html`<div class="dc-title">${v.title}</div>` : ''}
        <div class="dc-body">${discordMarkdown(expandText(v.body, guild), guild)}</div>
        ${img ? (onDiscordCdn(img) ? html`<img class="dc-img" src="${img}" alt="Panel picture">` : html`<p class="dc-note">Picture: ${img}</p>`) : ''}
        <div class="dc-foot">${iconUrl ? html`<img src="${iconUrl}" alt="" width="20" height="20">` : ''}<span>${v.footer || guild.name}</span></div>
      </div>
      ${buttons.length ? html`<div class="dc-buttons">${buttons.map((b) => html`<a class="dc-btn" href="${safeUrl(b.url)}" target="_blank" rel="noreferrer noopener">${b.label} ${icon('external', 'ic sm')}</a>`)}</div>` : ''}
      ${buttonError ? html`<p class="flash bad">${buttonError}</p>` : ''}
    </div>`;
  }

  function panelEditor(
    r: Req,
    guild: Guild,
    v: PanelValues,
    opts: { mode: 'new' | 'edit'; messageId?: string; currentImage?: string; error?: string },
  ): Promise<string> {
    const editing = opts.mode === 'edit';
    const chName = guild.channels.cache.get(v.channelId)?.name;
    const action = editing ? `/panels/${opts.messageId}` : '/panels/new';
    const form = html`<form method="post" action="${action}" class="panel-form">
      ${csrfField(r.session)}<input type="hidden" name="guildId" value="${guild.id}">
      ${
        editing
          ? html`<input type="hidden" name="channelId" value="${v.channelId}"><p class="muted">In <b>${chName ? `#${chName}` : 'an unknown channel'}</b> on ${guild.name}. <a href="${panelLink({ guildId: guild.id, channelId: v.channelId, messageId: opts.messageId! })}" target="_blank" rel="noreferrer noopener">Open in Discord</a></p>`
          : field('Channel', 'channelId', select('channelId', channelOptions(guild), v.channelId, { none: '— pick a channel —' }), 'The bot needs View Channel, Send Messages, Embed Links and Attach Files there.')
      }
      ${field('Title', 'title', html`<input id="title" name="title" maxlength="256" required value="${v.title}" placeholder="Server Rules">`)}
      ${field(
        'Text',
        'body',
        html`<textarea id="body" name="body" rows="16" maxlength="4000" required placeholder="1. Be respectful.&#10;2. No exploiting.">${v.body}</textarea>`,
        'Discord formatting works: **bold**, *italic*, # Heading, - lists, [link text](https://…). Type #channel-name for a channel and :emoji_name: for one of the server’s emoji.',
      )}
      ${field('Link buttons', 'buttons', html`<textarea id="buttons" name="buttons" rows="3" maxlength="1000" placeholder="Full rulebook | https://docs.google.com/…">${v.buttons}</textarea>`, 'One per line, as Label | https://link. Up to 5.')}
      <div class="fields">
        ${field('Footer', 'footer', html`<input id="footer" name="footer" maxlength="200" value="${v.footer}" placeholder="${guild.name}">`, 'Leave empty to show the server name.')}
        ${field('Colour', 'colour', select('colour', COLOUR_OPTIONS, v.colour, { none: null }))}
      </div>
      ${field('Picture link', 'imageUrl', html`<input id="imageUrl" name="imageUrl" type="url" maxlength="500" value="${v.imageUrl}" placeholder="https://…">`, 'Optional. A direct link to a PNG, JPG or GIF, shown under the text.')}
      ${opts.currentImage ? html`<label class="check"><input type="checkbox" name="keepImage" value="1"${v.keepImage ? new Html(' checked') : ''}> Keep the current picture (a new link replaces it)</label>` : ''}
      <div class="btn-row">
        <button name="action" value="save">${editing ? 'Save changes' : 'Post panel'}</button>
        <button class="secondary" name="action" value="preview">Update preview</button>
        <a class="btn ghost" href="/panels">Cancel</a>
      </div>
    </form>`;
    const danger = editing
      ? card(
          'Delete',
          html`<form method="post" action="${action}" class="row">${csrfField(r.session)}
            <label class="check"><input type="checkbox" name="confirm" value="1" required> Delete this panel’s message from Discord</label>
            <button class="danger" name="action" value="delete">Delete panel</button></form>`,
        )
      : '';
    return page(r, {
      title: editing ? `Edit: ${v.title || 'panel'}` : 'New panel',
      nav: 'panels',
      body: html`${pageHead(editing ? 'Edit panel' : 'New panel', html`<a href="/panels">Panels</a> / ${guild.name}`)}
      ${opts.error ? html`<div class="flash bad" role="alert">${opts.error}</div>` : ''}
      <div class="grid-2 panel-grid">
        <div class="stack">${card(null, form)}${danger}</div>
        ${card('Preview', panelPreview(v, guild, opts.currentImage), { action: html`<span class="muted">Roughly how Discord shows it</span>` })}
      </div>`,
    });
  }

  async function panelsPage(r: Req): Promise<string> {
    const c = deps.client();
    const list = await services.panels.list();
    const rows = list.map((p) => {
      const g = c?.guilds.cache.get(p.guildId);
      const chName = g?.channels.cache.get(p.channelId)?.name;
      return html`<tr>
        <td><a class="strong" href="/panels/${p.messageId}">${p.title || '(no title)'}</a></td>
        <td>${g?.name ?? p.guildId}</td>
        <td>${chName ? `#${chName}` : html`<span class="muted">unknown</span>`}</td>
        <td class="nowrap">${ago(now() - p.updatedAt)}<br><small class="muted">${p.updatedBy}</small></td>
        <td class="nowrap right"><a class="btn sm secondary" href="/panels/${p.messageId}">Edit</a> <a class="btn sm ghost" href="${panelLink(p)}" target="_blank" rel="noreferrer noopener">Discord ${icon('external', 'ic sm')}</a></td>
      </tr>`;
    });
    return page(r, {
      title: 'Panels',
      nav: 'panels',
      body: html`${pageHead('Panels', 'Rules, guidebooks and other info posts. Editing one here changes the message in Discord, so links to it keep working.', html`<a class="btn" href="/panels/new">New panel</a>`)}
      ${card(
        null,
        list.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Title</th><th>Server</th><th>Channel</th><th>Last changed</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : empty('No panels yet', html`Post one with <b>New panel</b>, or add one that’s already in Discord below.`),
        { flush: list.length > 0 },
      )}
      ${card(
        'Add a panel that’s already in Discord',
        html`<form method="post" action="/panels" class="row">${csrfField(r.session)}<input type="hidden" name="action" value="adopt">
          ${field('Message link', 'link', html`<input id="link" name="link" required placeholder="https://discord.com/channels/…">`)}
          <button class="secondary">Add to the list</button></form>
          <p class="hint">In Discord, right-click the panel and pick Copy Message Link. Panels posted with /panel from now on are added by themselves.</p>`,
      )}`,
    });
  }

  async function newPanelPage(r: Req, v?: PanelValues, error?: string): Promise<string> {
    const guilds = [...client().guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    const want = v?.guildId || r.url.searchParams.get('guild') || (guilds.length === 1 ? guilds[0]!.id : '');
    const guild = want ? client().guilds.cache.get(want) : undefined;
    if (!guild) {
      return page(r, {
        title: 'New panel',
        nav: 'panels',
        body: html`${pageHead('New panel', html`<a href="/panels">Panels</a>`)}
        ${card(
          'Which server?',
          guilds.length
            ? html`<form method="get" action="/panels/new" class="row">${field('Server', 'guild', select('guild', guilds.map((g) => ({ value: g.id, label: g.name })), undefined, { none: null }))}<button>Next</button></form>`
            : empty('Not in any server yet', 'Invite the bot first.'),
        )}`,
      });
    }
    const values: PanelValues = v ?? { guildId: guild.id, channelId: '', title: '', body: '', buttons: '', footer: '', colour: 'khaki', imageUrl: '', keepImage: false };
    return panelEditor(r, guild, values, { mode: 'new', error });
  }

  async function editPanelPage(r: Req, messageId: string, v?: PanelValues, error?: string): Promise<string> {
    const rec = await services.panels.get(messageId);
    if (!rec) throw new NotFound();
    const guild = guildOr404(rec.guildId);
    const msg = await fetchPanelMessage(client(), rec.guildId, rec.channelId, messageId);
    if (!msg) {
      return page(r, {
        title: rec.title,
        nav: 'panels',
        body: html`${pageHead(rec.title || 'Panel', html`<a href="/panels">Panels</a> / ${guild.name}`)}
        ${card(
          null,
          html`${empty('This panel’s message is gone', 'It was deleted in Discord, or the bot can no longer see its channel.')}
          <form method="post" action="/panels/${messageId}" class="btn-row center">${csrfField(r.session)}<button class="secondary" name="action" value="forget">Remove it from the list</button></form>`,
        )}`,
      });
    }
    const current = readPanel(msg);
    const values: PanelValues = v ?? {
      guildId: guild.id,
      channelId: rec.channelId,
      title: current.values.title,
      body: collapseText(current.values.body, guild),
      buttons: current.values.buttons,
      footer: current.values.footer === guild.name ? '' : current.values.footer,
      colour: colourNameOf(current.colour),
      imageUrl: current.imageUrl ?? '',
      keepImage: !!current.image,
    };
    return panelEditor(r, guild, values, { mode: 'edit', messageId, currentImage: current.image ? String(current.image.attachment) : undefined, error });
  }

  /** Panel forms: a preview or a mistake shows the form again with the text kept; saving redirects. */
  async function panelsPost(r: Req): Promise<string | Redirect> {
    const path = r.url.pathname;
    const f = r.form;
    const by = { id: r.session.user!.id, name: r.session.user!.globalName ?? r.session.user!.username };

    if (path === '/panels') {
      if (f.action !== 'adopt') throw new UserFacingError('Unknown action.');
      try {
        const m = /channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})/.exec(f.link ?? '');
        if (!m) throw new UserFacingError('Paste the whole message link (right-click the panel → Copy Message Link).');
        const [, guildId, channelId, messageId] = m as unknown as [string, string, string, string];
        guildOr404(guildId);
        const msg = await fetchPanelMessage(client(), guildId, channelId, messageId);
        if (!msg) throw new UserFacingError("Can't find that message. The bot needs View Channel and Read Message History there.");
        if (msg.author.id !== client().user?.id) throw new UserFacingError('That message wasn’t posted by the bot, so it can’t be edited.');
        const content = readPanel(msg);
        await services.panels.put({
          messageId,
          guildId,
          channelId,
          title: content.values.title,
          createdBy: '',
          createdAt: msg.createdTimestamp,
          updatedAt: msg.editedTimestamp ?? msg.createdTimestamp,
          updatedBy: 'Discord',
        });
        flash(r.session, 'ok', `Added "${content.values.title}".`);
        return new Redirect(`/panels/${messageId}`);
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        flash(r.session, 'bad', err.message);
        return new Redirect('/panels');
      }
    }

    const v = readPanelForm(f);
    if (path === '/panels/new') {
      const guild = guildOr404(v.guildId);
      if (f.action === 'preview') return newPanelPage(r, v);
      try {
        if (!channelOptions(guild).some((o) => o.value === v.channelId)) throw new UserFacingError('Pick the channel to post in.');
        const { url, messageId } = await savePanel(services, client(), { guild, channelId: v.channelId, draft: panelDraft(v, guild), by });
        await audit(r, 'Info panel posted', `"${v.title}" in <#${v.channelId}>: ${url}`, guild.id);
        flash(r.session, 'ok', `Posted in #${guild.channels.cache.get(v.channelId)?.name ?? 'the channel'}.`);
        return new Redirect(`/panels/${messageId}`);
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        return newPanelPage(r, v, err.message.replace(/<#(\d+)>/g, (_m, id: string) => `#${guild.channels.cache.get(id)?.name ?? id}`));
      }
    }

    const m = /^\/panels\/(\d{15,25})$/.exec(path);
    const rec = m ? await services.panels.get(m[1]!) : null;
    if (!m || !rec) throw new NotFound();
    const messageId = m[1]!;
    if (f.action === 'forget') {
      await services.panels.remove(messageId);
      flash(r.session, 'ok', 'Removed from the list. Nothing was changed in Discord.');
      return new Redirect('/panels');
    }
    if (f.action === 'delete') {
      if (f.confirm !== '1') throw new UserFacingError('Tick the box to confirm.');
      const msg = await fetchPanelMessage(client(), rec.guildId, rec.channelId, messageId);
      if (msg) await msg.delete();
      await services.panels.remove(messageId);
      await audit(r, 'Info panel deleted', `"${rec.title}" in <#${rec.channelId}>`, rec.guildId);
      flash(r.session, 'ok', `Deleted "${rec.title}".`);
      return new Redirect('/panels');
    }
    const guild = guildOr404(rec.guildId);
    v.guildId = rec.guildId;
    v.channelId = rec.channelId;
    if (f.action === 'preview') return editPanelPage(r, messageId, v);
    try {
      const draft = panelDraft(v, guild);
      let image: ImageFile | undefined;
      if (v.keepImage && !v.imageUrl) {
        const msg = await fetchPanelMessage(client(), rec.guildId, rec.channelId, messageId);
        image = msg ? readPanel(msg).image : undefined;
      }
      await savePanel(services, client(), { guild, channelId: rec.channelId, messageId, draft, image, by });
      await audit(r, 'Info panel edited', `"${v.title}" in <#${rec.channelId}>: ${panelLink(rec)}`, guild.id);
      flash(r.session, 'ok', 'Saved. The panel in Discord is updated.');
      return new Redirect(`/panels/${messageId}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      return editPanelPage(r, messageId, v, err.message);
    }
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

    if (r.method === 'POST' && path === '/theme') {
      s.theme = r.form.theme === 'light' ? 'light' : undefined;
      const back = r.form.back ?? '/';
      return new Redirect(back.startsWith('/') && !back.startsWith('//') && RETURNABLE.test(back.split('?')[0]!) ? back : '/');
    }
    if (r.method === 'POST' && (path === '/panels' || path.startsWith('/panels/'))) return panelsPost(r);
    if (r.method === 'POST') {
      const m = /^\/servers\/(\d{15,25})$/.exec(path);
      let back = path;
      try {
        if (m) {
          await serverAction(r, guildOr404(m[1]!));
          if (isTab(r.form.tab)) back = `${path}?tab=${r.form.tab}`;
        } else if (path === '/approvals') await approvalsAction(r);
        else if (path === '/promotions') return await promotionsAction(r);
        else if (/^\/members\/\d{1,19}$/.test(path)) await memberAction(r, Number(path.split('/')[2]));
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
    if (path === '/promotions') return promotionsPage(r);
    if (path === '/members') return membersPage(r);
    const mm = /^\/members\/(\d{1,19})$/.exec(path);
    if (mm) return memberPage(r, Number(mm[1]));
    if (path === '/panels') return panelsPage(r);
    if (path === '/panels/new') return newPanelPage(r);
    const pm = /^\/panels\/(\d{15,25})$/.exec(path);
    if (pm) return editPanelPage(r, pm[1]!);
    throw new NotFound();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {
      'content-security-policy':
        "default-src 'none'; style-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net https://*.rbxcdn.com; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
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
    if (url.pathname === '/static/logo.png' || (url.pathname === '/favicon.ico' && LOGO)) {
      if (!LOGO) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(LOGO);
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
