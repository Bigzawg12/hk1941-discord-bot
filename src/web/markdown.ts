import { h, Html } from './html.js';

/** What the preview needs to know about a server: channel, role and emoji names. */
export interface PreviewGuild {
  channels?: { cache: Map<string, { name?: string | null }> };
  roles?: { cache: Map<string, { name: string }> };
}

/**
 * A close-enough HTML version of Discord markdown for the dashboard's panel preview: headings,
 * `-#` small text, lists, quotes, bold, italic, underline, strike, code, spoilers, links,
 * channel and role mentions and custom emoji. Everything is escaped first; only http(s) links
 * become links.
 */
export function discordMarkdown(src: string, guild?: PreviewGuild | null): Html {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  let inCode = false;
  let code: string[] = [];
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push(`<pre class="md-code">${h(code.join('\n'))}</pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\s*[-*] +(.*)$/.exec(line))) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1]!, guild)}</li>`);
      continue;
    }
    if ((m = /^\s*\d+[.)] +(.*)$/.exec(line))) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[1]!, guild)}</li>`);
      continue;
    }
    closeList();
    if ((m = /^(#{1,3}) +(.*)$/.exec(line))) out.push(`<div class="md-h${m[1]!.length}">${inline(m[2]!, guild)}</div>`);
    else if ((m = /^-# +(.*)$/.exec(line))) out.push(`<div class="md-small">${inline(m[1]!, guild)}</div>`);
    else if ((m = /^>>?>? ?(.*)$/.exec(line))) out.push(`<div class="md-quote">${inline(m[1]!, guild) || '&nbsp;'}</div>`);
    else if (!line.trim()) out.push('<div class="md-gap"></div>');
    else out.push(`<div>${inline(line, guild)}</div>`);
  }
  if (inCode) out.push(`<pre class="md-code">${h(code.join('\n'))}</pre>`);
  closeList();
  return new Html(out.join(''));
}

function inline(text: string, guild?: PreviewGuild | null): string {
  // `code` first, so nothing inside it is formatted
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? `<code>${h(part.slice(1, -1))}</code>` : format(h(part), guild)))
    .join('');
}

function format(s: string, guild?: PreviewGuild | null): string {
  // links, emoji and mentions are swapped for placeholders while bold/italic is applied, so an
  // underscore in a link or emoji name can't turn into italics
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  const linked = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => hold(`<a href="${url}" target="_blank" rel="noreferrer noopener">`) + text + hold('</a>'))
    .replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s\u0000])+/g, (url) => hold(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`))
    .replace(/&lt;a?:([A-Za-z0-9_]{2,32}):(\d{15,25})&gt;/g, (_m, name: string, id: string) => hold(`<img class="md-emoji" src="https://cdn.discordapp.com/emojis/${id}.png" alt=":${name}:" title=":${name}:">`))
    .replace(/&lt;#(\d{15,25})&gt;/g, (_m, id: string) => hold(`<span class="md-mention">#${h(guild?.channels?.cache.get(id)?.name ?? 'unknown')}</span>`))
    .replace(/&lt;@&amp;(\d{15,25})&gt;/g, (_m, id: string) => hold(`<span class="md-mention">@${h(guild?.roles?.cache.get(id)?.name ?? 'deleted role')}</span>`))
    .replace(/&lt;@!?(\d{15,25})&gt;/g, () => hold('<span class="md-mention">@user</span>'));
  return emphasis(linked).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)] ?? '');
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler">$1</span>');
}
