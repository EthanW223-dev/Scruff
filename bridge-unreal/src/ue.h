// Telos Unreal bridge: minimal UE4.25+/UE5 core types and the GObjects/GNames walkers.
//
// Layouts assume UE 4.25+ (FProperty, FName as in 4.25-5.x). Unreal has no stable ABI
// between versions: every pattern-resolved pointer is VALIDATED before use, and every
// foreign dereference goes through CanRead() (VirtualQuery), never SEH (__try is MSVC-only
// and this builds with mingw). A pattern that resolves but fails validation is skipped.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace UE {

using int32 = int32_t;
using uint8 = uint8_t;
using uint16 = uint16_t;
using uint32 = uint32_t;
using uint64 = uint64_t;

// True when [p, p+n) is committed readable memory. The bridge's seatbelt: all reads of
// game memory go through this first, so a wrong pattern/offset fails cleanly.
bool CanRead(const void* p, size_t n);

// --- FName (UE 4.25+ / UE5: comparison index + number) ---
struct FName {
  int32 ComparisonIndex;
  int32 Number;
  std::string ToString() const;  // resolved via GNames; "" when the pool isn't usable
};

// Name pool access. UE4: TNameEntryArray*; UE5: FNamePool*. Returns nullptr until a
// pattern resolves AND validates. Which layout it is detected at resolve time.
void* GNames();
bool GNamesIsUe5();

// --- UObject (only the fields the bridge touches) ---
class UObject {
 public:
  void* VTable;          // 0x00
  int32 ObjectFlags;     // 0x08
  int32 InternalIndex;   // 0x0C
  class UClass* Class;   // 0x10
  FName Name;            // 0x18
  UObject* Outer;        // 0x20

  std::string GetName() const;
  std::string GetFullName() const;
  class UClass* GetClass() const { return Class; }
  bool IsA(class UClass* cls) const;
};

// --- TUObjectArray / FUObjectArray ---
struct FUObjectItem {
  UObject* Object;
  int32 Flags;
  int32 ClusterIndex;
  int32 SerialNumber;
};

struct TUObjectArray {
  FUObjectItem* Objects;
  int32 MaxElements;
  int32 NumElements;
};

struct FUObjectArray {
  int32 ObjFirstGCIndex;
  int32 ObjLastNonGCIndex;
  int32 MaxSingleBlockIndex;
  TUObjectArray ObjObjects;
};

// --- UClass / UStruct / FProperty (UE 4.25+) ---
class UField : public UObject {
 public:
  UField* Next;
};

class UStruct : public UField {
 public:
  UStruct* SuperStruct;
  UField* Children;  // linked list of UFields (FProperties for UClass)
};

class UClass : public UStruct {
};

// FProperty as of UE 4.25 (through PostConstructLinkNext). Later versions may append
// fields; the bridge only reads up to Offset_Internal plus the FBoolProperty tail.
class FProperty : public UField {
 public:
  int32 ArrayDim;            // 0x30
  int32 ElementSize;         // 0x34
  uint64 PropertyFlags;      // 0x38
  uint16 RepIndex;           // 0x40
  uint8 BlueprintReplicationCondition;  // 0x42
  uint8 Pad43;               // 0x43
  int32 Offset_Internal;     // 0x44
  FName RepNotifyFunc;       // 0x48
  FProperty* PropertyLinkNext;       // 0x50
  FProperty* NextRef;                // 0x58
  FProperty* DestructorLinkNext;     // 0x60
  FProperty* PostConstructLinkNext;  // 0x68
  // FBoolProperty tail (FieldSize, ByteOffset, ByteMask, FieldMask) follows here.
  // Offsets are version-sensitive: the bridge reads them guarded and sanity-checks.

  void* ContainerPtrToValuePtr(const void* container) const;
};

// --- GObjects access ---
// Returns the global FUObjectArray, or nullptr if no pattern resolved+validated.
// The pointer is cached but re-validated on every walk (level changes realloc).
FUObjectArray* GObjects();

// Iterate every live UObject. Return false from fn to stop.
template <typename Fn>
void ForEachObject(Fn&& fn) {
  FUObjectArray* arr = GObjects();
  if (!arr) return;
  TUObjectArray objs;
  if (!CanRead(&arr->ObjObjects, sizeof(objs))) return;
  objs = arr->ObjObjects;
  if (!objs.Objects || objs.NumElements <= 0 || objs.NumElements > 8'000'000) return;
  if (!CanRead(objs.Objects, sizeof(FUObjectItem))) return;
  for (int32 i = 0; i < objs.NumElements; i++) {
    FUObjectItem item;
    if (!CanRead(&objs.Objects[i], sizeof(item))) continue;
    item = objs.Objects[i];
    if (!item.Object || !CanRead(item.Object, sizeof(UObject))) continue;
    if (!fn(item.Object)) break;
  }
}

// --- reflection helpers (implemented in ue.cpp) ---
FProperty* FindFProperty(UClass* cls, const std::string& name);
bool GetPropertyFloat(UObject* obj, const std::string& name, float& out);
bool SetPropertyFloat(UObject* obj, const std::string& name, float value);
bool GetPropertyInt(UObject* obj, const std::string& name, int32& out);
bool SetPropertyInt(UObject* obj, const std::string& name, int32 value);
bool GetPropertyBool(UObject* obj, const std::string& name, bool& out);
bool SetPropertyBool(UObject* obj, const std::string& name, bool value);
bool GetPropertyString(UObject* obj, const std::string& name, std::string& out);

// Find first object whose full name contains `part` (case-insensitive), or whose class
// name contains `classPart`.
UObject* FindObject(const std::string& part, const std::string& classPart = "");

// The gameplay UWorld (first object whose class is named "World"), or nullptr.
UObject* FindWorld();

}  // namespace UE
