// Telos Unreal bridge: pattern scanner, GObjects/GNames walkers, UE reflection helpers.
// Every pointer resolved from a pattern is VALIDATED before use; every dereference of
// game memory goes through UE::CanRead (VirtualQuery). mingw has no __try/__except,
// so there is no exception-based probing anywhere here: validation rejects bad
// patterns instead of crashing on them.
#include "ue.h"

#include <windows.h>
#include <psapi.h>

#include <algorithm>
#include <cctype>
#include <cstring>

#pragma comment(lib, "psapi.lib")  // MSVC only; mingw links -lpsapi via the Makefile

namespace UE {

// ---------------------------------------------------------------- CanRead ----

bool CanRead(const void* p, size_t n) {
  if (!p || n == 0) return false;
  MEMORY_BASIC_INFORMATION mi{};
  if (!VirtualQuery(p, &mi, sizeof(mi))) return false;
  if (mi.State != MEM_COMMIT) return false;
  if (mi.Protect & (PAGE_GUARD | PAGE_NOACCESS)) return false;
  constexpr DWORD kReadable = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                              PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
                              PAGE_EXECUTE_WRITECOPY;
  if (!(mi.Protect & kReadable)) return false;
  auto start = reinterpret_cast<uintptr_t>(p);
  auto base = reinterpret_cast<uintptr_t>(mi.BaseAddress);
  return start >= base && n <= mi.RegionSize && start + n <= base + mi.RegionSize &&
         start + n >= start;
}

static bool CanReadStr(const char* p, size_t maxLen) {
  if (!CanRead(p, 1)) return false;
  for (size_t i = 0; i < maxLen; i++) {
    if (!CanRead(p + i, 1)) return false;
    if (p[i] == '\0') return i > 0;
  }
  return false;  // unterminated within maxLen
}

static bool LooksPrintableAscii(const char* p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = static_cast<unsigned char>(p[i]);
    if (c == '\0') return true;
    if (c < 0x20 || c > 0x7E) return false;
  }
  return true;
}

// ------------------------------------------------------------ pattern scan ----

static int MatchByte(const char*& pat, uint8*& bytes) {
  while (*pat == ' ') pat++;
  if (!*pat) return 0;
  if (*pat == '?') {
    pat += (pat[0] == '?' && pat[1] == '?') ? 2 : 1;
    *bytes++ = 0;
    return 2;  // wildcard
  }
  char tmp[3] = {pat[0], pat[1], 0};
  pat += 2;
  *bytes++ = static_cast<uint8>(strtoul(tmp, nullptr, 16));
  return 1;  // exact
}

static uint8* ScanRegion(uint8* base, size_t size, const char* pattern) {
  char patCopy[512];
  strncpy(patCopy, pattern, sizeof(patCopy) - 1);
  patCopy[sizeof(patCopy) - 1] = 0;
  uint8 bytes[256];
  int mask[256];
  const char* p = patCopy;
  uint8* b = bytes;
  int len = 0;
  while (*p && len < 256) {
    int m = MatchByte(p, b);
    if (!m) break;
    mask[len++] = m;
  }
  if (!len) return nullptr;
  for (size_t i = 0; i + (size_t)len <= size; i++) {
    bool ok = true;
    for (int j = 0; j < len; j++) {
      if (mask[j] == 1 && base[i + j] != bytes[j]) { ok = false; break; }
    }
    if (ok) return base + i;
  }
  return nullptr;
}

// RIP-relative (x64): instruction at `at` reads [rip + disp32]; the pointer lives at
// at + insnLen + disp32.
static void* ResolveRip(uint8* at, int insnLen) {
  if (!CanRead(at, (size_t)insnLen)) return nullptr;
  int32 disp;
  memcpy(&disp, at + insnLen - 4, 4);
  uint8* target = at + insnLen + disp;
  if (!CanRead(target, sizeof(void*))) return nullptr;
  void* ptr;
  memcpy(&ptr, target, sizeof(ptr));
  return ptr;
}

static void* ScanModule(const char* pattern, int insnLen) {
  HMODULE mod = GetModuleHandleA(nullptr);
  MODULEINFO mi{};
  if (!GetModuleInformation(GetCurrentProcess(), mod, &mi, sizeof(mi))) return nullptr;
  auto* base = static_cast<uint8*>(mi.lpBaseOfDll);
  // Scan executable sections only (patterns live in code).
  auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
  if (!CanRead(dos, sizeof(*dos)) || dos->e_magic != IMAGE_DOS_SIGNATURE) return nullptr;
  auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
  if (!CanRead(nt, sizeof(*nt))) return nullptr;
  auto* sec = IMAGE_FIRST_SECTION(nt);
  for (int i = 0; i < nt->FileHeader.NumberOfSections; i++, sec++) {
    if (!(sec->Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
    uint8* sbase = base + sec->VirtualAddress;
    size_t ssize = sec->Misc.VirtualSize;
    if (!CanRead(sbase, 16)) continue;
    for (uint8* hit = ScanRegion(sbase, ssize, pattern); hit;
         hit = ScanRegion(hit + 1, ssize - (hit + 1 - sbase), pattern)) {
      if (void* ptr = ResolveRip(hit, insnLen)) return ptr;
    }
  }
  return nullptr;
}

// ---------------------------------------------------------------- GObjects ----

static bool LooksLikeFUObjectArray(FUObjectArray* arr) {
  if (!arr || !CanRead(arr, sizeof(FUObjectArray))) return false;
  FUObjectArray c;
  memcpy(&c, arr, sizeof(c));
  if (c.ObjObjects.NumElements <= 0 || c.ObjObjects.NumElements > 8'000'000) return false;
  if (!c.ObjObjects.Objects || !CanRead(c.ObjObjects.Objects, sizeof(FUObjectItem)))
    return false;
  // Spot-check a few entries: each live object must have a vtable inside the game module.
  HMODULE mod = GetModuleHandleA(nullptr);
  MODULEINFO mi{};
  GetModuleInformation(GetCurrentProcess(), mod, &mi, sizeof(mi));
  auto* mbase = static_cast<uint8*>(mi.lpBaseOfDll);
  int checked = 0;
  for (int32 i = 0; i < c.ObjObjects.NumElements && checked < 8; i++) {
    FUObjectItem item;
    memcpy(&item, &c.ObjObjects.Objects[i], sizeof(item));
    if (!item.Object) continue;
    if (!CanRead(item.Object, sizeof(UObject))) return false;
    UObject o;
    memcpy(&o, item.Object, sizeof(o));
    auto* vt = static_cast<uint8*>(o.VTable);
    if (vt < mbase || vt >= mbase + mi.SizeOfImage) return false;
    checked++;
  }
  return checked > 0;
}

FUObjectArray* GObjects() {
  // Well-known public GObjects signatures (UE 4.25-5.x). The int is the instruction
  // length for the RIP-relative resolve. VERIFY PER GAME: a pattern that resolves but
  // fails LooksLikeFUObjectArray is skipped, never trusted.
  static const struct { const char* pat; int len; } kPatterns[] = {
      {"48 8B 0D ? ? ? ? 48 85 C9 74 ?", 7},              // 4.25-4.27 common
      {"48 8B 05 ? ? ? ? 48 85 C0 75 ?", 7},              // 4.2x variant
      {"48 8D 0D ? ? ? ? E8 ? ? ? ? C6 05 ? ? ? ? ?", 7},  // 5.x variant
  };
  static FUObjectArray* cached = nullptr;
  if (cached && LooksLikeFUObjectArray(cached)) return cached;
  for (auto& kp : kPatterns) {
    auto* p = static_cast<FUObjectArray*>(ScanModule(kp.pat, kp.len));
    if (p && LooksLikeFUObjectArray(p)) {
      cached = p;
      return cached;
    }
  }
  cached = nullptr;
  return nullptr;
}

// ------------------------------------------------------------------ GNames ----

// UE4: TNameEntryArray. Entry 0 must be the string "None".
struct FNameEntry4 {
  int32 Index;
  FNameEntry4* HashNext;
  union {
    char AnsiName[1024];
    wchar_t WideName[1024];
  };
};
struct TNameEntryArray {
  enum { NumElementsPerChunk = 16384 };
  int32 NumElements;
  int32 NumChunks;
  FNameEntry4** Chunks[128];
};

// UE5: FNamePool. Entry ids pack (block << 16) | byteOffset; entries are 2-byte
// aligned with a 2-byte header (bIsWide:1, Len:15). Best-effort: validated, and the
// README flags UE5 name resolution for per-game verification.
struct FNameEntryHeader5 {
  uint16 bIsWide : 1;
  uint16 Len : 15;
};
struct FNamePool5 {
  uint8* Blocks[8192];
};

static std::string WideToUtf8(const wchar_t* w, size_t len) {
  std::string out;
  for (size_t i = 0; i < len && w[i]; i++) {
    wchar_t c = w[i];
    if (c < 0x80) {
      out += static_cast<char>(c);
    } else if (c < 0x800) {
      out += static_cast<char>(0xC0 | (c >> 6));
      out += static_cast<char>(0x80 | (c & 0x3F));
    } else {
      out += static_cast<char>(0xE0 | (c >> 12));
      out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (c & 0x3F));
    }
  }
  return out;
}

static std::string FNameEntry4ToString(FNameEntry4* e) {
  if (!e || !CanRead(e, 64)) return "";
  FNameEntry4 c;
  memcpy(&c, e, sizeof(c));
  // Heuristic: wide names are rare; try ANSI first.
  if (LooksPrintableAscii(c.AnsiName, 64) && CanReadStr(c.AnsiName, 1024))
    return std::string(c.AnsiName);
  if (CanRead(c.WideName, 8) && c.WideName[0] >= 0x20 && c.WideName[0] < 0x7F) {
    wchar_t buf[1024];
    size_t n = 0;
    while (n < 1023 && CanRead(&c.WideName[n], sizeof(wchar_t)) && c.WideName[n]) {
      buf[n] = c.WideName[n];
      n++;
    }
    buf[n] = 0;
    return WideToUtf8(buf, n);
  }
  return "";
}

static std::string FNameEntry5ToString(uint8* entry) {
  if (!entry || !CanRead(entry, sizeof(FNameEntryHeader5) + 2)) return "";
  FNameEntryHeader5 h;
  memcpy(&h, entry, sizeof(h));
  if (h.Len == 0 || h.Len > 1024) return "";
  if (!h.bIsWide) {
    const char* s = reinterpret_cast<const char*>(entry + 2);
    if (!CanRead(s, h.Len + 1) || !LooksPrintableAscii(s, h.Len)) return "";
    return std::string(s, h.Len);
  }
  const wchar_t* w = reinterpret_cast<const wchar_t*>(entry + 2);
  if (!CanRead(w, (h.Len + 1) * sizeof(wchar_t))) return "";
  return WideToUtf8(w, h.Len);
}

static void* g_names = nullptr;
static bool g_namesUe5 = false;

static bool ValidateNames4(TNameEntryArray* names) {
  if (!names || !CanRead(names, 16)) return false;
  TNameEntryArray c;
  memcpy(&c, names, 16);
  if (c.NumElements <= 0 || c.NumElements > 8'000'000) return false;
  if (c.NumChunks <= 0 || c.NumChunks > 128) return false;
  if (!CanRead(&names->Chunks[0], sizeof(void*))) return false;
  FNameEntry4* chunk0;
  memcpy(&chunk0, &names->Chunks[0], sizeof(chunk0));
  if (!chunk0 || !CanRead(chunk0, sizeof(FNameEntry4))) return false;
  // Entry 0 of every UE4 name table is "None".
  return FNameEntry4ToString(chunk0) == "None";
}

static bool ValidateNames5(FNamePool5* pool) {
  if (!pool || !CanRead(pool, 16)) return false;
  FNamePool5 c;
  memcpy(&c, pool, sizeof(c.Blocks[0]) * 4);
  if (!c.Blocks[0] || !CanRead(c.Blocks[0], 64)) return false;
  // Entry id 0 ("None") lives at the start of block 0.
  return FNameEntry5ToString(c.Blocks[0]) == "None";
}

void* GNames() {
  if (g_names) {
    if (!g_namesUe5 && ValidateNames4(static_cast<TNameEntryArray*>(g_names))) return g_names;
    if (g_namesUe5 && ValidateNames5(static_cast<FNamePool5*>(g_names))) return g_names;
    g_names = nullptr;
  }
  static const struct { const char* pat; int len; bool ue5; } kPatterns[] = {
      {"48 8B 05 ? ? ? ? 48 85 C0 75 ?", 7, false},              // UE4 FName::GetNames-ish
      {"48 8D 0D ? ? ? ? E8 ? ? ? ? C6 05 ? ? ? ? ?", 7, true},  // UE5 name pool-ish
  };
  for (auto& kp : kPatterns) {
    void* p = ScanModule(kp.pat, kp.len);
    if (!p) continue;
    bool ok = kp.ue5 ? ValidateNames5(static_cast<FNamePool5*>(p))
                     : ValidateNames4(static_cast<TNameEntryArray*>(p));
    if (ok) {
      g_names = p;
      g_namesUe5 = kp.ue5;
      return g_names;
    }
  }
  return nullptr;
}

bool GNamesIsUe5() {
  GNames();
  return g_namesUe5;
}

std::string FName::ToString() const {
  if (ComparisonIndex < 0) return "";
  void* names = GNames();
  if (!names) return "";
  std::string base;
  if (!g_namesUe5) {
    auto* arr = static_cast<TNameEntryArray*>(names);
    int32 chunk = ComparisonIndex / TNameEntryArray::NumElementsPerChunk;
    int32 within = ComparisonIndex % TNameEntryArray::NumElementsPerChunk;
    if (chunk < 0 || chunk >= 128 || !CanRead(&arr->Chunks[chunk], sizeof(void*)))
      return "";
    FNameEntry4* chunkPtr;
    memcpy(&chunkPtr, &arr->Chunks[chunk], sizeof(chunkPtr));
    if (!chunkPtr) return "";
    base = FNameEntry4ToString(chunkPtr + within);
  } else {
    auto* pool = static_cast<FNamePool5*>(names);
    uint32 id = static_cast<uint32>(ComparisonIndex);
    uint32 block = id >> 16, offset = id & 0xFFFF;
    if (block >= 8192 || !CanRead(&pool->Blocks[block], sizeof(void*))) return "";
    uint8* b;
    memcpy(&b, &pool->Blocks[block], sizeof(b));
    if (!b) return "";
    base = FNameEntry5ToString(b + offset);
  }
  if (base.empty()) return "";
  if (Number > 0) {
    base += "_";
    base += std::to_string(Number);
  }
  return base;
}

// ------------------------------------------------------------------ UObject ----

std::string UObject::GetName() const {
  if (!CanRead(this, sizeof(UObject))) return "";
  UObject c;
  memcpy(&c, this, sizeof(c));
  return c.Name.ToString();
}

std::string UObject::GetFullName() const {
  std::string name = GetName();
  if (name.empty()) return "";
  std::string cls;
  if (CanRead(this, sizeof(UObject))) {
    UObject c;
    memcpy(&c, this, sizeof(c));
    if (c.Class && CanRead(c.Class, sizeof(UObject))) {
      UObject kc;
      memcpy(&kc, c.Class, sizeof(kc));
      cls = kc.Name.ToString();
    }
  }
  // Outer chain for context (Class /Game/Map.Map:PersistentLevel.Actor).
  std::string outer;
  const UObject* o = this;
  for (int i = 0; i < 8 && o && CanRead(o, sizeof(UObject)); i++) {
    UObject c;
    memcpy(&c, o, sizeof(c));
    o = c.Outer;
    if (!o) break;
    std::string on;
    if (CanRead(o, sizeof(UObject))) {
      UObject oc;
      memcpy(&oc, o, sizeof(oc));
      on = oc.Name.ToString();
    }
    if (on.empty()) break;
    outer = on + (outer.empty() ? "" : "." + outer);
  }
  std::string full = cls.empty() ? name : cls + " ";
  if (!outer.empty()) full += outer + ".";
  return full + name;
}

bool UObject::IsA(UClass* cls) const {
  if (!cls || !CanRead(this, sizeof(UObject))) return false;
  UObject self;
  memcpy(&self, this, sizeof(self));
  for (UClass* c = self.Class; c && CanRead(c, sizeof(UStruct));) {
    if (c == cls) return true;
    UStruct s;
    memcpy(&s, c, sizeof(s));
    c = static_cast<UClass*>(s.SuperStruct);  // a UClass's super is always a UClass
  }
  return false;
}

// --------------------------------------------------------------- reflection ----

void* FProperty::ContainerPtrToValuePtr(const void* container) const {
  return static_cast<uint8*>(const_cast<void*>(container)) + Offset_Internal;
}

static std::string ClassNameOf(UClass* cls) {
  if (!cls || !CanRead(cls, sizeof(UObject))) return "";
  UObject c;
  memcpy(&c, cls, sizeof(c));
  return c.Name.ToString();
}

FProperty* FindFProperty(UClass* cls, const std::string& name) {
  for (UStruct* s = cls; s && CanRead(s, sizeof(UStruct));) {
    UStruct sc;
    memcpy(&sc, s, sizeof(sc));
    for (UField* f = sc.Children; f && CanRead(f, sizeof(UField));) {
      UField fc;
      memcpy(&fc, f, sizeof(fc));
      // Only FProperty children carry Offset_Internal; identify by class name.
      std::string cn = ClassNameOf(fc.Class);
      bool isProp = cn.size() >= 8 && cn.compare(cn.size() - 8, 8, "Property") == 0;
      if (isProp) {
        FProperty* prop = static_cast<FProperty*>(f);
        if (CanRead(prop, sizeof(FProperty))) {
          FProperty pc;
          memcpy(&pc, prop, sizeof(pc));
          if (pc.Name.ToString() == name) return prop;
        }
      }
      f = fc.Next;
    }
    s = sc.SuperStruct;
  }
  return nullptr;
}

static bool IsFloatProp(FProperty* p) {
  std::string cn = ClassNameOf(p->GetClass());
  return cn == "FloatProperty" || cn == "DoubleProperty";
}
static bool IsIntProp(FProperty* p) {
  std::string cn = ClassNameOf(p->GetClass());
  return cn == "IntProperty" || cn == "Int32Property" || cn == "UInt32Property";
}
static bool IsBoolProp(FProperty* p) {
  return ClassNameOf(p->GetClass()) == "BoolProperty";
}

bool GetPropertyFloat(UObject* obj, const std::string& name, float& out) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(c));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsFloatProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  void* addr = pc.ContainerPtrToValuePtr(obj);
  std::string cn = ClassNameOf(p->GetClass());
  if (cn == "DoubleProperty") {
    if (!CanRead(addr, 8)) return false;
    double d;
    memcpy(&d, addr, 8);
    out = static_cast<float>(d);
    return true;
  }
  if (!CanRead(addr, 4)) return false;
  memcpy(&out, addr, 4);
  return true;
}

bool SetPropertyFloat(UObject* obj, const std::string& name, float value) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(c));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsFloatProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  void* addr = pc.ContainerPtrToValuePtr(obj);
  std::string cn = ClassNameOf(p->GetClass());
  if (cn == "DoubleProperty") {
    if (!CanRead(addr, 8)) return false;
    double d = value;
    memcpy(addr, &d, 8);
    return true;
  }
  if (!CanRead(addr, 4)) return false;
  memcpy(addr, &value, 4);
  return true;
}

bool GetPropertyInt(UObject* obj, const std::string& name, int32& out) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(UObject));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsIntProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  void* addr = pc.ContainerPtrToValuePtr(obj);
  if (!CanRead(addr, 4)) return false;
  memcpy(&out, addr, 4);
  return true;
}

bool SetPropertyInt(UObject* obj, const std::string& name, int32 value) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(UObject));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsIntProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  void* addr = pc.ContainerPtrToValuePtr(obj);
  if (!CanRead(addr, 4)) return false;
  memcpy(addr, &value, 4);
  return true;
}

// FBoolProperty tail sits right after FProperty (UE 4.25+). The offsets are
// version-sensitive, so the mask bytes are sanity-checked; a zero mask falls back
// to whole-byte semantics (covers native bools and misread tails alike).
struct BoolTail {
  uint8 FieldSize;
  uint8 ByteOffset;
  uint8 ByteMask;
  uint8 FieldMask;
};

static bool ReadBoolTail(FProperty* p, BoolTail& tail) {
  if (!CanRead(p, sizeof(FProperty)) ||
      !CanRead(reinterpret_cast<uint8*>(p) + sizeof(FProperty), sizeof(tail)))
    return false;
  memcpy(&tail, reinterpret_cast<uint8*>(p) + sizeof(FProperty), sizeof(tail));
  return true;
}

static bool BoolAddr(FProperty* p, const FProperty& pc, UObject* obj, uint8*& addr,
                     uint8& mask) {
  BoolTail t{};
  mask = 0xFF;
  uint8 extra = 0;
  if (ReadBoolTail(p, t) && t.FieldMask != 0) {
    mask = t.FieldMask;
    extra = t.ByteOffset;
  }
  addr = static_cast<uint8*>(pc.ContainerPtrToValuePtr(obj)) + extra;
  return CanRead(addr, 1);
}

bool GetPropertyBool(UObject* obj, const std::string& name, bool& out) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(UObject));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsBoolProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  uint8* addr;
  uint8 mask;
  if (!BoolAddr(p, pc, obj, addr, mask)) return false;
  uint8 b;
  memcpy(&b, addr, 1);
  out = (b & mask) != 0;
  return true;
}

bool SetPropertyBool(UObject* obj, const std::string& name, bool value) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(UObject));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !IsBoolProp(p) || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  uint8* addr;
  uint8 mask;
  if (!BoolAddr(p, pc, obj, addr, mask)) return false;
  uint8 b;
  memcpy(&b, addr, 1);
  b = value ? static_cast<uint8>(b | mask) : static_cast<uint8>(b & ~mask);
  memcpy(addr, &b, 1);
  return true;
}

bool GetPropertyString(UObject* obj, const std::string& name, std::string& out) {
  if (!obj || !CanRead(obj, sizeof(UObject))) return false;
  UObject c;
  memcpy(&c, obj, sizeof(UObject));
  FProperty* p = FindFProperty(c.Class, name);
  if (!p || !CanRead(p, sizeof(FProperty))) return false;
  FProperty pc;
  memcpy(&pc, p, sizeof(pc));
  std::string cn = ClassNameOf(p->GetClass());
  void* addr = pc.ContainerPtrToValuePtr(obj);
  if (cn == "NameProperty") {
    if (!CanRead(addr, sizeof(FName))) return false;
    FName n;
    memcpy(&n, addr, sizeof(n));
    out = n.ToString();
    return !out.empty();
  }
  if (cn == "StrProperty") {
    // FString { TCHAR* Data; int32 Count; int32 Max; }
    struct FString {
      void* Data;
      int32 Count;
      int32 Max;
    };
    if (!CanRead(addr, sizeof(FString))) return false;
    FString s;
    memcpy(&s, addr, sizeof(s));
    if (s.Count <= 0 || s.Count > 4096) return false;
    // TCHAR may be 1 or 2 bytes; detect from the first character's second byte.
    if (!CanRead(s.Data, 2)) return false;
    uint8 probe[2];
    memcpy(probe, s.Data, 2);
    if (probe[1] == 0 && probe[0] >= 0x20) {
      if (!CanRead(s.Data, (size_t)s.Count)) return false;
      out.assign(static_cast<const char*>(s.Data), (size_t)s.Count - 1);
      return LooksPrintableAscii(out.c_str(), out.size());
    }
    if (!CanRead(s.Data, (size_t)s.Count * 2)) return false;
    std::wstring ws(static_cast<const wchar_t*>(s.Data), (size_t)s.Count - 1);
    out = WideToUtf8(ws.c_str(), ws.size());
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ search ----

static std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

UObject* FindObject(const std::string& part, const std::string& classPart) {
  std::string want = Lower(part), wantCls = Lower(classPart);
  UObject* found = nullptr;
  ForEachObject([&](UObject* o) {
    std::string full = Lower(o->GetFullName());
    if (full.find(want) == std::string::npos) return true;
    if (!wantCls.empty() && full.find(wantCls) == std::string::npos) return true;
    found = o;
    return false;
  });
  return found;
}

UObject* FindWorld() {
  UObject* found = nullptr;
  ForEachObject([&](UObject* o) {
    if (!CanRead(o, sizeof(UObject))) return true;
    UObject c;
    memcpy(&c, o, sizeof(c));
    if (!c.Class || !CanRead(c.Class, sizeof(UObject))) return true;
    UObject kc;
    memcpy(&kc, c.Class, sizeof(kc));
    if (kc.Name.ToString() == "World") {
      found = o;
      return false;
    }
    return true;
  });
  return found;
}

}  // namespace UE
