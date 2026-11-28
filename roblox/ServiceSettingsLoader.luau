-- Reference copy of the block added to ServerScriptService.ServiceServer (after `local MC = require(...)`),
-- 2026-11-27. It lets the dashboard's Promotions → Points & ranks tab change ServiceConfig live.
-- Needs `PD` (ServerStorage.PlayerData) and `C` (ReplicatedStorage.ServiceConfig) already required above it.

-- ---------- live settings from the Discord bot's dashboard ----------
-- HK1941_Global "HK1941_Config/service" = { v = 1, points = { capture = 4, ... }, ranks = { ["2"] = { points = 120, trainings = 4 }, ... } }.
-- Applied over ServiceConfig in place, so DiscordBridge (same module table) sees the same numbers. Read at start, every
-- 5 minutes, and when the bot publishes "HK1941Config". Anything missing or invalid keeps the value from ServiceConfig.
local DEFAULT_POINTS = table.clone(C.Points)
local DEFAULT_RANKS = {}
for r, req in pairs(C.Ranks) do DEFAULT_RANKS[r] = table.clone(req) end
local function whole(v, lo, hi)
	if type(v) == "number" and v == v and v >= lo and v <= hi then return math.floor(v) end
	return nil
end
local function applySettings(s)
	local pts = table.clone(DEFAULT_POINTS)
	local ranks = {}
	for r, req in pairs(DEFAULT_RANKS) do ranks[r] = table.clone(req) end
	if type(s) == "table" then
		if type(s.points) == "table" then
			for k in pairs(DEFAULT_POINTS) do
				local v = whole(s.points[k], k == "aiKillsPer" and 1 or 0, 100000)
				if v then pts[k] = v end
			end
		end
		if type(s.ranks) == "table" then
			for k, req in pairs(s.ranks) do
				local r = tonumber(k)
				if r and ranks[r] and type(req) == "table" then
					ranks[r].points = whole(req.points, 0, 10000000) or ranks[r].points
					ranks[r].trainings = whole(req.trainings, 0, 100000) or ranks[r].trainings
				end
			end
		end
	end
	for k, v in pairs(pts) do C.Points[k] = v end
	for r, req in pairs(ranks) do C.Ranks[r] = req end
end
local function loadSettings()
	local ok, s = pcall(PD.Global.Get, "HK1941_Config", "service")
	if ok then applySettings(s) end
end
task.spawn(function()
	loadSettings()
	pcall(function()
		game:GetService("MessagingService"):SubscribeAsync("HK1941Config", function()
			task.delay(math.random() * 3, loadSettings)
		end)
	end)
	while true do
		task.wait(300)
		loadSettings()
	end
end)
