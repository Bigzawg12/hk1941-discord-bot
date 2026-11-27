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

export function empty(title: string, hint?: string | Html, ic = 'inbox'): Html {
  return html`<div class="empty">${icon(ic, 'ic big')}<p class="empty-title">${title}</p>${hint ? html`<p class="muted">${hint}</p>` : ''}</div>`;
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

export function layout(opts: { title: string; session: Session; body: Html; nav?: string; counts?: NavCounts; bare?: boolean }): string {
  const { session: s } = opts;
  const flash = s.flash;
  s.flash = undefined;
  const item = (href: string, label: string, key: string, ic: string, count?: number) =>
    html`<a href="${href}" class="nav-item"${opts.nav === key ? new Html(' aria-current="page"') : ''}>${icon(ic)}<span>${label}</span>${count ? html`<span class="count">${count}</span>` : ''}</a>`;
  const signedIn = !!s.user && !opts.bare;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title} · HK1941 dashboard</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css?v=${STYLE_VERSION}">
</head>
<body class="${signedIn ? 'app' : 'bare'}">
${
  signedIn
    ? html`<aside class="side">
  <a class="brand" href="/">${icon('shield', 'ic brand-ic')}<span><b>HK1941</b><small>Admin dashboard</small></span></a>
  <nav class="nav" aria-label="Main">
    ${item('/', 'Overview', 'home', 'home')}
    ${item('/approvals', 'Approvals', 'approvals', 'inbox', opts.counts?.approvals)}
    ${item('/game-log', 'Game log', 'gamelog', 'log')}
    ${item('/servers', 'Servers', 'servers', 'server')}
    ${item('/links', 'Linked accounts', 'links', 'link')}
  </nav>
  <form method="post" action="/logout" class="me">${csrfField(s)}<img src="${discordAvatar(s.user!)}" alt="" width="32" height="32"><span class="me-name">${s.user!.globalName ?? s.user!.username}<small>Signed in</small></span><button class="icon-btn" title="Sign out" aria-label="Sign out">${icon('out')}</button></form>
</aside>`
    : ''
}
<main class="main">
${flash ? html`<div class="flash ${flash.kind}" role="status">${icon(flash.kind === 'ok' ? 'check' : 'x')}<span>${flash.text}</span></div>` : ''}
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
  --bg:#f3f1ea;--side:#ebe7dc;--panel:#fffdf8;--panel-2:#f7f4ec;--ink:#22211d;--ink-2:#4a473f;--muted:#76705f;--line:#e0dacb;--line-2:#d2cab5;
  --accent:#7a6a2e;--accent-2:#958447;--accent-soft:#efe8d0;--accent-ink:#fff;
  --ok:#2e7d4f;--ok-soft:#e2f2e8;--warn:#9a6a00;--warn-soft:#fbefcf;--bad:#b23b3b;--bad-soft:#f8e1e1;--info:#2f5f9a;--info-soft:#e1ebf7;
  --field:#fff;--shadow:0 1px 2px rgba(40,35,20,.06),0 4px 14px rgba(40,35,20,.05);--radius:12px
}
@media (prefers-color-scheme:dark){:root{
  --bg:#121210;--side:#171714;--panel:#1d1d19;--panel-2:#23221e;--ink:#eeeae0;--ink-2:#c9c4b6;--muted:#9a9483;--line:#2d2c26;--line-2:#3a3830;
  --accent:#c2ad62;--accent-2:#d4c07a;--accent-soft:#2c291c;--accent-ink:#17160f;
  --ok:#6cc18f;--ok-soft:#18291f;--warn:#e0b450;--warn-soft:#2e2614;--bad:#ee8a8a;--bad-soft:#331c1c;--info:#86b2ea;--info-soft:#172433;
  --field:#191915;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 18px rgba(0,0,0,.25)
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-underline-offset:2px}
.ic{width:18px;height:18px;flex:none}.ic.big{width:34px;height:34px;color:var(--muted)}.ic.sm{width:14px;height:14px}
@media (prefers-color-scheme:dark){.btn.ok,button.ok{color:#0e1a12}.btn.danger,button.danger{color:#200e0e}}
h1{font-size:1.55rem;line-height:1.25;margin:0;letter-spacing:-.01em}
h2{font-size:1.02rem;margin:0}
h3{font-size:.95rem;margin:0}
.muted{color:var(--muted)}
code,.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.86em}
code{background:var(--panel-2);border:1px solid var(--line);border-radius:5px;padding:1px 5px}

/* shell */
body.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:18px 14px;background:var(--side);border-right:1px solid var(--line)}
.brand{display:flex;gap:10px;align-items:center;text-decoration:none;color:var(--ink);padding:4px 8px}
.brand b{display:block;font-size:1.05rem;letter-spacing:.04em}.brand small{display:block;color:var(--muted);font-size:.78rem}
.brand-ic{width:30px;height:30px;color:var(--accent)}
.nav{display:flex;flex-direction:column;gap:2px;flex:1}
.nav-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;color:var(--ink-2);text-decoration:none;font-weight:500}
.nav-item:hover{background:var(--panel-2);color:var(--ink)}
.nav-item[aria-current]{background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}
.nav-item[aria-current] .ic{color:var(--accent)}
.count{margin-left:auto;background:var(--accent);color:var(--accent-ink);border-radius:99px;font-size:.74rem;font-weight:700;padding:0 7px;min-width:20px;text-align:center}
.me{display:flex;align-items:center;gap:10px;margin:0;padding:10px;border-radius:10px;background:var(--panel);border:1px solid var(--line)}
.me img{border-radius:50%}
.me-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.me-name small{display:block;font-weight:400;color:var(--muted);font-size:.75rem}
.main{padding:28px 36px 72px;max-width:1240px;width:100%}
body.bare .main{max-width:none;padding:0}
@media (max-width:860px){
  body.app{display:block}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px}
  .brand small,.me-name small{display:none}
  .nav{flex-direction:row;overflow-x:auto;order:3;width:100%;flex:none}
  .nav-item{white-space:nowrap;padding:7px 10px}
  .me{margin-left:auto;padding:4px 6px;background:none;border:0}
  .me-name{display:none}
  .main{padding:18px 16px 56px}
}

/* page */
.page-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;justify-content:space-between;margin-bottom:22px}
.sub{color:var(--muted);margin:4px 0 0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.flash{display:flex;gap:10px;align-items:center;padding:11px 14px;border-radius:10px;margin-bottom:18px;font-weight:500}
.flash.ok{background:var(--ok-soft);color:var(--ok)}.flash.bad{background:var(--bad-soft);color:var(--bad)}

/* cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:18px;box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.card.flush>.card-head{padding:16px 20px 12px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.card.flush>.card-head{margin:0;border-bottom:1px solid var(--line)}
.card-head a{font-size:.88rem;text-decoration:none;font-weight:500}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid-2{display:grid;gap:18px;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}
@media (max-width:1100px){.grid-2{grid-template-columns:minmax(0,1fr)}}
.grid>.card,.grid-2>.card{margin-bottom:0}
.stack{display:flex;flex-direction:column;gap:18px}

/* stats */
.stats{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:18px}
.stat{display:flex;gap:14px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);text-decoration:none;color:inherit}
a.stat:hover{border-color:var(--line-2)}
.stat-ic{display:grid;place-items:center;width:42px;height:42px;border-radius:11px;background:var(--accent-soft);color:var(--accent)}
.stat-ic.ok{background:var(--ok-soft);color:var(--ok)}.stat-ic.warn{background:var(--warn-soft);color:var(--warn)}.stat-ic.info{background:var(--info-soft);color:var(--info)}
.stat-n{display:block;font-size:1.6rem;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.stat-l{display:block;color:var(--muted);font-size:.85rem}

/* tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.05em;background:var(--panel-2);white-space:nowrap}
tbody tr:hover{background:var(--panel-2)}
tbody tr:last-child td{border-bottom:0}
td.nowrap,th.nowrap{white-space:nowrap}
td.wrap{word-break:break-word;min-width:220px}
.card:not(.flush) table th:first-child,.card:not(.flush) table td:first-child{padding-left:0}
.card:not(.flush) th{background:none}
.who{display:flex;align-items:center;gap:9px;min-width:0}
.who img{border-radius:50%;flex:none}
.who .stack-sm{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.who small{color:var(--muted);font-size:.78rem}
.avatar-ph{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--panel-2);color:var(--muted);font-weight:700;font-size:.8rem;flex:none}
.cmd{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.85rem;color:var(--ink-2);word-break:break-word}

/* badges */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;font-size:.75rem;font-weight:600;white-space:nowrap;background:var(--panel-2);color:var(--ink-2);border:1px solid var(--line)}
.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.badge.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}.badge.info{background:var(--info-soft);color:var(--info);border-color:transparent}
.badge.accent{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.badge.cmd-badge{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;text-transform:lowercase}

/* forms */
form{margin:0}
.field{display:flex;flex-direction:column;gap:5px;min-width:0}
label{font-size:.82rem;font-weight:600;color:var(--ink-2)}
.hint{margin:0;color:var(--muted);font-size:.8rem}
.fields{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:18px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.row .field{flex:1 1 180px}
.row .field.narrow{flex:0 1 120px}
input,select,textarea{font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line-2);border-radius:8px;padding:8px 10px;width:100%;min-height:38px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent-2);outline-offset:0;border-color:transparent}
input[type=checkbox]{width:18px;height:18px;min-height:0;accent-color:var(--accent);margin:0}
.check{display:flex;gap:9px;align-items:center;font-weight:500;color:var(--ink)}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-weight:600;background:var(--accent);color:var(--accent-ink);border:1px solid transparent;border-radius:8px;padding:8px 15px;min-height:38px;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover,button:hover{filter:brightness(1.06)}
.btn.secondary,button.secondary{background:var(--panel);color:var(--ink);border-color:var(--line-2)}
.btn.secondary:hover,button.secondary:hover{background:var(--panel-2);filter:none}
.btn.danger,button.danger{background:var(--bad);color:#fff}
.btn.ok,button.ok{background:var(--ok);color:#fff}
.btn.sm,button.sm{padding:5px 11px;min-height:32px;font-size:.85rem}
.icon-btn{background:none;color:var(--muted);padding:6px;min-height:0;border-radius:8px}
.icon-btn:hover{background:var(--panel-2);color:var(--ink);filter:none}
.inline{display:inline-flex;gap:6px;flex-wrap:wrap}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel-2)}
.toolbar .field{flex:1 1 160px}
.toolbar .field.grow{flex:3 1 240px}
.input-ic{position:relative}.input-ic .ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);width:16px;height:16px}.input-ic input{padding-left:32px}

/* tabs */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px;overflow-x:auto}
.tabs a{padding:9px 14px;color:var(--muted);text-decoration:none;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--accent)}

/* approvals */
.approval{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:0;padding:0;overflow:hidden}
@media (max-width:900px){.approval{grid-template-columns:minmax(0,1fr)}}
.approval-main{padding:18px 20px;border-left:4px solid var(--accent);min-width:0}
.approval-side{padding:18px 20px;background:var(--panel-2);border-left:1px solid var(--line);display:flex;flex-direction:column;gap:12px}
.kind-announcement{border-left-color:#6b6f73}.kind-recruitment{border-left-color:#3b7d3b}.kind-shout{border-left-color:#3a5f8a}.kind-notice{border-left-color:#8a7a4a}.kind-orders{border-left-color:#a33b3b}.kind-training{border-left-color:#5b6e3a}.kind-event{border-left-color:#c08a2a}.kind-ssu{border-left-color:#c23b3b}
.approval-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.approval h3{font-size:1.15rem;margin:0 0 2px}
.preview{white-space:pre-wrap;word-break:break-word;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0 0;max-height:320px;overflow:auto}
.preview-img{display:block;max-width:100%;max-height:240px;border-radius:10px;margin-top:12px;border:1px solid var(--line)}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:.86rem;margin:0}
.meta dt{color:var(--muted)}.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.links-out{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}

/* lists */
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0}
.list .title{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list .grow>small,.list .grow>.cmd{display:block}
.list .nowrap{text-align:right;font-size:.85rem}
.checklist{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.checklist li{display:flex;gap:10px;align-items:center}
.dot{width:9px;height:9px;border-radius:50%;background:var(--line-2);flex:none}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.server-card{display:flex;flex-direction:column;gap:14px}
.server-top{display:flex;gap:12px;align-items:center}
.server-top img,.server-ph{width:44px;height:44px;border-radius:12px;flex:none}
.server-ph{display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-weight:700}

/* empty + pager */
.empty{text-align:center;padding:34px 16px;color:var(--muted)}
.empty-title{color:var(--ink);font-weight:600;margin:8px 0 2px}
.pager{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--line);font-size:.88rem}

/* sign in */
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:34px 30px;text-align:center;box-shadow:var(--shadow)}
.login-card .brand-ic{width:46px;height:46px;margin:0 auto 10px;display:block}
.login-card h1{margin-bottom:6px}
.login-card .btn{width:100%;margin-top:22px;background:#5865f2;color:#fff;min-height:44px}
`;

/** Changes whenever the styles do, so browsers fetch the new stylesheet after an update. */
export const STYLE_VERSION = createHash('sha256').update(STYLE).digest('hex').slice(0, 10);
