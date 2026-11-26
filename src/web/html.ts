import type { Session } from './session.js';
import { discordAvatar } from './oauth.js';

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

export function select(name: string, options: Option[], selected: string | undefined, { none = '— off —' }: { none?: string | null } = {}): Html {
  return html`<select name="${name}" id="${name}">
    ${none !== null ? html`<option value="">${none}</option>` : ''}
    ${options.map((o) => html`<option value="${o.value}"${o.value === selected ? new Html(' selected') : ''}>${o.label}</option>`)}
  </select>`;
}

export function layout(opts: { title: string; session: Session; body: Html; nav?: string }): string {
  const { session: s } = opts;
  const flash = s.flash;
  s.flash = undefined;
  const link = (href: string, label: string, key: string) =>
    html`<a href="${href}"${opts.nav === key ? new Html(' aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title} · HK1941 dashboard</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">HK1941 <span>dashboard</span></a>
  ${
    s.user
      ? html`<nav>${link('/', 'Overview', 'home')}${link('/servers', 'Servers', 'servers')}${link('/links', 'Linked accounts', 'links')}</nav>
  <form method="post" action="/logout" class="me">${csrfField(s)}<img src="${discordAvatar(s.user)}" alt="" width="28" height="28"><span>${s.user.globalName ?? s.user.username}</span><button class="link">Sign out</button></form>`
      : ''
  }
</header>
<main>
${flash ? html`<p class="flash ${flash.kind}" role="status">${flash.text}</p>` : ''}
${opts.body}
</main>
</body>
</html>`.value;
}

export const STYLE = `
:root{--bg:#f4f1e8;--panel:#fffdf7;--ink:#24231f;--muted:#6b675c;--line:#d9d3c1;--accent:#6f6338;--accent-ink:#fff;--ok:#2f6b2f;--bad:#9c2f2f;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#171713;--panel:#211f1a;--ink:#ece8db;--muted:#a39e8d;--line:#3a372e;--accent:#b5a467;--accent-ink:#171713;--ok:#7fbf7f;--bad:#e08a8a;--field:#2a2821}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
.top{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{font-weight:700;text-decoration:none;color:var(--ink);letter-spacing:.02em}.brand span{color:var(--muted);font-weight:400}
nav{display:flex;gap:16px;flex:1}nav a{text-decoration:none;color:var(--muted)}nav a[aria-current]{color:var(--ink);font-weight:600}
.me{display:flex;align-items:center;gap:8px;margin:0}.me img{border-radius:50%}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:16px}
.stat{font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);font-size:.85rem}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:2px}
.fields{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:12px}
input,select,textarea{font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:100%}
input[type=checkbox]{width:auto}
button{font:inherit;background:var(--accent);color:var(--accent-ink);border:0;border-radius:6px;padding:7px 14px;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
button.danger{background:var(--bad);color:#fff}
button.link{background:none;color:var(--muted);padding:0;text-decoration:underline}
.flash{padding:10px 14px;border-radius:6px;border:1px solid var(--line);background:var(--panel)}
.flash.ok{border-color:var(--ok);color:var(--ok)}.flash.bad{border-color:var(--bad);color:var(--bad)}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:.8rem}
.inline{display:inline}
.center{max-width:420px;margin:12vh auto;text-align:center}
code{background:var(--field);border:1px solid var(--line);border-radius:4px;padding:0 4px}
`;
