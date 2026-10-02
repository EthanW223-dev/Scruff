-- Stands in for UE4SS for Telos's tests: the globals TelosBridge's main.lua uses (LoopAsync,
-- ExecuteInGameThread, FindAllOf, ForEachUObject, StaticFindObject, RegisterHook, UEHelpers)
-- over a tiny fake world, then runs the game loop until the test writes relay/stop.
-- lua5.4 harness.lua <path to installed main.lua> <max seconds>

local main, maxSeconds = arg[1], tonumber(arg[2] or "20")
local relay = main:gsub("[/\\]Scripts[/\\]main%.lua$", "") .. "/relay/"

-- ---------------------------------------------------------------- fake UObjects

local function fname(s) return { ToString = function() return s end } end

local Class = {}
Class.__index = Class
function Class:GetFName() return fname(self._name) end
function Class:IsValid() return true end
function Class:GetSuperStruct() return self._super end
function Class:ForEachProperty(cb)
  for _, p in ipairs(self._props) do
    local prop = { GetFName = function() return fname(p[1]) end, GetClass = function() return { GetFName = function() return fname(p[2]) end } end }
    if cb(prop) then return end
  end
end
local function class(name, super, props) return setmetatable({ _name = name, _super = super, _props = props or {} }, Class) end

local Obj = {}
Obj.__index = function(self, k)
  local m = rawget(Obj, k)
  if m ~= nil then return m end
  return rawget(self, "_p")[k]
end
Obj.__newindex = function(self, k, v) rawget(self, "_p")[k] = v end
function Obj:IsValid() return not rawget(self, "_dead") end
function Obj:GetFName() return fname(rawget(self, "_name")) end
function Obj:GetClass() return rawget(self, "_class") end
function Obj:GetFullName() return rawget(self, "_class")._name .. " /Game/Maps/Level.Level:PersistentLevel." .. rawget(self, "_name") end

local all = {}
local function object(name, cls, props)
  local o = setmetatable({ _name = name, _class = cls, _p = props or {} }, Obj)
  all[#all + 1] = o
  return o
end

local Actor = class("Actor", nil, { { "bHidden", "BoolProperty" } })
local Character = class("Character", Actor, { { "Health", "FloatProperty" }, { "PlayerName", "StrProperty" } })
local location = { X = 100, Y = 200, Z = 50 }
local pawn = object("BP_Hero_C_0", Character, {
  Health = 100,
  bHidden = false,
  PlayerName = { ToString = function() return "Hero" end },
  jumps = 0,
  K2_GetActorLocation = function() return { X = location.X, Y = location.Y, Z = location.Z } end,
  K2_SetActorLocation = function(_, loc, sweep, hit, teleport)
    assert(sweep == false and type(hit) == "table" and teleport == true)
    location = { X = loc.X, Y = loc.Y, Z = loc.Z }
  end,
  Jump = function(self) self.jumps = self.jumps + 1 return true end,
})
object("BP_Zombie_C_1", Character, { Health = 50 })
object("BP_Zombie_C_2", Character, { Health = 50 })
object("Default__Character", Character, {})
local pc = object("PlayerController_0", class("PlayerController"), { Pawn = pawn, IsLocalController = function() return true end })
local ws = object("WorldSettings_0", class("WorldSettings"), { TimeDilation = 1, GlobalGravityZ = -980, bGlobalGravitySet = false })
local consoled = {}
local ksl = object("Default__KismetSystemLibrary", class("KismetSystemLibrary"), {
  ExecuteConsoleCommand = function(_, ctx, cmd, player)
    assert(ctx == pc and player == pc)
    consoled[#consoled + 1] = cmd
  end,
})

-- ---------------------------------------------------------------- UE4SS globals

local loops, gameThread, hooks = {}, {}, {}
function LoopAsync(ms, cb) loops[#loops + 1] = cb end
function ExecuteInGameThread(fn) gameThread[#gameThread + 1] = fn end
function FindAllOf(name)
  local out = {}
  for _, o in ipairs(all) do
    if rawget(o, "_class")._name == name and not rawget(o, "_name"):find("^Default__") then out[#out + 1] = o end
  end
  return #out > 0 and out or nil
end
function FindFirstOf(name)
  local l = FindAllOf(name)
  return l and l[1] or nil
end
function ForEachUObject(cb)
  for i, o in ipairs(all) do
    if cb(o, 0, i) then return end
  end
end
function StaticFindObject(path)
  if path == "/Script/Engine.Default__KismetSystemLibrary" then return ksl end
  return nil
end
function RegisterHook(name, cb) hooks[name] = cb end
package.preload["UEHelpers"] = function() return { GetPlayerController = function() return pc end } end

-- ---------------------------------------------------------------- run

dofile(main)

local function exists(f)
  local h = io.open(relay .. f, "rb")
  if h then h:close() return true end
  return false
end

local started = os.time()
while os.time() - started < maxSeconds and not exists("stop") do
  for _, cb in ipairs(loops) do cb() end
  local now = gameThread
  gameThread = {}
  for _, fn in ipairs(now) do fn() end
  if exists("fire-hook") then
    os.remove(relay .. "fire-hook")
    hooks["/Script/Engine.PlayerController:ClientRestart"]()
  end
  -- What the test checks from outside: the world as the tools left it.
  local f = io.open(relay .. "world.txt", "wb")
  f:write(string.format("health=%s jumps=%d x=%s dilation=%s gravity=%s set=%s console=%s",
    tostring(pawn.Health), pawn.jumps, tostring(location.X), tostring(ws.TimeDilation), tostring(ws.GlobalGravityZ),
    tostring(ws.bGlobalGravitySet), table.concat(consoled, "|")))
  f:close()
  os.execute("sleep 0.03")
end
