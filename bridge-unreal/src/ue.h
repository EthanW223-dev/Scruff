// Scruff Unreal bridge: minimal UE4.25+/UE5 core types and the GObjects walker.
// Layouts here assume UE 4.25+ (FProperty, FName as in 4.25-5.x). Verify per game.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace UE {

using int32 = int32_t;
using uint8 = uint8_t;

// --- FName (UE 4.25+ / UE5: comparison index + number) ---
struct FName {
  int32 ComparisonIndex;
  int32 Number;
  std::string ToString() const; // resolved via GNames; empty if unavailable
};

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
  static class UClass* StaticClass(); // resolved at runtime
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
 public:
  static UClass* StaticClass();
};

class FProperty : public UField {
 public:
  int32 ArrayDim;
  int32 ElementSize;
  int32 PropertyFlags;
  int32 Offset_Internal;  // 0x4C in most builds; verify per version
  // (fields after this vary; the bridge only needs the offset + type id)

  void* ContainerPtrToValuePtr(const void* container) const;
  const char* GetCPPType() const;  // "float", "int32", "bool", "FString", ...
};

// --- GObjects access ---
// Returns the global FUObjectArray, or nullptr if the pattern didn't resolve.
// The pointer is cached but re-validated on every walk (level changes realloc).
FUObjectArray* GObjects();

// Iterate every live UObject. Return false from fn to stop.
template <typename Fn>
void ForEachObject(Fn&& fn) {
  FUObjectArray* arr = GObjects();
  if (!arr) return;
  TUObjectArray& objs = arr->ObjObjects;
  if (!objs.Objects || objs.NumElements <= 0 || objs.NumElements > 8'000'000) return;
  for (int32 i = 0; i < objs.NumElements; i++) {
    UObject* o = objs.Objects[i].Object;
    if (!o) continue;
    if (!fn(o)) break;
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

// Find first object whose full name contains `part` (case-insensitive), or whose class
// name contains `classPart`.
UObject* FindObject(const std::string& part, const std::string& classPart = "");

}  // namespace UE
