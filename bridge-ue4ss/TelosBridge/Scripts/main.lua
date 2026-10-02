-- TelosBridge: Telos's bridge for Unreal Engine games, as a UE4SS Lua mod.
--
-- UE4SS (github.com/UE4SS-RE/RE-UE4SS, installed by the player) runs this script inside the game.
-- It talks to Telos through two small files in its own relay/ folder: Telos writes request.json,
-- the mod answers in response.json, and alive.json says it's running (plus its tools and recent
-- game events). Nothing leaves this computer, and the mod does nothing unless Telos asks.
-- Single-player games only.

local VERSION = "1.0.0"

-- ------------------------------------------------------------------ where am I

local function modDir()
  -- (Not through pcall: then level 1 would be pcall itself, not this script.)
  local info = debug and debug.getinfo and debug.getinfo(1, "S")
  local src = info and info.source or ""
  if src:sub(1, 1) == "@" then
    local dir = src:sub(2):gsub("[/\\][Ss]cripts[/\\][^/\\]*$", "")
    if dir ~= src:sub(2) then return dir end
  end
  for _, d in ipairs({ "ue4ss/Mods/TelosBridge", "Mods/TelosBridge" }) do
    local f = io.open(d .. "/relay/.keep", "rb")
    if f then
      f:close()
      return d
    end
  end
  return "Mods/TelosBridge"
end

local RELAY = modDir() .. "/relay/"

-- ------------------------------------------------------------------ JSON

local json = {}

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then return false end
    n = n + 1
  end
  return n > 0 and n == #t
end

function json.encode(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.type and math.type(v) == "integer" then return tostring(v) end
    if v % 1 == 0 and math.abs(v) < 1e15 then return string.format("%d", v) end
    return string.format("%.10g", v)
  end
  if t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return escapes[c] or string.format("\\u%04x", c:byte()) end) .. '"'
  end
  if t == "table" then
    local out = {}
    if isArray(v) then
      for i = 1, #v do out[i] = json.encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    for k, val in pairs(v) do out[#out + 1] = json.encode(tostring(k)) .. ":" .. json.encode(val) end
    table.sort(out)
    return "{" .. table.concat(out, ",") .. "}"
  end
  return json.encode(tostring(v))
end

function json.decode(s)
  local i = 1
  local function ws() i = s:find("[^ \t\r\n]", i) or #s + 1 end
  local value
  local function str()
    local out, j = {}, i + 1
    while true do
      local c = s:sub(j, j)
      if c == "" then error("unterminated string") end
      if c == '"' then break end
      if c == "\\" then
        local e = s:sub(j + 1, j + 1)
        local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
        if e == "u" then
          local code = tonumber(s:sub(j + 2, j + 5), 16)
          out[#out + 1] = utf8 and utf8.char(code) or string.char(code % 256)
          j = j + 6
        else
          out[#out + 1] = map[e] or e
          j = j + 2
        end
      else
        out[#out + 1] = c
        j = j + 1
      end
    end
    i = j + 1
    return table.concat(out)
  end
  function value()
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      local obj = {}
      i = i + 1
      ws()
      if s:sub(i, i) == "}" then i = i + 1 return obj end
      while true do
        ws()
        local k = str()
        ws()
        i = i + 1 -- :
        obj[k] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "}" then return obj end
      end
    elseif c == "[" then
      local arr = {}
      i = i + 1
      ws()
      if s:sub(i, i) == "]" then i = i + 1 return arr end
      while true do
        arr[#arr + 1] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "]" then return arr end
      end
    elseif c == '"' then
      return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4 return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5 return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4 return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not num or num == "" then error("bad JSON at " .. i) end
      i = i + #num
      return tonumber(num)
    end
  end
  return value()
end

-- ------------------------------------------------------------------ files

local function readFile(name)
  local f = io.open(RELAY .. name, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

-- Write then rename, so Telos never reads half a file.
local function writeFile(name, text)
  local tmp = RELAY .. name .. ".tmp"
  local f = io.open(tmp, "wb")
  if not f then return end
  f:write(text)
  f:close()
  os.remove(RELAY .. name)
  os.rename(tmp, RELAY .. name)
end

-- ------------------------------------------------------------------ objects

local known, idOf, nextId = {}, {}, 1

local function valid(obj)
  if obj == nil then return false end
  local ok, yes = pcall(function() return obj:IsValid() end)
  return ok and yes
end

local function nameOf(obj)
  local ok, n = pcall(function() return obj:GetFName():ToString() end)
  return ok and n or "?"
end

local function classOf(obj)
  local ok, n = pcall(function() return obj:GetClass():GetFName():ToString() end)
  return ok and n or "?"
end

local function fullName(obj)
  local ok, n = pcall(function() return obj:GetFullName() end)
  return ok and n or nil
end

local function remember(obj)
  local full = fullName(obj) or tostring(obj)
  local id = idOf[full]
  if id and valid(known[id]) then return id end
  id = nextId
  nextId = nextId + 1
  known[id] = obj
  idOf[full] = id
  return id
end

local function byId(id)
  local obj = known[tonumber(id) or -1]
  if not valid(obj) then error("No object with id " .. tostring(id) .. ". It may be gone (a new level?); use find again.") end
  return obj
end

local function describe(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "number" or t == "boolean" or t == "string" or v == nil then return v end
  if t ~= "table" and t ~= "userdata" then return tostring(v) end
  -- A game object: its name and an id to use it with.
  local full = fullName(v)
  if full then
    if full == "" or not valid(v) then return nil end
    return { object = full, id = remember(v) }
  end
  -- FString, FName, FText.
  local okS, s = pcall(function() return v:ToString() end)
  if okS and type(s) == "string" then return s end
  -- Vectors, rotators, colors.
  for _, keys in ipairs({ { "X", "Y", "Z" }, { "Pitch", "Yaw", "Roll" }, { "R", "G", "B", "A" }, { "X", "Y" } }) do
    local ok, out = pcall(function()
      local o = {}
      for _, k in ipairs(keys) do
        local x = v[k]
        if type(x) ~= "number" then error("no") end
        o[k] = x
      end
      return o
    end)
    if ok then return out end
  end
  -- Arrays.
  local okN, n = pcall(function() return v:GetArrayNum() end)
  if okN and type(n) == "number" then
    local items = {}
    if depth < 2 then
      pcall(function()
        v:ForEach(function(_, elem)
          if #items < 20 then items[#items + 1] = describe(elem:get(), depth + 1) end
        end)
      end)
    end
    return { count = n, items = items }
  end
  if t == "table" then
    if depth > 2 then return "{...}" end
    local out = {}
    for k, x in pairs(v) do
      if type(x) ~= "function" then out[k] = describe(x, depth + 1) end
    end
    return out
  end
  return tostring(v)
end

-- JSON from Telos to what Unreal takes: [x,y,z] becomes {X=,Y=,Z=}.
local function toUnreal(v)
  if type(v) == "table" and #v == 3 and type(v[1]) == "number" then return { X = v[1], Y = v[2], Z = v[3] } end
  return v
end

local function helpers()
  local ok, UEHelpers = pcall(require, "UEHelpers")
  return ok and UEHelpers or nil
end

local function playerController()
  local h = helpers()
  if h then
    local ok, pc = pcall(function() return h:GetPlayerController() end)
    if not ok then ok, pc = pcall(function() return h.GetPlayerController() end) end
    if ok and valid(pc) then return pc end
  end
  local pcs = FindAllOf("PlayerController") or {}
  for _, pc in ipairs(pcs) do
    local ok, local_ = pcall(function() return pc:IsLocalController() end)
    if valid(pc) and (not ok or local_) then return pc end
  end
  error("No player yet: start or load a game first.")
end

local function playerPawn()
  local pc = playerController()
  local pawn = pc.Pawn
  if not valid(pawn) then error("The player has no character right now (a menu or loading screen?).") end
  return pawn, pc
end

-- ------------------------------------------------------------------ tools

local TOOLS = {}
local order = {}

local function tool(name, description, props, required, run)
  local schema = { type = "object", properties = props }
  if required and #required > 0 then schema.required = required end
  TOOLS[name] = run
  order[#order + 1] = { name = name, description = description, input_schema = schema }
end

local function S(t, d) return { type = t, description = d } end

tool("player", "Start here: the player's character and controller (ids for the other tools), its class and where it is.", {}, nil, function()
  local pawn, pc = playerPawn()
  local loc = describe(pawn:K2_GetActorLocation())
  return { pawn = { id = remember(pawn), name = nameOf(pawn), class = classOf(pawn) }, controller = { id = remember(pc), class = classOf(pc) }, location = loc }
end)

tool("find", "Find objects by part of their name and/or class (e.g. class 'Character', 'Pickup', 'Enemy'). Returns ids.", {
  name = S("string", "Part of the object's name, any case"),
  class = S("string", "A class name (exact is fastest, e.g. 'PlayerState'), or part of one"),
  limit = S("integer", "Default 25"),
}, nil, function(a)
  local limit = math.min(tonumber(a.limit) or 25, 100)
  local wantName = a.name and a.name:lower() or nil
  local wantClass = a.class and a.class:lower() or nil
  local out = {}
  local function consider(obj)
    if #out >= limit or not valid(obj) then return #out >= limit end
    local n = nameOf(obj)
    if n:sub(1, 9) == "Default__" then return false end
    if wantName and not n:lower():find(wantName, 1, true) then return false end
    local c = classOf(obj)
    if wantClass and not c:lower():find(wantClass, 1, true) then return false end
    out[#out + 1] = { id = remember(obj), name = n, class = c }
    return #out >= limit
  end
  local exact = a.class and FindAllOf(a.class)
  if exact then
    for _, obj in ipairs(exact) do if consider(obj) then break end end
  elseif wantName or wantClass then
    ForEachUObject(function(obj) return consider(obj) end)
  else
    error("Give a name or a class to look for.")
  end
  if #out == 0 then return "Nothing matches. Try part of the name, or a class like Character, Actor, Pawn." end
  return out
end)

tool("inspect", "An object's properties (its own and inherited) with their types and current values. filter narrows by name.", {
  id = S("integer", "Object id from find or player"),
  filter = S("string", "Only properties whose name contains this"),
}, { "id" }, function(a)
  local obj = byId(a.id)
  local want = a.filter and a.filter:lower() or nil
  local props = {}
  local cls = obj:GetClass()
  local guard = 0
  while valid(cls) and guard < 20 and #props < 150 do
    guard = guard + 1
    pcall(function()
      cls:ForEachProperty(function(p)
        local okN, n = pcall(function() return p:GetFName():ToString() end)
        if okN and (not want or n:lower():find(want, 1, true)) then
          local okT, kind = pcall(function() return p:GetClass():GetFName():ToString() end)
          local okV, v = pcall(function() return obj[n] end)
          -- (Not "okV and describe(v) or ...": a false property would read as unreadable.)
          local value = "(unreadable)"
          if okV then value = describe(v, 1) end
          props[#props + 1] = { name = n, type = okT and kind or "?", value = value }
        end
        return #props >= 150
      end)
    end)
    local okS, super = pcall(function() return cls:GetSuperStruct() end)
    cls = okS and super or nil
  end
  return { name = nameOf(obj), class = classOf(obj), properties = props }
end)

tool("get", "Read one property, e.g. Health, MaxWalkSpeed, CharacterMovement (gives an id to look inside).", {
  id = S("integer", "Object id"), property = S("string", "Property name"),
}, { "id", "property" }, function(a)
  local obj = byId(a.id)
  return { property = a.property, value = describe(obj[a.property]) }
end)

tool("set", "Change a property: numbers, true/false, text, or [x,y,z] for vectors. Returns before and after.", {
  id = S("integer", "Object id"), property = S("string", "Property name"), value = { description = "The new value" },
}, { "id", "property", "value" }, function(a)
  local obj = byId(a.id)
  local before = describe(obj[a.property])
  obj[a.property] = toUnreal(a.value)
  return { property = a.property, before = before, after = describe(obj[a.property]) }
end)

tool("call", "Call one of the object's functions (UFunctions), e.g. Jump on the character, with arguments in order.", {
  id = S("integer", "Object id"), ["function"] = S("string", "Function name"), args = { type = "array", items = {}, description = "Arguments in order" },
}, { "id", "function" }, function(a)
  local obj = byId(a.id)
  local f = obj[a["function"]]
  if not f then error(nameOf(obj) .. " has no function " .. tostring(a["function"]) .. ".") end
  local args = {}
  for i, v in ipairs(a.args or {}) do args[i] = toUnreal(v) end
  return { result = describe(f(obj, table.unpack(args))) }
end)

tool("teleport", "Move the player (or an object by id) to x, y, z (Unreal units: 100 = one meter).", {
  id = S("integer", "Object id (default the player)"), x = S("number", ""), y = S("number", ""), z = S("number", ""),
}, { "x", "y", "z" }, function(a)
  local target = a.id and byId(a.id) or playerPawn()
  target:K2_SetActorLocation({ X = a.x, Y = a.y, Z = a.z }, false, {}, true)
  return { location = describe(target:K2_GetActorLocation()) }
end)

tool("world", "Game speed (time_dilation: 1 normal, 0.5 slow motion, 2 fast) and gravity (gravity_z, normally -980). Give nothing to read them.", {
  time_dilation = S("number", "Game speed"), gravity_z = S("number", "Gravity, negative pulls down"),
}, nil, function(a)
  local ws = FindFirstOf("WorldSettings")
  if not valid(ws) then error("No world yet: start or load a game first.") end
  if a.time_dilation then ws.TimeDilation = math.max(0.0001, a.time_dilation) end
  if a.gravity_z then
    ws.bGlobalGravitySet = true
    ws.GlobalGravityZ = a.gravity_z
  end
  return { time_dilation = ws.TimeDilation, gravity_z = ws.GlobalGravityZ }
end)

tool("console", "Run an Unreal console command (e.g. 'slomo 0.5', 'fov 100'; cheat commands like 'god' or 'fly' only work if the game kept them).", {
  command = S("string", "The console command"),
}, { "command" }, function(a)
  local pc = playerController()
  local ksl = StaticFindObject("/Script/Engine.Default__KismetSystemLibrary")
  if not valid(ksl) then error("This game's console can't be reached.") end
  ksl:ExecuteConsoleCommand(pc, a.command, pc)
  return { ran = a.command }
end)

-- ------------------------------------------------------------------ events

local events, eventN = {}, 0

local function event(text)
  eventN = eventN + 1
  events[#events + 1] = { n = eventN, text = text }
  if #events > 20 then table.remove(events, 1) end
end

pcall(function()
  RegisterHook("/Script/Engine.PlayerController:ClientRestart", function()
    event("Player spawned (new level or respawn)")
  end)
end)

-- ------------------------------------------------------------------ the relay

local lastKey = nil
local ticks = 0
local pending = false

local function run(req)
  local reply = { key = req.key, id = req.id }
  local fn = TOOLS[req.tool]
  if not fn then
    reply.ok = false
    reply.error = "No tool " .. tostring(req.tool)
    return reply
  end
  local ok, result = pcall(fn, req.input or {})
  if ok then
    reply.ok = true
    reply.content = result
  else
    reply.ok = false
    reply.error = tostring(result):gsub("^.-:%d+: ", "")
  end
  return reply
end

local function tick()
  pending = false
  ticks = ticks + 1
  local text = readFile("request.json")
  if text then
    local ok, req = pcall(json.decode, text)
    if ok and type(req) == "table" and req.key and req.key ~= lastKey then
      lastKey = req.key
      writeFile("response.json", json.encode(run(req)))
    end
  end
  if ticks % 10 == 1 then
    writeFile("alive.json", json.encode({ version = VERSION, tick = ticks, tools = order, events = events }))
  end
end

-- A request left over from before this game started is not a new one.
do
  local text = readFile("request.json")
  local ok, req = pcall(json.decode, text or "")
  if ok and type(req) == "table" then lastKey = req.key end
end

-- File reading happens on a timer; anything touching the game runs on its own thread.
LoopAsync(100, function()
  if not pending then
    pending = true
    ExecuteInGameThread(tick)
  end
  return false
end)

print("[TelosBridge] " .. VERSION .. " running; relay at " .. RELAY .. "\n")
