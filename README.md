# Hong Kong 1941 · Discord staff bot

A Discord bot for the staff of **Hong Kong 1941**, the Canada 1940s group's WW2 milsim on Roblox. It reads service records straight from the game's data and sends moderation actions to live servers. It uses Roblox Open Cloud, so it can do this without being in the game.

- **TypeScript + discord.js v14**, slash commands only (no privileged intents).
- **Read only** on player data. Profiles are session-locked by ProfileStore, so the bot never writes them. Every change goes through a small script in the game (`roblox/DiscordBridge.server.luau`), which uses the game's own systems.
- Staff tiers **0–5** are the same as HKAdmin's in-game tiers.

> Status: the framework is complete, it builds, and its tests pass against **mocked** Roblox and Discord APIs. It has not yet run against the real services. The steps under [Deploying](#deploying) are what's left.

---

## Commands

| Command | Tier | What it does |
|---|---|---|
| `/record [user] [member]` | 0 (others: 1) | Service record: points with breakdown, next rank and eligibility, time in service and in the field, trainings, combat stats, medals, tabs. Moderators also see the MP line. |
| `/medals [user] [member]` | 0 | Medals (with citations) and qualification tabs. |
| `/status [names]` | 0 | Live servers and player counts. With the bridge installed, it also shows uptime and objectives; staff can see player names. |
| `/event list` | 0 | The same event list as `;events` in game. |
| `/event schedule when title [detail]` | 2 | Posts an event to the in-game list. HKAdmin announces it 15 minutes before and when it starts. It also appears in every server's Events tab and calendar. |
| `/event cancel id` | 2 | Cancels an event. |
| `/link start / verify / status / remove` | 0 | Links your Discord account to your Roblox account. |
| `/link whois [member] [user]` | 1 | Looks up a link in either direction. |
| `/arrests [user] [count]` | 1 | Latest provost arrest log (`HK1941_MP/log`), or one player's arrests and any time left to serve. |
| `/eligible [rank] [refresh]` | 1 | Everyone in the army group who meets the points and trainings for their next rank. |
| `/kick user [reason]` | 2 | Kicks a player from whichever server they're in. |
| `/release user` | 2 | Releases a prisoner from the cells, or clears their sentence if they're offline. |
| `/points add\|remove user amount [reason]` | 2 | Adds or removes service points by hand. Moderators can move at most 50 at a time. |
| `/award tab user tab [remove]` | 2 | Gives or removes a qualification tab (`;certify`). |
| `/award medal user medal [citation] [revoke]` | 3 (VC/GC: 4) | Awards or revokes a medal (`;award`). |
| `/ban user duration [reason]` | 3 | Bans a player: `30m`, `12h`, `7d`, `2w` or `perm`. Senior Moderators are capped at 7 days. |
| `/unban user` | 4 | Lifts a ban and shows what it was. |
| `/announce message` | 4 | Shows an announcement on every live server (like `;gannounce`). |
| `/promote user rank [reason]` | 4 | Changes a soldier's army group rank. It shows their points standing and asks you to confirm first. |
| `/help` | 0 | The commands you can use, your tier and your link. |
| `/setup show` · `staff-role` · `audit-channel` · `verified-role` | 1 / 4 | This server's staff roles, audit channel and verified role. |

`user` accepts a Roblox username, `@name`, user ID or profile link. `member` takes a Discord member and uses their linked account.

**Actions in the game need a linked Roblox account.** The game filters staff text (announcements, reasons, citations, event titles) under that account, as Roblox requires, and logs the action as that person. Every staff action is also posted to the server's `/setup audit-channel` (and `AUDIT_CHANNEL_ID`, if set) and written to HKAdmin's own log, so `;logs` in game shows it.

### Tiers

These are the same numbers as `ServerStorage.HKAdminConfig`: **1** Trial Moderator, **2** Moderator, **3** Senior Moderator, **4** Administrator, **5** Owner. A member's tier is the highest of:

- their Discord roles: the ones this server mapped with `/setup staff-role`, and `TIER1_ROLE_IDS` … `TIER5_ROLE_IDS` from `.env`;
- `OWNER_DISCORD_IDS`;
- if `TIER_FROM_ROBLOX_RANK=true`, their linked account's army rank, exactly as in game (rank 5 → 1, 9 → 2, 11 → 3, 13 → 4) or owner rank (255) in group 668236881 → 5.

### Any server

The bot works in every server it's in, with no server ID in `.env`. Its commands are registered globally each time it starts. Each server sets itself up with `/setup`, and the settings are saved in `DATA_DIR/guilds.json`:

- `/setup staff-role role tier`: give a role a tier in that server (`None` removes it).
- `/setup audit-channel [channel]`: where that server's staff actions are posted. The bot posts a test message first.
- `/setup verified-role [role]`: the role given after `/link verify`.
- `/setup event-channel [channel]`: the server's event calendar and announcements (see [Events](#events)).
- `/setup event-ping [role]`: role pinged before each event starts.
- `/setup event-sync on`: turn event syncing on or off for that server (on by default).
- `/setup show`: the current settings.

`/setup` needs tier 4 (Administrator), and you can only give tiers **below your own** (owners can give any). Discord permissions don't count: a server admin who adds the bot can't make themselves game staff. The first person to set up a server needs tier 4 or 5 from `OWNER_DISCORD_IDS`, `TIER4/5_ROLE_IDS`, or the army rank of their linked Roblox account.

Account links are per person, not per server, so someone linked in one server is linked in all of them.

### Events

In-game events and Discord stay in step in every server, checked every minute (`EVENT_SYNC_SEC`):

- **Game to Discord:** every upcoming in-game event, however it was made (`/event schedule`, `;event add` or the Events tab), appears in each server's **Events** tab. When it's cancelled in game, or finishes (3 hours after the start, like HKAdmin), it's removed. The Discord copy is linked by the `· #1234` at the end of its location; leave that on.
- **Calendar channel:** with `/setup event-channel`, the bot keeps one calendar message there, listing every upcoming event in each reader's own time zone, with a **Join Hong Kong 1941** button. It also posts:
  - when a new event is added;
  - a reminder `EVENT_REMIND_MIN` (15) minutes before it starts, pinging the `/setup event-ping` role (make that role mentionable);
  - "starting now" when it starts.
  The first time, it only posts the calendar, not announcements for events that already existed.
- **Discord to game:** when staff create an event in a server's Events tab (location type **Somewhere else**), it's added to the game, with the same rule as `/event schedule`: tier 2+ and a linked Roblox account. A live game server must be running, and `BRIDGE_ACKS=true`. Voice and stage-channel events stay Discord-only.
- **Cancelling in Discord:** if staff who can cancel events (tier 2+, linked) cancel or delete a synced event, it's cancelled in game, and so in every server. If anyone else removes it, it's only hidden in that server. This needs the bot to have **View Audit Log** to see who did it.

The bot needs **Create Events** and **Manage Events** for the Events tab. In the calendar channel, it needs View Channel, Send Messages, Embed Links and Read Message History. Turn all of it off with `EVENT_SYNC=false`.

To change a command's tier, use `COMMAND_TIERS` (for example `announce:2,event.schedule:3`). The game checks again: `MIN_TIER` at the top of the bridge script is the final say, so lower it there too.

---

## How it works

```
Discord ──slash command──▶ bot ──Open Cloud──▶ Roblox
                            │   DataStores (read)   HK1941_Profiles u<id> (unwraps ProfileStore .Data)
                            │                       HK1941_Global "<area>/<key>" (bans, events, MP log, trainings…)
                            │   Groups              ranks (public API), roles and promotions (Open Cloud)
                            │   MessagingService ──▶ topic HK1941Discord ──▶ every live server
                            │                                                  DiscordBridge.server.luau
                            │                                                  ├─ MedalControl / ServiceControl / MPControl
                            │                                                  ├─ PlayerData (PD.Global, PD.Message)
                            │                                                  └─ HKAdmin Notify, HK1941Events
                            └◀── MemoryStore (read) ◀── ack "msg_<id>" + server heartbeats
```

- **Reading** uses DataStores v1 *Get Entry*. Profiles are `HK1941_Profiles` / `u<userId>`; the bot unwraps ProfileStore's `.Data` and fills missing fields from the template. Server-wide data is in `HK1941_Global` under `"<area>/<key>"`. For keys the game hasn't migrated yet, it falls back to the old per-system store.
- **Writing** goes through MessagingService. Exactly one server acts on each message: it claims the message ID in a MemoryStore sorted map, so only one claim can win. A server that has the target player online claims straight away; the others wait 4 seconds first. The claiming server writes the result back, and the bot shows it to staff. For offline players, the bridge queues the same `PD.Message` edits the game itself uses, so they apply on whichever server next loads that profile.
- **Live servers:** each server writes a heartbeat (players, uptime, objectives) every 30 seconds, and `/status` reads it. Without the bridge, `/status` falls back to the public server list (public servers only, counts only).
- **Promotions** change roles in group **409406376** through Open Cloud Groups.

The message format is documented at the top of `roblox/DiscordBridge.server.luau` and in `src/bridge/schema.ts`. A test checks that the two agree.

---

## Deploying

You need: Node.js 20 or newer (or Docker), a Discord server or servers where you can add bots, and edit access to the Hong Kong 1941 experience.

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application** (for example "HK1941 Staff").
2. On **General Information**, copy the **Application ID**. It goes in `DISCORD_CLIENT_ID`.
3. On **Bot**, click **Reset Token** and copy the token into `DISCORD_TOKEN`. Keep it secret. Leave all three *Privileged Gateway Intents* off; the bot doesn't need them.
4. On **Bot**, turn **Public Bot** off, so only you can add it to servers.
5. On **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands`. Then tick these bot permissions: **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **View Audit Log**, **Manage Roles**, **Create Events** and **Manage Events**. Open the generated URL to add the bot to a server; use the same URL for every other server. Or use this link with your Application ID in place of `APP_ID`: `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=17601044499584`.
6. After it starts, run `/setup` in each server (see [Any server](#any-server)). If you use a verified role, drag the bot's role **above** it in Server Settings → Roles.

### 2. Create the Roblox Open Cloud API key

Make a key just for the bot: <https://create.roblox.com/dashboard/credentials> → **API Keys** → **Create API Key**. Then:

| API system | Experience / group | Operations | Used by |
|---|---|---|---|
| **DataStore** (`universe-datastores`) | Hong Kong 1941 | **Read Entry** (`universe-datastores.objects:read`) | `/record`, `/medals`, `/arrests`, `/eligible`, `/event list`, `/unban` |
| **Messaging Service** (`universe-messaging-service`) | Hong Kong 1941 | **Publish** (`universe-messaging-service:publish`) | every action in the game |
| **Memory Store** (`memory-store.sorted-map`) | Hong Kong 1941 | **Read** | results of actions in the game, `/status` |
| **Groups** (`group`) | — | **Read** (`group:read`), and **Write** (`group:write`) for `/promote` | `/eligible`, `/promote` |

- **Accepted IP addresses:** add your bot host's public IP. `0.0.0.0/0` allows any IP; use it only while testing.
- **Expiration:** pick one and put a reminder in your calendar. When the key expires, the bot stops reading.
- **User key, not group key.** The game belongs to group 668236881, but `/promote` changes ranks in group 409406376. A group key only reaches its own group, so make the key on a user account. Best is a separate bot account that has a rank in 409406376 allowed to change ranks (it can only give ranks below its own), and a role in 668236881 allowed to edit group experiences.
- Don't give it DataStore *write*, *delete* or *list* permissions. The bot never needs them.
- Put the key in `HK_OPEN_CLOUD_KEY`. The bot never reads `ROBLOX_OPEN_CLOUD_API_KEY`, so a personal key on the same machine can't be picked up by mistake.

Without the Memory Store scope the bot still works, but set `BRIDGE_ACKS=false`. Staff will then see "sent" instead of what happened.

### 3. Install the bridge in the place

The bridge is in the repo but **not in the place yet**.

1. In Studio, open Hong Kong 1941 and add a **Script** called `DiscordBridge` to **ServerScriptService**.
2. Paste in `roblox/DiscordBridge.server.luau`.
3. Publish. Live servers pick it up as they start. It needs no HttpService and nothing new in the place: it uses PlayerData, HKAdminConfig, ServiceConfig, MedalConfig, HKAdmin's `Notify`, and the Medal/Service/MP/Capture control bindables that are already there.

It stays **off in Studio** so a playtest can't take real actions. To test it in Studio, give the script a boolean attribute `RunInStudio = true` and turn on *Game Settings → Security → Enable Studio Access to API Services*. Note that real actions then really happen.

If you change `BRIDGE_TOPIC`, `BRIDGE_ACK_MAP` or `SERVER_MAP` in `.env`, change the matching constants at the top of the script too.

### 4. Configure

```powershell
Copy-Item .env.example .env
```

Fill in `.env`. At minimum you need `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `HK_OPEN_CLOUD_KEY` and your own Discord user ID in `OWNER_DISCORD_IDS`, so you can run `/setup`. No server ID is needed. Every variable is explained in `.env.example`. The bot checks the whole file on start and lists every problem at once.

### 5a. Run on a Node host

```powershell
npm ci
```

```powershell
npm run build
```

```powershell
npm start
```

- The bot registers its slash commands globally each time it starts, so they appear in every server it's in. The first time, they can take a few minutes to show up. Set `REGISTER_COMMANDS=false` to stop this.
- `npm run deploy-commands -- --guild <server id>` registers a copy in one server only, instantly, for testing. Remove it afterwards with `npm run deploy-commands -- --clear --guild <server id>`, or every command shows twice there. `npm run deploy-commands -- --clear` removes the global ones.
- Keep the bot running with a process manager, for example `pm2 start dist/index.js --name hk1941-bot` or a systemd service with `WorkingDirectory` set to this folder.
- Account links are saved in `DATA_DIR/links.json` and server settings in `DATA_DIR/guilds.json`. **Back them up.**

### 5b. Run with Docker

```powershell
docker compose build
```

```powershell
docker compose up -d
```

Links and server settings are kept in the `bot-data` volume. Logs are JSON on stdout (`docker compose logs -f bot`).

### 6. Check it works

1. `/help` should list the commands and show your tier.
2. Run `/link start <your username>`, put the phrase in your Roblox About section, then run `/link verify`.
3. `/record` should show your own record. If it says *Roblox refused the request*, check the key's scopes, its IP allow-list and `ROBLOX_UNIVERSE_ID`.
4. With a live server running, `/status` should say *From the in-game bridge heartbeat*. Then try `/announce` (tier 4) or `/event schedule +1h Test`, and `/event cancel` it.

---

## Linking accounts

- **`blurb` (default):** `/link start <username>` gives a phrase such as `hk1941 jade lantern otter peak`. The member puts it in their Roblox profile's **About**, then runs `/link verify`. The bot reads the About text through Roblox's public users API. The phrase expires after `LINK_CODE_TTL_MIN` minutes and can be deleted once the accounts are linked. No passwords or OAuth are involved, and no third party.
- **`bloxlink` / `rover`:** if your server already uses one of these, set `LINK_PROVIDER` and its API key. `/link verify` then asks that service instead. *TODO: check both endpoints against their current docs before relying on them (`src/linking/providers.ts`).*
- Each Roblox account can be linked to one Discord account at a time. Staff can check links with `/link whois`.

---

## Development

```powershell
npm test
```

```powershell
npm run typecheck
```

```powershell
npm run dev
```

- Tests use a strict fake `fetch` (`tests/helpers/mockFetch.ts`): any request a test didn't expect fails it, so nothing reaches Roblox or Discord. Tests never read your environment.
- **Add a command:** create `src/commands/<name>.ts` that `export default defineCommand({...})`, then run `npm run deploy-commands`. The loader picks it up automatically; files starting with `_` are skipped.
- **Add an event:** create `src/events/<name>.ts` that `export default defineEvent({...})`.

Layout:

```
src/
  index.ts, deploy-commands.ts   entry points
  config.ts                      typed .env (zod)
  services.ts                    wires everything together
  loaders/                       command and event loaders
  permissions/                   tiers, Discord roles → tiers, army rank → tiers
  roblox/                        Open Cloud and web API clients (DataStores read-only, messaging, memory store, groups, users, servers)
  bridge/                        message format + publish / ack client
  game/                          profile shape, points formula, copies of ServiceConfig / MedalConfig
  linking/                       link store, blurb verification, Bloxlink / RoVer adapters
  discord/                       dispatcher (tier checks, error replies), embeds, audit log
  commands/, events/
roblox/DiscordBridge.server.luau the in-game half (install by hand, see above)
tests/
```

---

## What's left and known limits

**Before going live (the steps above):**
1. Create the Discord application, invite the bot and fill in `.env` (step 1, step 4).
2. Create the Open Cloud key with the scopes above (step 2).
3. Install and publish `DiscordBridge` in the place (step 3).
4. Register the commands and start the bot on a host (step 5).
5. Run the checks in step 6. The code has only been tested against mocks.

**Things to know:**
- **A live server must be running** for actions in the game. A ban, points change or event sent while no server is up is **not saved**, and the bot says so. *Possible follow-up:* let the bot write `HK1941_Bans/u<id>` directly (it's server-wide data, not a session-locked profile) for bans while nothing is running.
- **Game config copies:** `src/game/gameConfig.ts` copies the points weights, rank requirements, medals and tabs from `ServiceConfig` and `MedalConfig` (as of 2026-11-23). If those modules change, update this file too, or Discord will show different numbers from the game. *TODO: have the bridge publish them to `HK1941_Global` so the bot reads them live.*
- **`/eligible`** reads one profile per member of each rank on the points ladder (up to `ELIGIBLE_MAX_PROFILES`) and caches the result for `ELIGIBLE_CACHE_MIN`. Large groups take a while, and they use DataStore read quota.
- **Promotions in game** show after the player rejoins; that's how Roblox caches group ranks.
- **Clock:** servers ignore messages older than `BRIDGE_MESSAGE_TTL_SEC` (+60 s slack), so keep the host's clock synced (NTP).
- **Open Cloud DataStores v1** is used for reads. If Roblox retires v1, switch `src/roblox/datastores.ts` to the v2 entries endpoint; nothing else needs to change.
- **One bot process:** links are a JSON file. If you ever run more than one copy, implement `LinkStore` on a database.

### Security notes

- The bot holds two secrets: the Discord token and the Open Cloud key. They live only in `.env` (git-ignored) and are redacted from logs. The key is only ever sent to `apis.roblox.com`.
- Only someone holding an Open Cloud key with messaging publish on this experience, or a game server, can send to the bridge topic. The bridge still checks tiers, ban caps and message expiry, and handles each message ID only once.
- Staff text is filtered by Roblox before players see it. If filtering fails, the text isn't shown.
