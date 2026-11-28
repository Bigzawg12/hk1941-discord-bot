import type { Session } from './session.js';
import { discordAvatar } from './oauth.js';
import { createHash } from 'node:crypto';

/** Escape text for HTML. Every value from Discord, Roblox or a form goes through this. */
export function h(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Already-safe HTML (built from h()). */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Tagged template: interpolated values are escaped unless they are Html (or arrays of Html). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return h(v);
}

export const csrfField = (s: Session) => html`<input type="hidden" name="_csrf" value="${s.csrf}">`;

export interface Option {
  value: string;
  label: string;
}

export function select(name: string, options: Option[], selected: string | undefined, { none = '— off —', id = name }: { none?: string | null; id?: string } = {}): Html {
  return html`<select name="${name}" id="${id}">
    ${none !== null ? html`<option value="">${none}</option>` : ''}
    ${options.map((o) => html`<option value="${o.value}"${o.value === selected ? new Html(' selected') : ''}>${o.label}</option>`)}
  </select>`;
}

// ---------- icons (inline SVG, stroke = currentColor) ----------

const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  game: '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 11v3M5.5 12.5h3M15 12h.01M18 13.5h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  out: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h11"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L21 15"/><path d="M21 20v-5h-5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4 20h16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

export function icon(name: keyof typeof ICONS | string, cls = 'ic'): Html {
  return new Html(`<svg class="${h(cls)}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`);
}

// ---------- small building blocks ----------

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';

export const badge = (text: string, tone: Tone = 'muted') => html`<span class="badge ${tone}">${text}</span>`;

/** A quiet "nothing here" message. (The third argument is kept for older callers; no icon is shown.) */
export function empty(title: string, hint?: string | Html, _ic?: string): Html {
  return html`<div class="empty"><p class="empty-title">${title}</p>${hint ? html`<p class="muted">${hint}</p>` : ''}</div>`;
}

export function card(title: string | null, body: Html, opts: { action?: Html; id?: string; flush?: boolean } = {}): Html {
  return html`<section class="card${opts.flush ? ' flush' : ''}"${opts.id ? new Html(` id="${h(opts.id)}"`) : ''}>
    ${title ? html`<div class="card-head"><h2>${title}</h2>${opts.action ?? ''}</div>` : ''}
    ${body}
  </section>`;
}

export function field(label: string, id: string, control: Html, hint?: string): Html {
  return html`<div class="field"><label for="${id}">${label}</label>${control}${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
}

/** "3 min ago" style text for a past time (ms). */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function utc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export interface NavCounts {
  approvals?: number;
}

export function layout(opts: { title: string; session: Session; body: Html; nav?: string; counts?: NavCounts; bare?: boolean; path?: string; refreshSec?: number; level?: number; hide?: string[] }): string {
  const { session: s } = opts;
  const flash = s.flash;
  s.flash = undefined;
  const light = s.theme === 'light';
  const lvl = opts.level ?? 4;
  const item = (href: string, label: string, key: string, count?: number, min = 1) =>
    lvl < min || opts.hide?.includes(key)
      ? ''
      : html`<a href="${href}" class="nav-item"${opts.nav === key ? new Html(' aria-current="page"') : ''}><span>${label}</span>${count ? html`<span class="count">${count}</span>` : ''}</a>`;
  const signedIn = !!s.user && !opts.bare;
  return html`<!doctype html>
<html lang="en" data-theme="${light ? 'light' : 'dark'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${opts.refreshSec ? html`
<meta http-equiv="refresh" content="${opts.refreshSec}">` : ''}
<meta name="color-scheme" content="${light ? 'light' : 'dark'}">
<title>${opts.title} · Hong Kong 1941 staff</title>
<link rel="icon" href="/static/logo.png" type="image/png">
<link rel="stylesheet" href="/static/style.css?v=${STYLE_VERSION}">
</head>
<body class="${signedIn ? 'app' : 'bare'}">
${
  signedIn
    ? html`<aside class="side">
  <a class="brand" href="/"><img src="/static/logo.png" alt="" width="30" height="30"><span><b>Hong Kong 1941</b><small>Staff dashboard</small></span></a>
  <nav class="nav" aria-label="Main">
    ${item('/', 'Overview', 'home')}
    <div class="nav-section">Unit</div>
    ${item('/promotions', 'Promotions', 'promotions')}
    ${item('/members', 'Members', 'members')}
    ${item('/groups', 'Groups', 'groups')}
    ${item('/events', 'Events', 'events')}
    ${lvl >= 3 ? html`<div class="nav-section">Discord</div>` : ''}
    ${item('/approvals', 'Approvals', 'approvals', opts.counts?.approvals, 3)}
    ${item('/panels', 'Panels', 'panels', undefined, 3)}
    ${item('/servers', 'Servers', 'servers', undefined, 3)}
    ${item('/links', 'Linked accounts', 'links', undefined, 3)}
    <div class="nav-section">Records</div>
    ${item('/game-log', 'Game log', 'gamelog')}
    ${item('/audit', 'Audit log', 'audit', undefined, 3)}
    ${lvl >= 4 ? html`<div class="nav-section">Settings</div>` : ''}
    ${item('/access', 'Access', 'access', undefined, 4)}
  </nav>
  <div class="side-foot">
    <form method="post" action="/theme">${csrfField(s)}<input type="hidden" name="back" value="${opts.path ?? '/'}"><button class="link-btn" name="theme" value="${light ? 'dark' : 'light'}">${light ? 'Dark mode' : 'Light mode'}</button></form>
    <form method="post" action="/logout" class="me">${csrfField(s)}<img src="${discordAvatar(s.user!)}" alt="" width="28" height="28"><span class="me-name">${s.user!.globalName ?? s.user!.username}<small>${['No access', 'Viewer', 'Officer', 'Admin', 'Owner'][lvl] ?? ''}</small></span><button class="link-btn">Sign out</button></form>
  </div>
</aside>`
    : ''
}
<main class="main">
${flash ? html`<div class="flash ${flash.kind}" role="status">${flash.text}</div>` : ''}
${opts.body}
</main>
</body>
</html>`.value;
}

export function pageHead(title: string, sub?: string | Html, actions?: Html): Html {
  return html`<header class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</header>`;
}

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2.5 3.5 6v6.2c0 5 3.6 8.6 8.5 9.8 4.9-1.2 8.5-4.8 8.5-9.8V6z" fill="#8a7d4a"/><path d="M8 12.2l2.8 2.8L16.5 9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const STYLE = `
:root{
  --bg:#0e0f11;--panel:#141518;--panel-2:#1b1d21;--ink:#ececee;--ink-2:#b4b7bd;--muted:#868b94;--line:#23252a;--line-2:#30333a;
  --accent:#c8102e;--link:#8fb4ff;--focus:#5b8def;
  --primary:#ececee;--primary-ink:#0e0f11;--primary-hover:#ffffff;
  --ok:#3fb950;--warn:#d29922;--bad:#f2555a;--info:#6ea8fe;--gold:#d29922;
  --ok-bg:rgba(63,185,80,.08);--bad-bg:rgba(242,85,90,.08);
  --field:#101113;
  --side-bg:#0b0c0e;--side-ink:#ececee;--side-muted:#80858e;--side-line:#1d1f23;--side-hover:rgba(255,255,255,.04);--side-current:rgba(255,255,255,.07);
  --sans:"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",sans-serif;
  --serif:var(--sans);
  --mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;
  --r:8px;--r-sm:6px;
  color-scheme:dark
}
:root[data-theme=light]{
  --bg:#fafafa;--panel:#ffffff;--panel-2:#f4f4f5;--ink:#18181b;--ink-2:#3f3f46;--muted:#71717a;--line:#e4e4e7;--line-2:#d4d4d8;
  --accent:#b30e29;--link:#1d4ed8;--focus:#2563eb;
  --primary:#18181b;--primary-ink:#ffffff;--primary-hover:#27272a;
  --ok:#15803d;--warn:#b45309;--bad:#dc2626;--info:#1d4ed8;--gold:#b45309;
  --ok-bg:#f0fdf4;--bad-bg:#fef2f2;
  --field:#ffffff;
  --side-bg:#f4f4f5;--side-ink:#18181b;--side-muted:#71717a;--side-line:#e4e4e7;--side-hover:rgba(0,0,0,.04);--side-current:#ffffff;
  color-scheme:light
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
a.strong{font-weight:600;color:var(--ink)}
.ic{width:16px;height:16px;flex:none}.ic.sm{width:13px;height:13px}
button .ic,.btn .ic,.card-head a .ic{display:none}
h1,h2,h3{margin:0}
h1{font-size:1.4rem;font-weight:600;line-height:1.25;letter-spacing:-.015em}
h2{font-size:.95rem;font-weight:600;color:var(--ink);letter-spacing:-.005em}
h3{font-size:.95rem;font-weight:600}
.muted{color:var(--muted)}
.right{text-align:right}
.center{justify-content:center}
code,.mono{font-family:var(--mono);font-size:.86em}
code{background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:0 5px}

/* shell */
body.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:8px;padding:16px 0 12px;background:var(--side-bg);color:var(--side-ink);border-right:1px solid var(--side-line);overflow-y:auto}
.brand{display:flex;gap:10px;align-items:center;text-decoration:none;color:var(--side-ink);padding:2px 18px 10px}
.brand:hover{text-decoration:none}
.brand img{border-radius:6px;flex:none;width:30px;height:30px}
.brand b{display:block;font-size:.9rem;font-weight:600;line-height:1.2;letter-spacing:-.005em}
.brand small{display:block;color:var(--side-muted);font-size:.78rem;margin-top:1px}
.nav{display:flex;flex-direction:column;flex:1;padding:0 8px}
.nav-section{font-size:.75rem;font-weight:500;color:var(--side-muted);padding:14px 10px 4px}
.nav-item{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:var(--r-sm);color:var(--side-muted);text-decoration:none;font-weight:500;font-size:.9rem}
.nav-item:hover{color:var(--side-ink);background:var(--side-hover);text-decoration:none}
.nav-item[aria-current]{color:var(--side-ink);background:var(--side-current);box-shadow:inset 2px 0 0 var(--accent)}
:root[data-theme=light] .nav-item[aria-current]{box-shadow:inset 2px 0 0 var(--accent),0 0 0 1px var(--line)}
.count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;background:var(--side-current);border:1px solid var(--side-line);color:var(--side-ink);font-size:.72rem;font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.side-foot{display:flex;flex-direction:column;gap:10px;padding:12px 18px 0;border-top:1px solid var(--side-line)}
.me{display:flex;align-items:center;gap:9px;margin:0}
.me img{border-radius:50%}
.me-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.me-name small{display:block;font-weight:400;color:var(--side-muted);font-size:.72rem}
.link-btn,.side .link-btn{background:none;border:0;padding:0;min-height:0;color:var(--side-muted);font-weight:500;font-size:.85rem}
.link-btn:hover{color:var(--side-ink);background:none;text-decoration:underline}
.main{padding:28px 40px 72px;max-width:1240px;width:100%}
body.bare .main{max-width:none;padding:0}
@media (max-width:860px){
  body.app{display:block}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 0 0}
  .brand{padding:0 14px}
  .brand small{display:none}
  .nav{flex-direction:row;overflow-x:auto;order:3;width:100%;flex:none;border-top:1px solid var(--side-line)}
  .nav{padding:4px 8px}
  .nav-section{display:none}
  .nav-item{white-space:nowrap}
  .side-foot{flex-direction:row;margin-left:auto;border:0;padding:0 14px}
  .me-name{display:none}
  .main{padding:20px 16px 56px}
}

/* page */
.page-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;justify-content:space-between;margin-bottom:22px}
.sub{color:var(--muted);margin:4px 0 0;max-width:72ch}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.flash{padding:10px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);margin:0 0 18px}
.flash.ok{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 35%,transparent)}.flash.bad{background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 40%,transparent);color:var(--ink)}

/* cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 20px;margin-bottom:16px}
.card.flush{padding:0;overflow:hidden}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.card.flush>.card-head{margin:0;padding:13px 20px;border-bottom:1px solid var(--line)}
.card-head a,.card-head .muted{font-size:.82rem;text-decoration:none}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid-2{display:grid;gap:18px;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}
@media (max-width:1100px){.grid-2{grid-template-columns:minmax(0,1fr)}}
.grid>.card,.grid-2>.card,.grid-2>.stack>.card:last-child{margin-bottom:0}
.stack{display:flex;flex-direction:column;gap:18px}
.stack>.card{margin-bottom:0}

/* figures */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));background:var(--panel);border:1px solid var(--line);border-radius:var(--r);margin-bottom:16px;overflow:hidden}
.stat{display:flex;flex-direction:column-reverse;padding:14px 18px;border-right:1px solid var(--line);text-decoration:none;color:inherit}
a.stat:hover{text-decoration:none}
.stat:last-child{border-right:0}
a.stat:hover{background:var(--panel-2)}
.stat-n{display:block;font-size:1.6rem;font-weight:600;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}
.stat-l{display:block;color:var(--muted);font-size:.82rem}
.stat-l::first-letter{text-transform:uppercase}
.stat.warn .stat-n{color:var(--warn)}

/* tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:500;color:var(--muted);font-size:.8rem;white-space:nowrap;padding-top:8px;padding-bottom:8px}
.card.flush th{background:var(--panel-2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--panel-2)}
tbody tr:last-child td{border-bottom:0}
td.nowrap,th.nowrap{white-space:nowrap}
td.wrap{word-break:break-word;min-width:220px}
.card:not(.flush) table th:first-child,.card:not(.flush) table td:first-child{padding-left:0}
.who{display:flex;align-items:center;gap:9px;min-width:0}
.who img{border-radius:50%;flex:none}
.who .stack-sm{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.who small{color:var(--muted);font-size:.76rem}
.avatar-ph{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--panel-2);border:1px solid var(--line);color:var(--muted);font-weight:600;font-size:.7rem;flex:none}
.cmd{font-family:var(--mono);font-size:.84rem;color:var(--ink-2);word-break:break-word}

/* labels */
.badge{display:inline-flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--line-2);border-radius:999px;font-size:.76rem;font-weight:500;line-height:20px;white-space:nowrap;color:var(--ink-2);vertical-align:1px;background:transparent}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--muted);flex:none}
.badge.ok::before{background:var(--ok)}.badge.warn::before{background:var(--warn)}.badge.bad::before{background:var(--bad)}.badge.info::before{background:var(--info)}.badge.accent::before{background:var(--accent)}
.badge.cmd-badge{font-family:var(--mono)}

/* forms */
form{margin:0}
.field{display:flex;flex-direction:column;gap:5px;min-width:0;margin-bottom:14px}
.fields .field,.row .field,.toolbar .field{margin-bottom:0}
label{font-size:.84rem;font-weight:500;color:var(--ink-2)}
.hint{margin:0;color:var(--muted);font-size:.8rem}
.fields{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:16px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.row .field{flex:1 1 180px}
.row .field.narrow{flex:0 1 120px}
input,select,textarea{font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:6px 10px;width:100%;min-height:34px}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.8}
textarea{line-height:1.5;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--focus);outline-offset:-1px;border-color:transparent}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
input[type=checkbox]{width:16px;height:16px;min-height:0;accent-color:var(--primary);margin:0}
.check{display:flex;gap:9px;align-items:center;font-weight:500;font-size:.88rem;color:var(--ink);margin-bottom:14px}
.row .check{margin:0 0 9px}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:.88rem;font-weight:500;background:var(--primary);color:var(--primary-ink);border:1px solid var(--primary);border-radius:var(--r-sm);padding:5px 14px;min-height:32px;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{text-decoration:none}
.btn:hover,button:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.btn.secondary,button.secondary{background:var(--panel);color:var(--ink);border-color:var(--line-2)}
.btn.secondary:hover,button.secondary:hover{background:var(--panel-2);border-color:var(--muted)}
.btn.ghost,button.ghost{background:transparent;color:var(--muted);border-color:transparent}
.btn.ghost:hover,button.ghost:hover{color:var(--ink);background:var(--panel-2)}
.btn.danger,button.danger{background:var(--panel);color:var(--bad);border-color:var(--line-2)}
.btn.danger:hover,button.danger:hover{background:var(--bad);border-color:var(--bad);color:#fff}
.btn.ok,button.ok{background:#238636;border-color:#238636;color:#fff}
.btn.ok:hover,button.ok:hover{background:#2ea043;border-color:#2ea043}
.btn.sm,button.sm{padding:2px 10px;min-height:28px;font-size:.82rem}
.icon-btn{background:none;border:0;color:var(--muted);padding:5px;min-height:0;border-radius:var(--r-sm)}
.icon-btn .ic{display:block}
.icon-btn:hover{background:var(--panel-2);color:var(--ink)}
.inline{display:inline-flex;gap:6px;flex-wrap:wrap}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.toolbar .field{flex:1 1 160px}
.toolbar .field.grow{flex:3 1 240px}
.input-ic{position:relative}.input-ic .ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted)}.input-ic input{padding-left:32px}

/* tabs */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px;overflow-x:auto}
.tabs a{padding:8px 12px;color:var(--muted);text-decoration:none;font-weight:500;font-size:.9rem;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{text-decoration:none}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--ink)}

/* approvals */
.approval{display:grid;grid-template-columns:minmax(0,1fr) 300px;padding:0;overflow:hidden}
@media (max-width:900px){.approval{grid-template-columns:minmax(0,1fr)}}
.approval-main{padding:16px 20px;border-left:3px solid var(--muted);min-width:0}
.approval-side{padding:18px 20px;background:var(--panel-2);border-left:1px solid var(--line);display:flex;flex-direction:column;gap:12px}
.approval-side .field{margin-bottom:10px}
.kind-announcement{border-left-color:#6b6f73}.kind-recruitment{border-left-color:#3b7d3b}.kind-shout{border-left-color:#3a5f8a}.kind-notice{border-left-color:#8a7a4a}.kind-orders{border-left-color:#a33b3b}.kind-training{border-left-color:#5b6e3a}.kind-event{border-left-color:#c08a2a}.kind-ssu{border-left-color:#c23b3b}
.approval-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.approval h3{font-size:1.05rem;margin:0 0 2px}
.preview{white-space:pre-wrap;word-break:break-word;background:var(--field);border:1px solid var(--line);border-radius:var(--r-sm);padding:12px 14px;margin:12px 0 0;max-height:320px;overflow:auto}
.preview-img{display:block;max-width:100%;max-height:240px;border-radius:3px;margin-top:12px;border:1px solid var(--line)}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:.85rem;margin:0}
.meta dt{color:var(--muted)}.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.links-out{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}

/* lists */
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0}
.list .title{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list .grow>small,.list .grow>.cmd{display:block}
.list .nowrap{text-align:right;font-size:.84rem}
.checklist{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:.9rem}
.checklist li{display:flex;gap:10px;align-items:center}
.dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);flex:none}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.server-card{display:flex;flex-direction:column;gap:14px}
.server-top{display:flex;gap:12px;align-items:center}
.server-top h2{font-size:1rem;font-weight:600}
.server-top img,.server-ph{width:40px;height:40px;border-radius:var(--r-sm);flex:none}
.server-ph{display:grid;place-items:center;background:var(--panel-2);border:1px solid var(--line);color:var(--muted);font-weight:600;font-size:.8rem}

/* empty + pager */
.empty{text-align:center;padding:36px 16px;color:var(--muted)}
.empty p{margin:0}
.empty-title{color:var(--ink);font-weight:600;margin-bottom:2px!important}
.pager{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid var(--line);font-size:.86rem}

/* panels */
/* promotions and members */
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.chips a{padding:3px 10px;border:1px solid var(--line);border-radius:var(--r-sm);color:var(--muted);text-decoration:none;font-size:.84rem;font-weight:500;background:transparent}
.chips a:hover{text-decoration:none}
.chips a:hover{border-color:var(--muted);color:var(--ink)}
.chips a[aria-current]{background:var(--panel);border-color:var(--line-2);color:var(--ink);box-shadow:0 1px 0 rgba(0,0,0,.15)}
.card-head.pad{padding:14px 20px 12px;margin:0;border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:8px;min-width:150px}
.bar small{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
progress{appearance:none;-webkit-appearance:none;width:110px;height:5px;border:0;border-radius:999px;background:var(--line);overflow:hidden;flex:none}
progress::-webkit-progress-bar{background:var(--line);border-radius:999px}
progress::-webkit-progress-value{background:var(--ink-2);border-radius:999px}
progress::-moz-progress-bar{background:var(--ink-2);border-radius:999px}
.search-inline{display:flex;gap:6px}
.search-inline input{width:200px}
.member-img{border-radius:var(--r);border:1px solid var(--line);background:var(--panel-2)}
.member-head .sub{margin-top:4px}
.progress-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:16px}
.label{display:block;font-size:.8rem;font-weight:500;color:var(--muted);margin-bottom:4px}
.sub-h{font-size:.86rem;font-weight:600;color:var(--ink);margin:18px 0 6px}
.list.compact li{padding:7px 0;font-size:.9rem}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0}
table.kv td{padding:6px 0;border-bottom:1px solid var(--line)}
table.kv tr.total td{font-weight:700;border-bottom:0;padding-top:9px}
.flash.confirm{margin-bottom:14px}
.inline-rank{display:flex;gap:6px;align-items:center}
.inline-rank input{min-height:30px;padding:3px 8px;font-size:.85rem;width:150px}
th.pick,td.pick{width:34px;padding-right:0}
input.num{width:110px;min-height:32px;padding:4px 8px}
.bulk-reason{width:220px;min-height:30px;padding:3px 8px}
.tabs .count{margin-left:6px}
.inline-rank select{min-height:30px;padding:3px 8px;width:auto;max-width:220px;font-size:.85rem}
.chips a small{opacity:.7;margin-left:2px}
/* events */
.events-grid{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}
@media (max-width:1100px){.events-grid{grid-template-columns:minmax(0,1fr)}}
.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line)}
.cal-head{font-size:.78rem;font-weight:500;color:var(--muted);padding:6px 8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--panel-2)}
.cal-cell{min-height:92px;padding:6px 6px 8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:3px;min-width:0}
.cal-cell.empty{background:var(--panel-2)}
.cal-cell.past .cal-day{color:var(--muted)}
.cal-day{font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums}
.cal-cell.today .cal-day{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff}
.cal-event{display:block;font-size:.74rem;line-height:1.3;padding:2px 5px;border-radius:4px;background:var(--panel-2);border:1px solid var(--line);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-event:hover{border-color:var(--line-2);text-decoration:none}
.cal-event span{color:var(--muted);font-variant-numeric:tabular-nums}
.cal-more{font-size:.72rem;color:var(--muted)}
.event-when{display:flex;flex-direction:column;min-width:112px}
.event-when b{font-variant-numeric:tabular-nums}
.event-when small{color:var(--muted);font-size:.76rem}
.event-list li:target{background:var(--panel-2)}
/* groups */
.autobind{margin:14px 0;border:1px solid var(--line);border-radius:var(--r-sm)}
.autobind-go{margin-top:4px}
select.role-pick{min-height:30px;padding:3px 8px;width:auto;min-width:200px;max-width:280px;font-size:.86rem}
.activity-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.answers{margin:10px 0 0;display:grid;gap:4px}
.answers dt{font-size:.84rem;font-weight:500;color:var(--muted);margin-top:8px}
.answers dd{margin:0;white-space:pre-wrap;word-break:break-word}
.small-note{font-size:.84rem;margin:-6px 0 14px}
fieldset.group-picks{border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 14px;margin:8px 0 0;width:100%;display:flex;flex-wrap:wrap;gap:4px 18px}
fieldset.group-picks legend{font-size:.78rem;font-weight:600;color:var(--ink-2);padding:0 4px}
fieldset.group-picks .check{margin:0}
.group-features{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-bottom:26px}
.group-features .card{margin:0}
.group-feature{display:flex;flex-direction:column;gap:14px}
.group-feature-main,.group-tile-main{display:flex;gap:14px;align-items:center;text-decoration:none;color:var(--ink)}
.group-feature-main:hover,.group-tile-main:hover{text-decoration:none}
.group-feature-main img,.group-feature-main .server-ph{width:52px;height:52px;border-radius:var(--r);flex:none}
.group-name{display:block;font-size:1.05rem;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.group-feature-main:hover .group-name,.group-tile-main:hover .group-name{text-decoration:underline;text-underline-offset:3px}
.group-meta{display:block;color:var(--muted);font-size:.85rem;margin-top:3px}
.group-meta b{color:var(--ink);font-variant-numeric:tabular-nums}
.group-desc{display:block;color:var(--ink-2);font-size:.86rem;margin-top:6px}
.section-head{display:flex;align-items:baseline;gap:12px;margin:0 0 12px}
.group-tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-bottom:22px}
.group-tile{display:flex;flex-direction:column;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}
.group-tile:hover{border-color:var(--line-2)}
.group-tile .group-name{font-size:.92rem}
.group-tile-main img,.group-tile-main .server-ph{width:36px;height:36px;border-radius:var(--r-sm);flex:none}
.group-tile-main>span{flex:1;min-width:0}
.tile-arrow{color:var(--muted);flex:none}
.tile-links{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.82rem;padding-top:10px;border-top:1px solid var(--line)}
.tile-links a{color:var(--muted);text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.tile-links a:hover{color:var(--ink)}
.tile-links .ic{display:inline}
details.add-group summary{cursor:pointer;font-size:.9rem;font-weight:500;color:var(--ink-2)}
details.add-group[open] summary{margin-bottom:14px}
a.plain{color:inherit;text-decoration:none}
a.plain:hover{text-decoration:underline}
.panel-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
@media (max-width:1100px){.panel-grid{grid-template-columns:minmax(0,1fr)}}
.panel-grid>.card{position:sticky;top:20px;align-self:start}
.panel-form .btn-row{margin-top:4px}
.dc{background:#313338;color:#dbdee1;border-radius:4px;padding:16px;font-size:.92rem;line-height:1.375}
.dc-embed{background:#2b2d31;border-left:4px solid #8a7a4a;border-radius:4px;padding:12px 16px 14px;max-width:520px}
.c-khaki{border-left-color:#8a7a4a}.c-green{border-left-color:#3b7d3b}.c-red{border-left-color:#a33b3b}.c-blue{border-left-color:#3a5f8a}.c-gold{border-left-color:#c08a2a}.c-orange{border-left-color:#d9822b}.c-grey{border-left-color:#6b6f73}
.dc-title{color:#f2f3f5;font-weight:600;font-size:1rem;margin-bottom:8px}
.dc-body{word-break:break-word}
.dc-body a{color:#00a8fc;text-decoration:none}
.dc-body ul,.dc-body ol{margin:2px 0;padding-left:22px}
.dc-body code{background:#1e1f22;border:0;color:#dbdee1}
.md-h1{font-size:1.45rem;font-weight:700;color:#f2f3f5;margin:6px 0 2px}
.md-h2{font-size:1.2rem;font-weight:700;color:#f2f3f5;margin:6px 0 2px}
.md-h3{font-size:1.02rem;font-weight:700;color:#f2f3f5;margin:6px 0 2px}
.md-small{font-size:.76rem;color:#949ba4}
.md-quote{border-left:4px solid #4e5058;padding-left:10px}
.md-gap{height:.9em}
.md-code{background:#1e1f22;border-radius:4px;padding:8px 10px;margin:4px 0;white-space:pre-wrap;font-family:var(--mono);font-size:.84rem}
.md-mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px;font-weight:500}
.md-emoji{height:1.375em;width:auto;vertical-align:-.3em}
.md-spoiler{background:#1e1f22;color:transparent;border-radius:3px}
.md-spoiler:hover{color:inherit}
.dc-img{display:block;max-width:100%;max-height:300px;border-radius:4px;margin-top:12px}
.dc-note{margin:10px 0 0;font-size:.8rem;color:#949ba4;word-break:break-all}
.dc-foot{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:.75rem;color:#b5bac1}
.dc-foot img{border-radius:50%}
.dc-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.dc-btn{display:inline-flex;align-items:center;gap:6px;background:#4e5058;color:#fff;text-decoration:none;border-radius:3px;padding:5px 14px;font-weight:500;font-size:.86rem}
.dc-btn:hover{background:#6d6f78}
.dc-btn .ic{display:inline}
.dc .flash{margin:10px 0 0;background:#2b2d31;border-color:#3f4147;color:#dbdee1}

/* sign in */
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:32px 28px 28px;text-align:center}
.login-logo{display:block;margin:0 auto 16px;border-radius:10px;width:64px;height:64px}
.login-card h1{margin-bottom:4px}
.login-card .kicker{margin:0 0 14px;color:var(--muted);font-size:.9rem}
.login-card .btn{width:100%;margin-top:20px;min-height:38px}
.login-card .flash{text-align:left}

/* ---------- motion: kept quiet on purpose ---------- */
/* a quick cross-fade between pages (browsers that support it); the sidebar stays put */
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.12s}
.side{view-transition-name:side}

/* colours change smoothly instead of snapping */
a,.btn,button,.nav-item,.chips a,.tabs a,.tile-links a,.icon-btn,.link-btn{transition:color .15s,background-color .15s,border-color .15s}
input,select,textarea{transition:border-color .15s}
.card,.group-tile,.approval{transition:border-color .15s}
.group-tile:hover,.server-card:hover,.group-feature:hover,a.stat:hover{border-color:var(--line-2)}
.tile-arrow{transition:color .15s}
.group-tile:hover .tile-arrow{color:var(--ink)}

/* tab underline slides in */
.tabs a{position:relative;border-bottom-color:transparent!important}
.tabs a::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--ink);transform:scaleX(0);transition:transform .2s ease-out}
.tabs a[aria-current]::after{transform:scaleX(1)}

/* progress bars fill once when the page opens */
@keyframes bar-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}
progress::-webkit-progress-value{transform-origin:left;animation:bar-in .6s ease-out both}

/* folding sections */
details>summary{list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"";display:inline-block;width:6px;height:6px;margin-right:9px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s;vertical-align:2px}
details[open]>summary::before{transform:rotate(45deg)}

*{scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  @view-transition{navigation:none}
}
`;

/** Changes whenever the styles do, so browsers fetch the new stylesheet after an update. */
export const STYLE_VERSION = createHash('sha256').update(STYLE).digest('hex').slice(0, 10);
