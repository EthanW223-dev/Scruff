// Scruff Unreal bridge: pattern scanner + GObjects walker + FProperty helpers.
//
// The pattern list below holds the well-known public GObjects signatures. They drift
// between engine versions, so every candidate is VALIDATED before use: the resolved
// pointer must look like an FUObjectArray (sane NumElements, first entries point at
// memory inside a loaded game module). A pattern that resolves but fails validation is
// skipped, never trusted.
#include "ue.h"
#include <windows.h>
#include <algorithm>
#include <cctype>
#include <cstring>
#include <psapi.h>

namespace UE {

// ------------------------------------------------------------------ patterns

struct Pattern {
  const char* name;      // engine version this was seen on
  const char* bytes;     // IDA-style, "48 8B 0D ? ? ? ? ..."
  int32 ripOffset;       // offset of the RIP-relative dword in the match
  int32 ripInstrLen;     // length of the instruction (match + len = base)
};

// VERIFY BEFORE USE: candidates from public sources; confirm with a debugger that the
// resolved address is FUObjectArray for YOUR game version.
static const Pattern kGObjectsPatterns[] = {
    // UE 4.25 - 4.27 era GObjects signature (RIP-relative lea/mov).
    {"ue4.25-4.27", "48 8B 0D ? ? ? ? 48 85 C9 75 ? E8 ? ? ? ? 48 8B 0D ? ? ? ?", 3, 7},
    // UE 5.0 - 5.2 era.
    {"ue5.0-5.2", "48 8B 05 ? ? ? ? 48 8B 0C C8 48 8D 04 D1 EB ? 48 8B 05 ? ? ? ?", 3, 7},
    // UE 5.3+ era.
    {"ue5.3+", "48 8B 05 ? ? ? ? 48 8B 14 C8 EB ? 48 8B 05 ? ? ? ?", 3, 7},
};

static bool MatchByte(const char* pat, uint8 byte) {
  if (pat[0] == '?' ) return true;
  char buf[3] = {pat[0], pat[1], 0};
  return (uint8)strtoul(buf, nullptr, 16) == byte;
}

static const uint8* FindPattern(const uint8* base, size_t size, const char* pattern) {
  // Tokenize "48 8B ? ?" into matchers.
  const char* p = pattern;
  char toks[128][3];
  int ntok = 0;
  while (*p && ntok < 128) {
    while (*p == ' ') p++;
    if (!*p) break;
    toks[ntok][0] = p[0];
    toks[ntok][1] = p[1] ? p[1] : ' ';
    toks[ntok][2] = 0;
    ntok++;
    while (*p && *p != ' ') p++;
  }
  for (size_t i = 0; i + ntok <= size; i++) {
    bool ok = true;
    for (int t = 0; t < ntok; t++) {
      if (toks[t][0] == '?') continue;
      char buf[3] = {toks[t][0], toks[t][1], 0};
      if ((uint8)strtoul(buf, nullptr, 16) != base[i + t]) { ok = false; break; }
    }
    if (ok) return base + i;
  }
  return nullptr;
}

static bool LooksLikeGamePointer(const void* p) {
  if (!p) return false;
  MEMORY_BASIC_INFORMATION mi{};
  if (!VirtualQuery(p, &mi, sizeof(mi))) return false;
  if (mi.State != MEM_COMMIT) return false;
  // Must live in an executable image (game or engine module), not heap noise.
  char modName[MAX_PATH] = {};
  return GetModuleFileNameA((HMODULE)mi.AllocationBase, modName, MAX_PATH) > 0;
}

// The FUObjectArray itself lives in .data; validate shape, not module.
static bool LooksLikeFUObjectArray(const FUObjectArray* a) {
  if (!a) return false;
  __try {
    const TUObjectArray& o = a->ObjObjects;
    if (o.NumElements <= 0 || o.NumElements > 8'000'000) return false;
    if (!o.Objects) return false;
    // First live entry should be a plausible UObject (vtable in a module).
    for (int32 i = 0; i < o.NumElements && i < 64; i++) {
      UObject* u = o.Objects[i].Object;
      if (!u) continue;
      if (!LooksLikeGamePointer(u)) return false;
      if (!LooksLikeGamePointer(*(void**)u)) return false;  // vtable
      return true;
    }
    return false;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
}

FUObjectArray* GObjects() {
  static FUObjectArray* cached = nullptr;
  if (cached && LooksLikeFUObjectArray(cached)) return cached;
  cached = nullptr;

  HMODULE exe = GetModuleHandleA(nullptr);
  MODULEINFO mi{};
  if (!GetModuleInformation(GetCurrentProcess(), exe, &mi, sizeof(mi))) return nullptr;
  const uint8* base = (const uint8*)mi.lpBaseOfDll;
  size_t size = mi.SizeOfImage;

  for (const Pattern& pat : kGObjectsPatterns) {
    const uint8* match = FindPattern(base, size, pat.bytes);
    if (!match) continue;
    int32 rip = *(int32*)(match + pat.ripOffset);
    auto* candidate = (FUObjectArray*)(match + pat.ripInstrLen + rip);
    if (LooksLikeFUObjectArray(candidate)) {
      cached = candidate;  // validated, not just resolved
      return cached;
    }
  }
  return nullptr;
}

// ------------------------------------------------------------------ UObject

std::string UObject::GetName() const { return "<unresolved>"; }  // needs GNames; see README

std::string UObject::GetFullName() const {
  std::string n = GetName();
  for (const UObject* o = Outer; o; o = o->Outer) n = o->GetName() + "." + n;
  return n;
}

bool UObject::IsA(UClass* cls) const {
  for (UClass* c = Class; c; c = c->SuperStruct) {
    if (c == cls) return true;
  }
  return false;
}

// ------------------------------------------------------------------ FProperty

void* FProperty::ContainerPtrToValuePtr(const void* container) const {
  return (uint8*)container + Offset_Internal;
}

FProperty* FindFProperty(UClass* cls, const std::string& name) {
  std::string want = name;
  std::transform(want.begin(), want.end(), want.begin(), ::tolower);
  for (UClass* c = cls; c; c = c->SuperStruct) {
    for (UField* f = c->Children; f; f = f->Next) {
      std::string fname = ((UObject*)f)->GetName();
      std::string low = fname;
      std::transform(low.begin(), low.end(), low.begin(), ::tolower);
      if (low == want) return (FProperty*)f;
    }
  }
  return nullptr;
}

namespace {
// Minimal type dispatch on the property's C++ type string. UE exposes this via
// FField::GetCPPType(); here we read it through the vtable-free path is skipped and
// instead match on the class name of the property object.
std::string PropKind(FProperty* p) {
  std::string cn = p->GetClass()->GetName();
  if (cn.find("FloatProperty") != std::string::npos) return "float";
  if (cn.find("DoubleProperty") != std::string::npos) return "double";
  if (cn.find("IntProperty") != std::string::npos) return "int32";
  if (cn.find("BoolProperty") != std::string::npos) return "bool";
  return "other";
}
}  // namespace

bool GetPropertyFloat(UObject* obj, const std::string& name, float& out) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "float") return false;
  out = *(float*)p->ContainerPtrToValuePtr(obj);
  return true;
}
bool SetPropertyFloat(UObject* obj, const std::string& name, float value) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "float") return false;
  *(float*)p->ContainerPtrToValuePtr(obj) = value;
  return true;
}
bool GetPropertyInt(UObject* obj, const std::string& name, int32& out) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "int32") return false;
  out = *(int32*)p->ContainerPtrToValuePtr(obj);
  return true;
}
bool SetPropertyInt(UObject* obj, const std::string& name, int32 value) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "int32") return false;
  *(int32*)p->ContainerPtrToValuePtr(obj) = value;
  return true;
}
bool GetPropertyBool(UObject* obj, const std::string& name, bool& out) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "bool") return false;
  // BoolProperty may be a bitfield; full handling needs FieldMask. Byte case first.
  out = *(uint8*)p->ContainerPtrToValuePtr(obj) != 0;
  return true;
}
bool SetPropertyBool(UObject* obj, const std::string& name, bool value) {
  FProperty* p = FindFProperty(obj->GetClass(), name);
  if (!p || PropKind(p) != "bool") return false;
  *(uint8*)p->ContainerPtrToValuePtr(obj) = value ? 1 : 0;
  return true;
}

UObject* FindObject(const std::string& part, const std::string& classPart) {
  std::string want = part, wc = classPart;
  std::transform(want.begin(), want.end(), want.begin(), ::tolower);
  std::transform(wc.begin(), wc.end(), wc.begin(), ::tolower);
  UObject* found = nullptr;
  ForEachObject([&](UObject* o) {
    std::string full = o->GetFullName();
    std::string low = full;
    std::transform(low.begin(), low.end(), low.begin(), ::tolower);
    if (!want.empty() && low.find(want) == std::string::npos) return true;
    if (!wc.empty()) {
      std::string cn = o->GetClass()->GetName();
      std::transform(cn.begin(), cn.end(), cn.begin(), ::tolower);
      if (cn.find(wc) == std::string::npos) return true;
    }
    found = o;
    return false;
  });
  return found;
}

}  // namespace UE
