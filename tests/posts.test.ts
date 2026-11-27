import { MessageFlags, type Interaction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { parseMessageRef } from '../src/commands/panel.js';
import { handleInteraction } from '../src/discord/dispatch.js';
import { loadCommands } from '../src/loaders/commands.js';
import {
  allowedMentionsFor,
  collapseText,
  draftLabel,
  expandText,
  liveComponents,
  neutralise,
  parseButtons,
  renderAnnouncement,
  renderPanel,
  renderPost,
  renderSsu,
  type PostDraft,
  type SsuDraft,
} from '../src/posts/render.js';
import { pickEvent } from '../src/posts/workflow.js';
import { discordMarkdown } from '../src/web/markdown.js';
import { fakeButton, fakeClient, fakeInteraction, fakeModal, IDS, replyText, testServices } from './helpers/fixtures.js';
import { json, type Route } from './helpers/mockFetch.js';

const APPROVAL = '600000000000000001';
const POSTS = '600000000000000002';
const SSUS = '600000000000000003';
const UNIVERSE = 10772680614;

const draft = (over: Partial<PostDraft> = {}): PostDraft => ({
  type: 'post',
  kind: 'recruitment',
  title: 'Royal Rifles of Canada',
  subtitle: 'C Force, Hong Kong',
  body: 'We are recruiting **riflemen**.',
  signature: 'Maj_Test\nOfficer Commanding\nC Company',
  buttons: [{ label: 'Apply here', url: 'https://example.com/apply' }],
  colour: 0x3b7d3b,
  ping: { kind: 'none' },
  ...over,
});

const ssuDraft = (over: Partial<SsuDraft> = {}): SsuDraft => ({
  type: 'ssu',
  message: 'Servers are up!',
  colour: 0xd9822b,
  ping: { kind: 'here' },
  placeId: 77901932829123,
  ...over,
});

/** Everything the payload would show, as one string. */
function shown(payload: unknown): string {
  const p = payload as { components?: { toJSON?: () => unknown }[]; embeds?: { toJSON(): unknown }[]; content?: string };
  return JSON.stringify({
    content: p.content,
    components: (p.components ?? []).map((c) => (c.toJSON ? c.toJSON() : c)),
    embeds: (p.embeds ?? []).map((e) => e.toJSON()),
  });
}

function customIds(payload: unknown): string[] {
  return [...shown(payload).matchAll(/"custom_id":"([^"]+)"/g)].map((m) => m[1]!);
}

async function setup(routes: Route[] = [], env: Record<string, string> = {}, settings = true) {
  const { services } = testServices(routes, env);
  services.commands = await loadCommands();
  if (settings) {
    await services.guilds.update(IDS.guild, 'test', (s) => {
      s.approvalChannelId = APPROVAL;
      s.postChannelId = POSTS;
      s.ssuChannelId = SSUS;
    });
  }
  return services;
}

const run = (services: Awaited<ReturnType<typeof setup>>, i: unknown) => handleInteraction(services, i as Interaction);

const FORM = {
  title: ':crest: | Royal Rifles of Canada',
  subtitle: 'C Force',
  body: 'Join us. @everyone welcome.',
  signature: 'Maj_Test\nOC',
  buttons: 'Apply here | https://example.com/apply',
};

describe('post layout', () => {
  it('shows the kind, sender, title, text, buttons, signature and approver', () => {
    const json = JSON.stringify(renderPost(draft(), { authorId: '42', approvedBy: 'Col_Approver' }).toJSON());
    expect(json).toContain('"accent_color":3898683');
    expect(json).toContain('Recruitment');
    expect(json).toContain('**Sent by:** <@42>');
    expect(json).toContain('## Royal Rifles of Canada\\n*C Force, Hong Kong*');
    expect(json).toContain('https://example.com/apply');
    expect(json).toContain('**Maj_Test**\\n**Officer Commanding**\\n**C Company**');
    expect(json).toContain('**Approved by:** Col_Approver');
  });

  it('announcement: ping, heading, text, buttons, signature and a small Sent by line, with no kind header or approver', () => {
    const d = draft({ kind: 'announcement', title: 'Server update', subtitle: undefined, ping: { kind: 'everyone' } });
    const json = JSON.stringify(renderAnnouncement(d, { authorId: '42', approvedBy: 'Col_Approver' }).toJSON());
    expect(json).toContain('"content":"@everyone"');
    expect(json).toContain('## Server update');
    expect(json).toContain('We are recruiting **riflemen**.');
    expect(json).toContain('https://example.com/apply');
    expect(json).toContain('**Maj_Test**');
    expect(json).toContain('-# Sent by <@42>');
    expect(json).not.toContain('accent_color');
    expect(json).not.toContain('Approved by');
    expect(json).not.toContain('Col_Approver');
    expect(JSON.stringify(renderAnnouncement(draft({ kind: 'announcement', title: '' }), { authorId: '42' }).toJSON())).toContain('waiting for approval');
    expect(draftLabel(draft({ kind: 'announcement', title: '', body: 'Servers\nare up' }))).toBe('Announcement "Servers are up"');
  });

  it('a live announcement is loose parts; signed posts stay in their box', () => {
    const plain = liveComponents(draft({ kind: 'announcement' }), { authorId: '1', approvedBy: 'X' }).map((c) => c.toJSON() as { type: number });
    expect(plain.map((c) => c.type)).not.toContain(17); // 17 = container
    expect(plain[0]!.type).toBe(10); // 10 = text
    const boxed = liveComponents(draft(), { authorId: '1', approvedBy: 'X' }).map((c) => c.toJSON() as { type: number });
    expect(boxed.map((c) => c.type)).toEqual([17]);
  });

  it('says it is waiting until approved', () => {
    expect(JSON.stringify(renderPost(draft(), { authorId: '42' }).toJSON())).toContain('Waiting for approval');
  });

  it('only lets the chosen ping through', () => {
    expect(allowedMentionsFor({ kind: 'none' }, true)).toEqual({ parse: [] });
    expect(allowedMentionsFor({ kind: 'here' }, true)).toEqual({ parse: ['everyone'] });
    expect(allowedMentionsFor({ kind: 'role', roleId: '9' }, true)).toEqual({ parse: [], roles: ['9'] });
    expect(allowedMentionsFor({ kind: 'everyone' }, false)).toEqual({ parse: [] }); // previews never ping
  });

  it('stops @everyone typed in the text from pinging', () => {
    expect(neutralise('hi @everyone and @here')).toBe('hi @​everyone and @​here');
  });

  it("turns :emoji: and #channel into this server's emoji and channel links", () => {
    const guild = {
      emojis: { cache: new Map([['1', { id: '123456789012345678', name: 'crest', animated: false }]]) },
      channels: { cache: new Map([['2', { id: '223456789012345678', name: 'apply-here' }]]) },
    };
    expect(expandText(':crest: | See #apply-here, not #nope or :nope:', guild)).toBe('<:crest:123456789012345678> | See <#223456789012345678>, not #nope or :nope:');
    expect(expandText('<:crest:123456789012345678>', guild)).toBe('<:crest:123456789012345678>');
    expect(expandText('## Heading', guild)).toBe('## Heading');
  });

  it('turns this server’s emoji and channel links back into what you’d type, for editing', () => {
    const guild = {
      emojis: { cache: new Map([['1', { id: '123456789012345678', name: 'crest', animated: false }]]) },
      channels: { cache: new Map([['2', { id: '223456789012345678', name: 'apply-here' }]]) },
    };
    expect(collapseText('<:crest:123456789012345678> see <#223456789012345678>, <#999999999999999999> and <:other:999999999999999999>', guild)).toBe(
      ':crest: see #apply-here, <#999999999999999999> and <:other:999999999999999999>',
    );
  });

  it('dashboard preview: Discord markdown, escaped, with only http(s) links', () => {
    const out = discordMarkdown('## Head\n- **a** *b* __c__ ~~d~~\n> quote\n-# small\n[x](javascript:alert(1)) [ok](https://e.example/a_b_c) <img src=x>\n`**raw**`', {
      channels: { cache: new Map() },
    }).value;
    expect(out).toContain('<div class="md-h2">Head</div>');
    expect(out).toContain('<li><strong>a</strong> <em>b</em> <u>c</u> <s>d</s></li>');
    expect(out).toContain('<div class="md-quote">quote</div>');
    expect(out).toContain('<div class="md-small">small</div>');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('<a href="https://e.example/a_b_c" target="_blank" rel="noreferrer noopener">ok</a>');
    expect(out).toContain('&lt;img src=x&gt;');
    expect(out).toContain('<code>**raw**</code>');
  });

  it('reads link buttons and explains bad lines', () => {
    expect(parseButtons('Apply | https://a.example\n\nDiscord | https://discord.gg/x')).toEqual([
      { label: 'Apply', url: 'https://a.example' },
      { label: 'Discord', url: 'https://discord.gg/x' },
    ]);
    expect(() => parseButtons('Apply https://a.example')).toThrow(/Label \| https/);
    expect(() => parseButtons('Apply | a.example')).toThrow(/full link/);
    expect(() => parseButtons(Array(6).fill('A | https://a.example').join('\n'))).toThrow(/At most 5/);
  });

  it('refuses a post that is too long for one message', () => {
    expect(() => renderPost(draft({ body: 'x'.repeat(3600), signature: 'y'.repeat(300) }), { authorId: '1' })).toThrow(/too long/);
  });

  it('SSU: Join button for the place, ping, event in red, live servers', () => {
    const json = JSON.stringify(
      renderSsu(ssuDraft(), { authorId: '1', approvedBy: 'Maj_Test', liveEvent: { title: 'Defence of the Gap' }, serversLine: '🟢 1 server live · 9 playing' }).toJSON(),
    );
    expect(json).toContain('https://www.roblox.com/games/77901932829123');
    expect(json).toContain('Join Hong Kong 1941');
    expect(json).toContain('Ping: @here');
    expect(json).toContain('```diff\\n- Defence of the Gap\\n```');
    expect(json).toContain('9 playing');
    expect(json).toContain('Approved by: Maj_Test');
  });

  it('SSU: an event starting soon shows when', () => {
    const json = JSON.stringify(renderSsu(ssuDraft(), { authorId: '1', liveEvent: { title: 'Drill', startsAt: 1800000000 } }).toJSON());
    expect(json).toContain('An event starts <t:1800000000:R>');
  });

  it('picks the running event, else the next one within the hour', () => {
    const now = 1_800_000_000;
    const ev = (id: string, start: number) => ({ id, title: `E${id}`, detail: '', start, host: 'h' });
    expect(pickEvent([ev('1', now - 600), ev('2', now + 600)], now, 120)).toEqual({ title: 'E1' });
    expect(pickEvent([ev('1', now - 3 * 3600), ev('2', now + 600)], now, 120)).toEqual({ title: 'E2', startsAt: now + 600 });
    expect(pickEvent([ev('2', now + 2 * 3600)], now, 120)).toBeUndefined();
  });

  it('info panel: footer with the server name and buttons under it', () => {
    const out = renderPanel({ title: 'Guidebook', body: 'Read me', buttons: [{ label: 'Open', url: 'https://example.com' }], colour: 1 }, { name: 'HK1941', iconURL: () => 'https://cdn/icon.png' });
    const e = out.embeds[0]!.toJSON();
    expect(e.footer).toEqual({ text: 'HK1941', icon_url: 'https://cdn/icon.png' });
    expect(JSON.stringify(out.components[0]!.toJSON())).toContain('https://example.com');
  });

  it('reads message links and IDs', () => {
    expect(parseMessageRef('https://discord.com/channels/222222222222222222/333333333333333333/444444444444444444', 'here')).toEqual({
      channelId: '333333333333333333',
      messageId: '444444444444444444',
    });
    expect(parseMessageRef(' 444444444444444444 ', '555555555555555555')).toEqual({ channelId: '555555555555555555', messageId: '444444444444444444' });
    expect(parseMessageRef('nope', 'x')).toBeNull();
  });
});

/** /post as a Moderator (tier 2, below the default approvers) up to the approval queue. */
async function queuedPost(services: Awaited<ReturnType<typeof setup>>, fc = fakeClient()) {
  const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'recruitment', ping: 'here' }, roles: [IDS.modRole], client: fc });
  await run(services, cmd.interaction);
  const modalJson = (cmd.replies.at(-1) as { toJSON(): { custom_id: string; components: unknown[] } }).toJSON();
  expect(modalJson.custom_id).toMatch(/^post:compose:[0-9a-f]{12}$/);
  const form = fakeModal({ customId: modalJson.custom_id, fields: FORM, roles: [IDS.modRole], client: fc });
  await run(services, form.interaction);
  return { fc, form, modalJson };
}

describe('/post', () => {
  it('opens a form and sends a Moderator post to the approval channel, without pinging', async () => {
    const services = await setup();
    const { fc, form, modalJson } = await queuedPost(services);
    expect(modalJson.components).toHaveLength(5);
    expect(replyText(form.replies.at(-1))).toMatch(/Sent for approval in <#600000000000000001>/);
    expect(fc.sent).toHaveLength(1);
    const q = fc.sent[0]!;
    expect(q.channelId).toBe(APPROVAL);
    expect(q.payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(q.payload.allowedMentions).toEqual({ parse: [] });
    expect(shown(q.payload)).toContain('wants to post this in <#600000000000000002>');
    expect(shown(q.payload)).toContain('@​everyone welcome'); // typed @everyone can't ping
    expect(customIds(q.payload).filter((c) => /^post:(approve|reject):/.test(c))).toHaveLength(2);
  });

  it('is posted once a Senior Moderator approves, signed by them, and the author is told', async () => {
    const services = await setup();
    const { fc } = await queuedPost(services);
    const approveId = customIds(fc.sent[0]!.payload).find((c) => c.startsWith('post:approve:'))!;
    const btn = fakeButton({ customId: approveId, userId: IDS.otherUser, roles: [IDS.seniorRole], client: fc });
    await run(services, btn.interaction);
    expect(fc.sent).toHaveLength(2);
    const post = fc.sent[1]!;
    expect(post.channelId).toBe(POSTS);
    expect(shown(post.payload)).toContain('**Approved by:** tester');
    expect(shown(post.payload)).toContain(`**Sent by:** <@${IDS.staffUser}>`);
    expect(post.payload.allowedMentions).toEqual({ parse: ['everyone'] }); // the @here ping they asked for
    expect(shown(btn.replies.at(-1))).toContain('Approved');
    expect(fc.dms[0]?.userId).toBe(IDS.staffUser);
    expect(String(fc.dms[0]?.payload.content)).toMatch(/was approved by tester and posted/);
    expect((await services.posts.get(approveId.split(':')[2]!))?.status).toBe('approved');

    // pressing again does nothing
    const again = fakeButton({ customId: approveId, userId: IDS.otherUser, roles: [IDS.seniorRole], client: fc });
    await run(services, again.interaction);
    expect(replyText(again.replies.at(-1))).toMatch(/already approved/);
    expect(fc.sent).toHaveLength(2);
  });

  it("can't be approved by a Moderator, or by its author", async () => {
    const services = await setup([], { TIER3_ROLE_IDS: `${IDS.seniorRole},777777777777777777` });
    const { fc } = await queuedPost(services);
    const approveId = customIds(fc.sent[0]!.payload).find((c) => c.startsWith('post:approve:'))!;
    const mod = fakeButton({ customId: approveId, userId: IDS.otherUser, roles: [IDS.modRole], client: fc });
    await run(services, mod.interaction);
    expect(replyText(mod.replies.at(-1))).toMatch(/needs Senior Moderator \(3\)/);
    const self = fakeButton({ customId: approveId, userId: IDS.staffUser, roles: ['777777777777777777'], client: fc });
    await run(services, self.interaction);
    expect(replyText(self.replies.at(-1))).toMatch(/Someone else has to approve/);
    expect(fc.sent).toHaveLength(1);
  });

  it('reject asks for a reason, updates the queue and tells the author', async () => {
    const services = await setup();
    const { fc } = await queuedPost(services);
    const rejectId = customIds(fc.sent[0]!.payload).find((c) => c.startsWith('post:reject:'))!;
    const btn = fakeButton({ customId: rejectId, userId: IDS.otherUser, roles: [IDS.seniorRole], client: fc });
    await run(services, btn.interaction);
    const reasonModal = (btn.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON();
    expect(reasonModal.custom_id).toBe(rejectId.replace('reject', 'rejectwhy'));
    const why = fakeModal({ customId: reasonModal.custom_id, fields: { reason: 'Fix the link' }, userId: IDS.otherUser, roles: [IDS.seniorRole], client: fc, fromMessage: true });
    await run(services, why.interaction);
    expect(shown(why.replies.at(-1))).toContain('Rejected');
    expect(shown(why.replies.at(-1))).toContain('Fix the link');
    expect(String(fc.dms[0]?.payload.content)).toMatch(/not approved.*\n.*Fix the link/);
    expect(fc.sent).toHaveLength(1);
  });

  it('goes straight out for a Senior Moderator', async () => {
    const services = await setup();
    const fc = fakeClient();
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'shout' }, roles: [IDS.seniorRole], client: fc });
    await run(services, cmd.interaction);
    const id = (cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id;
    const form = fakeModal({ customId: id, fields: FORM, roles: [IDS.seniorRole], client: fc });
    await run(services, form.interaction);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.channelId).toBe(POSTS);
    expect(shown(fc.sent[0]!.payload)).toContain('**Approved by:** tester');
    expect(replyText(form.replies.at(-1))).toMatch(/✅ Posted in <#600000000000000002>/);
  });

  it('announcement: a shorter form, and a Senior Moderator’s goes out as a plain message with the ping', async () => {
    const services = await setup();
    const fc = fakeClient();
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'announcement', ping: 'everyone' }, roles: [IDS.seniorRole], client: fc });
    await run(services, cmd.interaction);
    const m = (cmd.replies.at(-1) as { toJSON(): { custom_id: string; title: string; components: unknown[] } }).toJSON();
    expect(m.title).toBe('Announcement');
    expect(m.components).toHaveLength(4); // no "line under the title"
    const form = fakeModal({
      customId: m.custom_id,
      fields: { title: '', body: 'Servers restart at 8pm. @here', signature: 'Maj_Test', buttons: '' },
      roles: [IDS.seniorRole],
      client: fc,
    });
    await run(services, form.interaction);
    expect(replyText(form.replies.at(-1))).toMatch(/✅ Posted in <#600000000000000002>/);
    const p = fc.sent[0]!;
    expect(p.payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(p.payload.allowedMentions).toEqual({ parse: ['everyone'] });
    const parts = (p.payload.components as { toJSON(): { type: number } }[]).map((c) => c.toJSON().type);
    expect(parts).not.toContain(17); // not boxed
    const s = shown(p.payload);
    expect(s).toContain('"content":"@everyone"');
    expect(s).toContain('Servers restart at 8pm. @​here'); // typed @here can't ping
    expect(s).toContain(`-# Sent by <@${IDS.staffUser}>`);
    expect(s).not.toContain('Approved by');
  });

  it('announcement from a Moderator waits boxed in the queue, then goes out plain', async () => {
    const services = await setup();
    const fc = fakeClient();
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'announcement' }, roles: [IDS.modRole], client: fc });
    await run(services, cmd.interaction);
    const id = (cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id;
    const form = fakeModal({ customId: id, fields: { title: 'Update', body: 'New map.', signature: '', buttons: '' }, roles: [IDS.modRole], client: fc });
    await run(services, form.interaction);
    const q = fc.sent[0]!;
    expect(q.channelId).toBe(APPROVAL);
    expect(shown(q.payload)).toContain('waiting for approval');
    expect((q.payload.components as { toJSON(): { type: number } }[]).map((c) => c.toJSON().type)).toContain(17);
    const approveId = customIds(q.payload).find((c) => c.startsWith('post:approve:'))!;
    await run(services, fakeButton({ customId: approveId, userId: IDS.otherUser, roles: [IDS.seniorRole], client: fc }).interaction);
    const live = fc.sent[1]!;
    expect(live.channelId).toBe(POSTS);
    expect((live.payload.components as { toJSON(): { type: number } }[]).map((c) => c.toJSON().type)).not.toContain(17);
    expect(shown(live.payload)).toContain('## Update');
    expect(String(fc.dms[0]?.payload.content)).toMatch(/Your Announcement "Update" was approved/);
  });

  it('keeps the text when a button line is wrong, and reopens the form filled in', async () => {
    const services = await setup();
    const fc = fakeClient();
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'notice' }, roles: [IDS.seniorRole], client: fc });
    await run(services, cmd.interaction);
    const id = (cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id;
    const form = fakeModal({ customId: id, fields: { ...FORM, buttons: 'Apply here' }, roles: [IDS.seniorRole], client: fc });
    await run(services, form.interaction);
    const r = form.replies.at(-1);
    expect(replyText(r)).toMatch(/no "\|"/);
    const reopen = customIds(r).find((c) => c.startsWith('post:reopen:'))!;
    const btn = fakeButton({ customId: reopen, roles: [IDS.seniorRole], client: fc });
    await run(services, btn.interaction);
    const again = JSON.stringify((btn.replies.at(-1) as { toJSON(): unknown }).toJSON());
    expect(again).toContain('Join us. @everyone welcome.');
    expect(fc.sent).toHaveLength(0);
  });

  it('needs an approval channel for people below the approvers', async () => {
    const services = await setup([], {}, false);
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'notice' }, channels: { channel: { id: POSTS } }, roles: [IDS.modRole] });
    await run(services, cmd.interaction);
    const id = (cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id;
    const form = fakeModal({ customId: id, fields: FORM, roles: [IDS.modRole], client: cmd });
    await run(services, form.interaction);
    expect(replyText(form.replies.at(-1))).toMatch(/no approval channel yet/);
  });

  it("isn't open to members without a tier", async () => {
    const services = await setup();
    const cmd = fakeInteraction({ commandName: 'post', strings: { kind: 'notice' } });
    await run(services, cmd.interaction);
    expect(replyText(cmd.replies.at(-1))).toMatch(/needs Trial Moderator/);
  });
});

describe('/ssu', () => {
  const now = Math.floor(Date.now() / 1000);
  const routes: Route[] = [
    [
      'GET',
      `datastores/v1/universes/${UNIVERSE}/standard-datastores/datastore/entries/entry`,
      (url) =>
        url.searchParams.get('entryKey') === 'HK1941_Events/list'
          ? json([{ id: '7', title: 'Defence of Wong Nai Chung Gap', detail: '', start: now - 600, host: 'Maj_Test' }])
          : json({ error: 'NOT_FOUND' }, 404),
    ],
    ['GET', 'memory-store/sorted-maps/HK1941_Servers/items', json({ memoryStoreSortedMapItems: [{ id: 'j1', value: { job: 'j1', n: 14, t: now } }] })],
  ];

  it("posts with the Join button, @here, the game's running event and live servers", async () => {
    const services = await setup(routes);
    const cmd = fakeInteraction({ commandName: 'ssu', roles: [IDS.seniorRole] });
    await run(services, cmd.interaction);
    expect(replyText(cmd.replies.at(-1))).toMatch(/Posted in <#600000000000000003>/);
    const p = cmd.sent[0]!;
    expect(p.channelId).toBe(SSUS);
    const s = shown(p.payload);
    expect(s).toContain('games/77901932829123');
    expect(s).toContain('Ping: @here');
    expect(s).toContain('- Defence of Wong Nai Chung Gap');
    expect(s).toContain('1 server live · 14 playing');
    expect(p.payload.allowedMentions).toEqual({ parse: ['everyone'] });
  });

  it('uses the event text given, and goes to approval for a Moderator', async () => {
    const services = await setup(routes);
    const cmd = fakeInteraction({ commandName: 'ssu', strings: { event: 'Night patrol', ping: 'none' }, roles: [IDS.modRole] });
    await run(services, cmd.interaction);
    expect(cmd.sent[0]!.channelId).toBe(APPROVAL);
    expect(shown(cmd.sent[0]!.payload)).toContain('- Night patrol');
    expect(shown(cmd.sent[0]!.payload)).not.toContain('Ping:');
  });
});

describe('/panel', () => {
  it('posts an info panel from the form (Administrators)', async () => {
    const services = await setup([], { TIER4_ROLE_IDS: '777777777777777777' });
    const cmd = fakeInteraction({ commandName: 'panel', sub: 'create', roles: ['777777777777777777'] });
    await run(services, cmd.interaction);
    const id = (cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id;
    expect(id).toMatch(/^panel:save:/);
    const form = fakeModal({
      customId: id,
      fields: { title: 'Community Guidebook', body: 'Everything you need.', buttons: 'Guidebook | https://example.com/guide', footer: '' },
      roles: ['777777777777777777'],
      client: cmd,
    });
    await run(services, form.interaction);
    expect(cmd.sent[0]!.channelId).toBe('666666666666666666'); // the channel it was run in
    expect(shown(cmd.sent[0]!.payload)).toContain('Community Guidebook');
    expect(shown(cmd.sent[0]!.payload)).toContain('https://example.com/guide');
    expect(replyText(form.replies.at(-1))).toMatch(/✅ Posted/);
  });

  it('is for Administrators only', async () => {
    const services = await setup();
    const cmd = fakeInteraction({ commandName: 'panel', sub: 'create', roles: [IDS.seniorRole] });
    await run(services, cmd.interaction);
    expect(replyText(cmd.replies.at(-1))).toMatch(/needs Administrator/);
  });
});

describe('/setup posts', () => {
  it('sets the approval channel and approver tier', async () => {
    const services = await setup([], { OWNER_DISCORD_IDS: IDS.staffUser }, false);
    await run(services, fakeInteraction({ commandName: 'setup', sub: 'approval-channel', channels: { channel: { id: APPROVAL } } }).interaction);
    await run(services, fakeInteraction({ commandName: 'setup', sub: 'post-approvers', integers: { tier: 4 } }).interaction);
    const s = await services.guilds.get(IDS.guild);
    expect(s.approvalChannelId).toBe(APPROVAL);
    expect(s.postApproverTier).toBe(4);
  });

  it("won't set approvers above your own tier", async () => {
    const services = await setup([], { TIER4_ROLE_IDS: '777777777777777777' }, false);
    const cmd = fakeInteraction({ commandName: 'setup', sub: 'post-approvers', integers: { tier: 5 }, roles: ['777777777777777777'] });
    await run(services, cmd.interaction);
    expect(replyText(cmd.replies.at(-1))).toMatch(/above your own tier/);
  });
});
