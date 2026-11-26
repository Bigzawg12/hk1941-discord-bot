--[[
DiscordBridge (HK1941, 2026-11-23): carries out staff actions sent from the Discord bot.

Installed in the Hong Kong place as ServerScriptService.DiscordBridge (2026-11-24). If you change this file, paste it in again.
It only uses what is already in the place:
  ServerStorage.PlayerData (PD.Global and PD.Message), ServerStorage.HKAdminConfig,
  ReplicatedStorage.ServiceConfig / MedalConfig, ReplicatedStorage.HKAdmin.Notify,
  and the bindables ServerStorage.MedalControl / ServiceControl / MPControl / CaptureControl.

How it works
  * The bot publishes JSON to MessagingService topic TOPIC through Open Cloud. Every live server receives it.
  * Exactly one server acts on each message: it "claims" the message id in MemoryStore sorted map ACK_MAP
    (UpdateAsync, so only one claim can win). A server that has the target player claims at once; the others
    wait OFFLINE_DELAY seconds first, so the player's own server goes first when they're online.
  * The claiming server writes the result back under the same key ("msg_<id>"); the bot reads it to tell staff
    what happened. Announcements are carried out by every server, each adding itself to the count.
  * Every 30 s each server writes a heartbeat (players, uptime, objectives) to sorted map SERVER_MAP for /status.
  * Actions are added to HKAdmin's log (HK1941_AdminLog/recent), so ;logs in game shows them.
  * Account linking: a player types /verify in chat; the server shows them (only them) a one-off 8-letter code
    and keeps it in sorted map VERIFY_MAP for VERIFY_TTL seconds as key "v_<CODE>" = { u, n, d, t }.
    They type the code into /verify in Discord, and the bot reads it (read only) to link the accounts.

Message (bot -> game), JSON, at most 1 kB:
  { v = 1, id = "<12 chars>", ts = <unix>, exp = <unix>, act = "<action>",
    by = { d = "<discord id>", r = <roblox user id>, n = "<roblox username>", t = <tier 0-5> },
    tgt = <roblox user id, for player actions>, a = { ...action arguments... } }
  act / a:
    announce      { text }                      every server, HKAdmin Notify "announce"
    kick          { reason }                    the server the player is on
    ban           { secs (0 = permanent), reason }   HK1941_Global "HK1941_Bans/u<id>" (same record as ;ban) + kick
    unban         { }                           removes that record
    release       { }                           MPControl "release", or PD.Message mp/release when not here
    points        { n, reason }                 ServiceControl "adjust", or PD.Message service/adjust when not here
    award         { medal, cite, remove }       MedalControl "award" / "revoke" (it handles offline players itself)
    certify       { tab, remove }               MedalControl "certify" / "uncertify"
    event_add     { start, title, detail }      HK1941_Global "HK1941_Events/list", then HK1941Events "changed"
    event_cancel  { eventId }
Ack (game -> bot), MemoryStore ACK_MAP key "msg_<id>", JSON:
  { s = "claimed" | "done", ok = bool, m = "result text", job = JobId, t = unix, n = servers, eventId = "1234" }

Trust and safety
  * Only holders of an Open Cloud key with MessagingService publish on this experience (and game servers) can
    publish to the topic. The bot also checks tiers before sending; MIN_TIER below is checked again here.
  * Staff text (announcements, reasons, citations, event titles) is filtered with TextService under the staff
    member's linked Roblox account (by.r) before any player sees it. If filtering fails, the text isn't shown.
  * Messages past their expiry are ignored, and each id is handled once.
  * In Studio it stays off (so a playtest can't take real actions) unless you give this script the boolean
    attribute RunInStudio = true.
]]

local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local SS = game:GetService("ServerStorage")
local MS = game:GetService("MessagingService")
local MSS = game:GetService("MemoryStoreService")
local HttpService = game:GetService("HttpService")
local TextService = game:GetService("TextService")
local RunService = game:GetService("RunService")

-- ---------- settings (keep in step with the bot's .env) ----------
local VERSION = 1                       -- bot: BRIDGE_VERSION in src/bridge/schema.ts
local TOPIC = "HK1941Discord"           -- bot: BRIDGE_TOPIC
local ACK_MAP = "HK1941_DiscordBridge"  -- bot: BRIDGE_ACK_MAP
local SERVER_MAP = "HK1941_Servers"     -- bot: SERVER_MAP
local ACK_TTL = 900                     -- seconds an ack is kept
local HEARTBEAT_EVERY = 30
local HEARTBEAT_TTL = 120
local OFFLINE_DELAY = 4                 -- seconds a server without the target waits before claiming
local CLOCK_SLACK = 60                  -- tolerated clock difference between the bot host and Roblox
local CONTROL_TIMEOUT = 10              -- seconds to wait for a bindable to answer
local VERIFY_MAP = "HK1941_Verify"      -- bot: VERIFY_MAP
local VERIFY_TTL = 600                  -- seconds a /verify code works
local VERIFY_SHOW = 180                 -- seconds the code stays on screen

if RunService:IsStudio() and not script:GetAttribute("RunInStudio") then
	print("[DiscordBridge] off in Studio (set attribute RunInStudio = true on this script to test)")
	return
end

local PD = require(SS:WaitForChild("PlayerData"))
local CFG = require(SS:WaitForChild("HKAdminConfig"))
local SC = require(RS:WaitForChild("ServiceConfig"))
local MC = require(RS:WaitForChild("MedalConfig"))

-- Lowest staff tier for each action. Mirrors HKAdmin (;gannounce 4, ;kick 2, ;ban 3, ;unban 4, ;release 2,
-- ;addpoints ServiceConfig.AdjustTier, ;award MedalConfig.MinAwardTier, ;certify MinCertTier, ;event 2).
-- This is the final say: lowering a command with the bot's COMMAND_TIERS also needs the matching entry here.
local MIN_TIER = {
	announce = 4,
	kick = 2,
	ban = 3,
	unban = 4,
	release = 2,
	points = SC.AdjustTier or 2,
	award = MC.MinAwardTier or 3,
	certify = MC.MinCertTier or 2,
	event_add = 2,
	event_cancel = 2,
}
local TARGETED = { kick = true, ban = true, unban = true, release = true, points = true, award = true, certify = true }
local TIER_NAMES = CFG.Tiers or {}

local ackMap = MSS:GetSortedMap(ACK_MAP)
local serverMap = MSS:GetSortedMap(SERVER_MAP)

-- ---------- helpers ----------
local function ackKey(id) return "msg_" .. id end

local function jsonDecode(s)
	if type(s) ~= "string" then return nil end
	local ok, v = pcall(HttpService.JSONDecode, HttpService, s)
	return ok and v or nil
end

local owned = {}   -- message ids this server claimed

-- true = this server won the claim, false = another server has it, nil = MemoryStore unavailable
local function claim(id, waitFirst)
	if waitFirst and waitFirst > 0 then task.wait(waitFirst) end
	for attempt = 1, 3 do
		local won = false
		local ok, err = pcall(function()
			ackMap:UpdateAsync(ackKey(id), function(old)
				if old ~= nil then
					won = false
					return nil   -- someone else has it: cancel the update
				end
				won = true
				return HttpService:JSONEncode({ s = "claimed", job = game.JobId, t = os.time() })
			end, ACK_TTL)
		end)
		if ok then
			if won then owned[id] = true end
			return won
		end
		warn("[DiscordBridge] claim " .. id .. " failed (" .. attempt .. "): " .. tostring(err))
		task.wait(attempt)
	end
	return nil
end

local function finish(id, ok, text, extra)
	local v = { s = "done", ok = ok == true, m = string.sub(tostring(text or ""), 1, 400), job = game.JobId, t = os.time() }
	if extra then for k, x in pairs(extra) do v[k] = x end end
	local done, err = pcall(function() ackMap:SetAsync(ackKey(id), HttpService:JSONEncode(v), ACK_TTL) end)
	if not done then warn("[DiscordBridge] ack " .. id .. " failed: " .. tostring(err)) end
end

-- broadcast actions: every server adds itself; returns the updated ack (or nil)
local function countServer(id, players)
	local result
	pcall(function()
		result = ackMap:UpdateAsync(ackKey(id), function(old)
			local v = jsonDecode(old) or { s = "done", ok = true, n = 0, p = 0 }
			v.s = "done"; v.ok = true
			v.n = (v.n or 0) + 1
			v.p = (v.p or 0) + players
			v.job = v.job or game.JobId
			v.t = os.time()
			v.m = "Seen by " .. v.p .. " player" .. (v.p == 1 and "" or "s") .. "."
			return HttpService:JSONEncode(v)
		end, ACK_TTL)
	end)
	return jsonDecode(result)
end

-- a stand-in for the Player the bindables expect as "caller": Name, DisplayName, UserId and the
-- AdminLevel attribute (checked in Studio: a table with methods passes through BindableFunction:Invoke intact)
local function staffProxy(by, tier)
	local name = (tostring(by.n):gsub("[^%w_]", "")):sub(1, 20)
	if name == "" then name = "Discord" end
	local proxy = { Name = name, DisplayName = name .. " (Discord)", UserId = by.r, Team = nil }
	function proxy:GetAttribute(key)
		if key == "AdminLevel" then return tier end
		return nil
	end
	function proxy:IsA() return false end
	function proxy:GetRankInGroup() return 0 end
	function proxy:GetRoleInGroup() return "Guest" end
	return proxy
end

-- staff text, filtered for everyone under the staff member's Roblox account; nil if the filter failed
local function filtered(text, fromUserId)
	text = (tostring(text or ""):gsub("%c", " ")):sub(1, 400)
	if text:match("^%s*$") then return "" end
	local ok, res = pcall(function()
		return TextService:FilterStringAsync(text, fromUserId):GetNonChatStringForBroadcastAsync()
	end)
	if ok and type(res) == "string" then return res end
	warn("[DiscordBridge] text filter failed: " .. tostring(res))
	return nil
end

-- call ServerStorage.<name> (a BindableFunction made by another server script) with a time limit
local function control(name, action, caller, args)
	local ctl = SS:FindFirstChild(name)
	if not ctl or not ctl:IsA("BindableFunction") then return false, "That system (" .. name .. ") isn't running on this server." end
	local done, okCall, okRes, msg = false, false, nil, nil
	task.spawn(function()
		okCall, okRes, msg = pcall(ctl.Invoke, ctl, action, caller, args)
		done = true
	end)
	local t0 = os.clock()
	while not done and os.clock() - t0 < CONTROL_TIMEOUT do task.wait(0.05) end
	if not done then return false, name .. " didn't answer in time." end
	if not okCall then
		warn("[DiscordBridge] " .. name .. " " .. action .. ": " .. tostring(okRes))
		return false, "The game hit an error doing that."
	end
	return okRes == true, tostring(msg or "")
end

local function adminLog(caller, text)
	local entry = { t = os.time(), by = caller.Name .. " (Discord)", text = text }
	task.spawn(function()
		pcall(PD.Global.Update, "HK1941_AdminLog", "recent", function(old)
			old = type(old) == "table" and old or {}
			table.insert(old, 1, entry)
			while #old > 200 do table.remove(old) end
			return old
		end)
	end)
	print("[DiscordBridge] " .. entry.by .. ": " .. text)
end

local function notifyRemote()
	local f = RS:FindFirstChild("HKAdmin")
	local n = f and f:FindFirstChild("Notify")
	return (n and n:IsA("RemoteEvent")) and n or nil
end

local function tierName(t) return TIER_NAMES[t] or ("tier " .. t) end

local function pruneEvents(list)
	local out = {}
	for _, e in ipairs(type(list) == "table" and list or {}) do
		if type(e) == "table" and type(e.start) == "number" and e.start + 3 * 3600 > os.time() then table.insert(out, e) end
	end
	return out
end

-- claim, then carry on only if this server should act (when MemoryStore is down, act only if the player is here)
local function shouldAct(id, here)
	local c = claim(id, here and 0 or OFFLINE_DELAY)
	if c == true then return true end
	if c == nil and here then return true end
	return false
end

local function refuse(id, text)
	if claim(id) then finish(id, false, text) end
end

-- ---------- actions ----------
local H = {}

H.announce = function(m, caller)
	local text = filtered(m.a.text, caller.UserId)
	if not text or text == "" then return refuse(m.id, "The text filter failed, so nothing was shown.") end
	local notify = notifyRemote()
	if not notify then return end   -- HKAdmin isn't running here: don't count this server
	notify:FireAllClients("announce", text .. "  — " .. caller.DisplayName)
	local v = countServer(m.id, #Players:GetPlayers())
	if v and v.n == 1 then adminLog(caller, "announce (all servers): " .. text) end
end

H.kick = function(m, caller, tier)
	local p = Players:GetPlayerByUserId(m.tgt)
	if not p then return end   -- only the server they're on answers
	if not shouldAct(m.id, true) then return end
	if (p:GetAttribute("AdminLevel") or 0) >= tier then
		return finish(m.id, false, "Can't kick " .. p.Name .. ": they are at or above your level.")
	end
	local reason = filtered(m.a.reason, caller.UserId)
	if not reason or reason == "" then reason = "No reason given" end
	p:Kick("Kicked by " .. caller.DisplayName .. ": " .. reason)
	adminLog(caller, "kick " .. p.Name .. " (" .. reason .. ")")
	finish(m.id, true, "Kicked " .. p.Name .. ".")
end

H.ban = function(m, caller, tier)
	local uid = m.tgt
	local secs = tonumber(m.a.secs)
	if not secs or secs < 0 then return refuse(m.id, "Bad ban length.") end
	secs = math.floor(secs)
	local cap = (CFG.BanCaps or {})[tier]
	if cap and (secs == 0 or secs > cap) then
		return refuse(m.id, tierName(tier) .. "s can ban for up to " .. math.floor(cap / 86400 * 10 + 0.5) / 10 .. " days.")
	end
	local p = Players:GetPlayerByUserId(uid)
	if p and (p:GetAttribute("AdminLevel") or 0) >= tier then
		return refuse(m.id, "Can't ban " .. p.Name .. ": they are at or above your level.")
	end
	local reason = filtered(m.a.reason, caller.UserId)
	if not reason or reason == "" then reason = "No reason given" end
	local untilT = secs == 0 and 0 or os.time() + secs
	local left = secs == 0 and "permanently" or ("until " .. os.date("!%d %b %Y %H:%M UTC", untilT))
	local act = shouldAct(m.id, p ~= nil)
	if act then
		PD.Global.Update("HK1941_Bans", "u" .. uid, function()
			return { untilT = untilT, reason = reason, by = caller.Name .. " (Discord)", at = os.time() }
		end)
	end
	-- kick wherever they are, even if another server wrote the record
	if p then p:Kick("You are banned from Hong Kong 1941 " .. left .. ". Reason: " .. reason .. " (by " .. caller.Name .. ")") end
	if act then
		adminLog(caller, "ban " .. uid .. " " .. left .. " (" .. reason .. ")")
		finish(m.id, true, "Banned " .. (p and p.Name or ("user " .. uid)) .. " " .. left .. ".")
	end
end

H.unban = function(m, caller)
	if not claim(m.id) then return end
	PD.Global.Remove("HK1941_Bans", "u" .. m.tgt)
	adminLog(caller, "unban " .. m.tgt)
	finish(m.id, true, "Unbanned user " .. m.tgt .. ".")
end

H.release = function(m, caller)
	local p = Players:GetPlayerByUserId(m.tgt)
	if not shouldAct(m.id, p ~= nil) then return end
	if p and SS:FindFirstChild("MPControl") then
		local ok, res = control("MPControl", "release", caller, { p.Name })
		if ok then adminLog(caller, "release " .. p.Name) end
		return finish(m.id, ok, res)
	end
	-- not on this server: clear the sentence in their profile (applied by whichever server holds it, or on next join)
	PD.Message(m.tgt, { kind = "mp", action = "release", why = "released by " .. caller.DisplayName })
	adminLog(caller, "release " .. m.tgt .. " (not on this server)")
	finish(m.id, true, "Sentence cleared. If they're in game they'll be let out; otherwise they start free next time.")
end

H.points = function(m, caller, tier)
	local n = math.floor(tonumber(m.a.n) or 0)
	if n == 0 then return refuse(m.id, "The amount can't be 0.") end
	if tier < 3 and math.abs(n) > (SC.AdjustCap or 50) then
		return refuse(m.id, "Moderators can change points by up to " .. (SC.AdjustCap or 50) .. " at a time.")
	end
	local p = Players:GetPlayerByUserId(m.tgt)
	if not shouldAct(m.id, p ~= nil) then return end
	local reason = tostring(m.a.reason or "")
	if p and SS:FindFirstChild("ServiceControl") then
		local args = { p.Name, tostring(n) }
		for w in reason:gmatch("%S+") do table.insert(args, w) end
		local ok, res = control("ServiceControl", "adjust", caller, args)
		if ok then adminLog(caller, "points " .. (n > 0 and "+" or "") .. n .. " " .. p.Name) end
		return finish(m.id, ok, res)
	end
	local clean = reason ~= "" and filtered(reason, caller.UserId) or ""
	PD.Message(m.tgt, { kind = "service", action = "adjust", n = n, by = caller.DisplayName, reason = clean or "", t = os.time() })
	adminLog(caller, "points " .. (n > 0 and "+" or "") .. n .. " user " .. m.tgt)
	finish(m.id, true, string.format("%s %d points %s user %d. It shows on their record once their profile picks it up.",
		n > 0 and "Added" or "Removed", math.abs(n), n > 0 and "to" or "from", m.tgt))
end

H.award = function(m, caller)
	local here = Players:GetPlayerByUserId(m.tgt) ~= nil
	if not shouldAct(m.id, here) then return end
	local args = { m.tgt, string.upper(tostring(m.a.medal or "")) }   -- MedalServer resolves a user id, online or not
	if not m.a.remove then for w in tostring(m.a.cite or ""):gmatch("%S+") do table.insert(args, w) end end
	local action = m.a.remove and "revoke" or "award"
	local ok, res = control("MedalControl", action, caller, args)
	if ok then adminLog(caller, action .. " " .. args[2] .. " " .. m.tgt) end
	finish(m.id, ok, res)
end

H.certify = function(m, caller)
	local here = Players:GetPlayerByUserId(m.tgt) ~= nil
	if not shouldAct(m.id, here) then return end
	local tab = string.upper(tostring(m.a.tab or ""))
	local action = m.a.remove and "uncertify" or "certify"
	local ok, res = control("MedalControl", action, caller, { m.tgt, tab })
	if ok then adminLog(caller, action .. " " .. tab .. " " .. m.tgt) end
	finish(m.id, ok, res)
end

H.event_add = function(m, caller)
	if not claim(m.id) then return end
	local start = math.floor(tonumber(m.a.start) or 0)
	if start < os.time() - 60 then return finish(m.id, false, "That time has already passed.") end
	local title = filtered(m.a.title, caller.UserId)
	local detail = filtered(m.a.detail, caller.UserId)
	if not title or title == "" then return finish(m.id, false, "The event needs a title (or the text filter failed).") end
	title, detail = title:sub(1, 60), (detail or ""):sub(1, 120)
	local id
	PD.Global.Update("HK1941_Events", "list", function(old)
		local l = pruneEvents(old)
		local used = {}
		for _, e in ipairs(l) do used[tostring(e.id)] = true end
		repeat id = tostring(math.random(1000, 9999)) until not used[id]
		table.insert(l, { id = id, title = title, detail = detail, start = start, host = caller.DisplayName, unit = "" })
		return l
	end)
	pcall(function() MS:PublishAsync("HK1941Events", "changed") end)   -- every HKAdmin reloads its list
	local when = os.date("!%a %d %b %H:%M UTC", start)
	pcall(function() MS:PublishAsync("HK1941Announce", "New event: " .. title .. " — " .. when) end)
	adminLog(caller, "event add #" .. id .. " " .. title .. " " .. when)
	finish(m.id, true, "Event #" .. id .. " posted for " .. when .. ".", { eventId = id })
end

H.event_cancel = function(m, caller)
	if not claim(m.id) then return end
	local id = tostring(m.a.eventId or "")
	local found
	PD.Global.Update("HK1941_Events", "list", function(old)
		local l = pruneEvents(old)
		found = nil
		for i = #l, 1, -1 do if tostring(l[i].id) == id then found = table.remove(l, i) end end
		return l
	end)
	if not found then return finish(m.id, false, "No event #" .. id .. ".") end
	pcall(function() MS:PublishAsync("HK1941Events", "changed") end)
	pcall(function() MS:PublishAsync("HK1941Announce", "Cancelled: " .. tostring(found.title)) end)
	adminLog(caller, "event cancel #" .. id)
	finish(m.id, true, "Cancelled #" .. id .. " (" .. tostring(found.title) .. ").")
end

-- ---------- receiving ----------
local function decode(raw)
	if type(raw) ~= "string" or #raw > 1100 then return nil end
	local m = jsonDecode(raw)
	if type(m) ~= "table" or m.v ~= VERSION then return nil end
	if type(m.id) ~= "string" or #m.id < 6 or #m.id > 40 or m.id:find("[^%w_%-]") then return nil end
	if type(m.act) ~= "string" or not H[m.act] then return nil end
	if type(m.exp) ~= "number" or m.exp + CLOCK_SLACK < os.time() then return nil end
	local by = m.by
	if type(by) ~= "table" or type(by.r) ~= "number" or by.r <= 0 or type(by.n) ~= "string" or type(by.t) ~= "number" then return nil end
	if m.tgt ~= nil and (type(m.tgt) ~= "number" or m.tgt <= 0) then return nil end
	if TARGETED[m.act] and not m.tgt then return nil end
	if type(m.a) ~= "table" then m.a = {} end
	return m
end

local seen = {}   -- id -> time first seen
local function onMessage(packet)
	local m = decode(packet and packet.Data)
	if not m then return end
	if seen[m.id] then return end
	seen[m.id] = os.time()
	local tier = math.clamp(math.floor(m.by.t), 0, 5)
	local caller = staffProxy(m.by, tier)
	task.spawn(function()
		local need = MIN_TIER[m.act] or 5
		if tier < need then
			return refuse(m.id, "That needs " .. tierName(need) .. " or above.")
		end
		local ok, err = pcall(H[m.act], m, caller, tier)
		if not ok then
			warn("[DiscordBridge] " .. m.act .. " " .. m.id .. " failed: " .. tostring(err))
			if owned[m.id] then finish(m.id, false, "The game hit an error doing that. Check the server log.") end
		end
	end)
end

task.spawn(function()
	for attempt = 1, 6 do
		local ok, err = pcall(function() return MS:SubscribeAsync(TOPIC, onMessage) end)
		if ok then
			print("[DiscordBridge] listening on " .. TOPIC)
			return
		end
		warn("[DiscordBridge] subscribe failed (" .. attempt .. "): " .. tostring(err))
		task.wait(attempt * 5)
	end
end)

-- forget old ids
task.spawn(function()
	while true do
		task.wait(300)
		local cutoff = os.time() - ACK_TTL
		for id, t in pairs(seen) do if t < cutoff then seen[id] = nil; owned[id] = nil end end
	end
end)

-- ---------- account linking: /verify in chat ----------
-- Consonants only: no words can come out, and no digits for the chat filter to hide. 20^8 codes.
local CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ"
local verifyMap = MSS:GetSortedMap(VERIFY_MAP)
local lastVerify = {} -- userId -> os.clock(), one code per 10 seconds per player
local rng = Random.new()

local function newCode()
	local t = {}
	for i = 1, 8 do
		local k = rng:NextInteger(1, #CODE_LETTERS)
		t[i] = CODE_LETTERS:sub(k, k)
	end
	return table.concat(t)
end

-- built on the server, so it needs no LocalScript; only this player sees it
local function showVerify(player, title, body)
	local pg = player:FindFirstChildOfClass("PlayerGui")
	if not pg then return end
	local old = pg:FindFirstChild("DiscordVerify")
	if old then old:Destroy() end
	local gui = Instance.new("ScreenGui")
	gui.Name = "DiscordVerify"
	gui.ResetOnSpawn = false
	gui.DisplayOrder = 50
	local frame = Instance.new("Frame")
	frame.AnchorPoint = Vector2.new(0.5, 0)
	frame.Position = UDim2.new(0.5, 0, 0, 72)
	frame.Size = UDim2.fromOffset(440, 150)
	frame.BackgroundColor3 = Color3.fromRGB(33, 31, 26)
	frame.BackgroundTransparency = 0.08
	frame.Parent = gui
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 8)
	corner.Parent = frame
	local stroke = Instance.new("UIStroke")
	stroke.Color = Color3.fromRGB(181, 164, 103)
	stroke.Thickness = 1
	stroke.Parent = frame
	local pad = Instance.new("UIPadding")
	for _, side in ipairs({ "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" }) do pad[side] = UDim.new(0, 12) end
	pad.Parent = frame
	local head = Instance.new("TextLabel")
	head.BackgroundTransparency = 1
	head.Size = UDim2.new(1, 0, 0, 22)
	head.Font = Enum.Font.GothamBold
	head.TextSize = 16
	head.TextColor3 = Color3.fromRGB(236, 232, 219)
	head.TextXAlignment = Enum.TextXAlignment.Left
	head.Text = title
	head.Parent = frame
	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Position = UDim2.fromOffset(0, 26)
	text.Size = UDim2.new(1, 0, 1, -26)
	text.Font = Enum.Font.Gotham
	text.TextSize = 14
	text.RichText = true
	text.TextWrapped = true
	text.TextColor3 = Color3.fromRGB(214, 209, 196)
	text.TextXAlignment = Enum.TextXAlignment.Left
	text.TextYAlignment = Enum.TextYAlignment.Top
	text.Text = body
	text.Parent = frame
	gui.Parent = pg
	task.delay(VERIFY_SHOW, function()
		if gui.Parent then gui:Destroy() end
	end)
end

local function onVerify(player)
	local now = os.clock()
	if lastVerify[player.UserId] and now - lastVerify[player.UserId] < 10 then return end
	lastVerify[player.UserId] = now
	local code = newCode()
	local value = HttpService:JSONEncode({ u = player.UserId, n = player.Name, d = player.DisplayName, t = os.time() })
	local ok, err = pcall(function() verifyMap:SetAsync("v_" .. code, value, VERIFY_TTL) end)
	if not ok then
		warn("[DiscordBridge] verify code not saved: " .. tostring(err))
		showVerify(player, "Discord verification", "Couldn't make a code right now. Type <b>/verify</b> again in a minute.")
		return
	end
	showVerify(
		player,
		"Your Discord verification code",
		string.format(
			'<font size="28"><b>%s %s</b></font>\nIn Discord, press <b>Enter code</b> on /verify and type it in. Works for %d minutes.\n<font color="#e08a8a">Never give this code to anyone.</font>',
			code:sub(1, 4), code:sub(5, 8), VERIFY_TTL // 60
		)
	)
end

do
	local TCS = game:GetService("TextChatService")
	local cmd = Instance.new("TextChatCommand")
	cmd.Name = "DiscordVerifyCommand"
	cmd.PrimaryAlias = "/verify"
	cmd.SecondaryAlias = "/discord"
	cmd.Parent = TCS:FindFirstChild("TextChatCommands") or TCS
	cmd.Triggered:Connect(function(source)
		local player = source and Players:GetPlayerByUserId(source.UserId)
		if player then task.spawn(onVerify, player) end
	end)
	Players.PlayerRemoving:Connect(function(p) lastVerify[p.UserId] = nil end)
end

-- ---------- heartbeat for /status ----------
local started = os.time()
local function heartbeat()
	local list = Players:GetPlayers()
	local names = {}
	for i, p in ipairs(list) do if i <= 40 then table.insert(names, p.Name) end end
	local cap
	if SS:FindFirstChild("CaptureControl") then
		local ok, text = control("CaptureControl", "status", nil, {})
		if ok and text ~= "" then cap = text:sub(1, 600) end
	end
	local v = {
		job = game.JobId, place = game.PlaceId, n = #list, max = Players.MaxPlayers, names = names,
		up = os.time() - started, priv = game.PrivateServerId ~= "", cap = cap, t = os.time(), v = VERSION,
	}
	local ok, err = pcall(function() serverMap:SetAsync("srv_" .. game.JobId, HttpService:JSONEncode(v), HEARTBEAT_TTL) end)
	if not ok then warn("[DiscordBridge] heartbeat failed: " .. tostring(err)) end
end
task.spawn(function()
	while true do
		heartbeat()
		task.wait(HEARTBEAT_EVERY)
	end
end)
game:BindToClose(function()
	pcall(function() serverMap:RemoveAsync("srv_" .. game.JobId) end)
end)
