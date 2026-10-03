#!/bin/sh
# Builds bridge/TelosBridge.IL2CPP.dll, the BepInEx 6 plugin Telos installs into Unity IL2CPP games.
# Compiled with the .NET SDK against BepInEx 6 + Il2CppInterop and real IL2CPP Unity interop
# assemblies (see below): at runtime every UnityEngine reference binds to the interop assemblies
# BepInEx 6 generates inside the game. The one DLL loads in any Unity IL2CPP game BepInEx 6 supports.
# Needs: dotnet (.NET SDK 8+), curl, unzip; internet on the first build (NuGet reference packs).
set -e
cd "$(dirname "$0")"

if command -v dotnet >/dev/null 2>&1; then
  DOTNET=dotnet
elif [ -x "$HOME/workspace/.dotnet/dotnet" ]; then
  DOTNET="$HOME/workspace/.dotnet/dotnet"
else
  echo "Need the .NET SDK (dotnet) to build the IL2CPP bridge." >&2
  exit 1
fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

# Reference assemblies from BepInEx 6 (pre.2's Il2CppInterop 1.4.6: the plugin then binds to
# that or any newer one, so it loads in old and current BepInEx 6 builds alike).
BE6_VERSION=6.0.0-pre.2
mkdir -p .refs
if [ ! -f .refs/BepInEx.Core.dll ]; then
  echo "Fetching BepInEx 6 references…"
  curl -sSfL -o .refs/be6.zip \
    "https://github.com/BepInEx/BepInEx/releases/download/v$BE6_VERSION/BepInEx-Unity.IL2CPP-win-x64-$BE6_VERSION.zip"
  (cd .refs && unzip -q -o be6.zip "BepInEx/core/BepInEx.Core.dll" "BepInEx/core/BepInEx.Unity.IL2CPP.dll" "BepInEx/core/Il2CppInterop.Runtime.dll" "BepInEx/core/Il2CppInterop.Common.dll" "BepInEx/core/Mono.Cecil.dll")
  mv .refs/BepInEx/core/*.dll .refs/
  rm -rf .refs/BepInEx .refs/be6.zip
fi

# Unity's API as IL2CPP games expose it: the interop assemblies Il2CppInterop generates from a
# real Unity 2022.3 IL2CPP game, as published for modders on NuGet (compile-time only, never
# deployed). Building against the real thing keeps every call's signature right: Il2Cpp types,
# arrays and delegates are not the plain .NET ones Unity's Mono builds use.
INTEROP_PKG=vrising.unhollowed.client
INTEROP_VERSION=1.1.9.9219901
if [ ! -f .refs/interop/UnityEngine.CoreModule.dll ]; then
  echo "Fetching IL2CPP Unity interop references…"
  mkdir -p .refs/interop
  curl -sSfL -o .refs/interop.nupkg "https://api.nuget.org/v3-flatcontainer/$INTEROP_PKG/$INTEROP_VERSION/$INTEROP_PKG.$INTEROP_VERSION.nupkg"
  (cd .refs && unzip -q -o -j interop.nupkg "lib/net6.0/UnityEngine.CoreModule.dll" "lib/net6.0/UnityEngine.AnimationModule.dll" "lib/net6.0/Il2Cppmscorlib.dll" -d interop)
  rm -f .refs/interop.nupkg
fi

"$DOTNET" build TelosBridge.IL2CPP.csproj -c Release -o .build --nologo -v q

# Every Unity/BepInEx/Il2CppInterop call must exist as compiled in the assemblies a game has:
# one that doesn't throws MissingMethodException at runtime instead of failing here.
"$DOTNET" build verify/Verify.csproj -c Release -o .refs/verify --nologo -v q
"$DOTNET" .refs/verify/Verify.dll .build/TelosBridge.IL2CPP.dll ".refs;.refs/interop"

cp .build/TelosBridge.IL2CPP.dll ../TelosBridge.IL2CPP.dll
echo "Built bridge/TelosBridge.IL2CPP.dll ($(wc -c < ../TelosBridge.IL2CPP.dll) bytes)"
