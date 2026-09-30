#!/bin/sh
# Builds bridge/TelosBridge.IL2CPP.dll, the BepInEx 6 plugin Telos installs into Unity IL2CPP games.
# Compiled with the .NET SDK against the BepInEx 6 + Il2CppInterop assemblies Telos installs into
# games, plus compile-time-only UnityEngine stubs (stubs/): at runtime every UnityEngine reference
# unifies with the interop assemblies BepInEx 6 generates inside the game, so the stub DLLs are
# never deployed. The one DLL loads in any Unity IL2CPP game BepInEx 6 supports.
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

# Reference assemblies from the same BepInEx 6 build Telos installs into games.
BE6_VERSION=6.0.0-pre.2
mkdir -p .refs
if [ ! -f .refs/BepInEx.Core.dll ]; then
  echo "Fetching BepInEx 6 references…"
  curl -sSfL -o .refs/be6.zip \
    "https://github.com/BepInEx/BepInEx/releases/download/v$BE6_VERSION/BepInEx-Unity.IL2CPP-win-x64-$BE6_VERSION.zip"
  (cd .refs && unzip -q -o be6.zip "BepInEx/core/BepInEx.Core.dll" "BepInEx/core/BepInEx.Unity.IL2CPP.dll" "BepInEx/core/Il2CppInterop.Runtime.dll")
  mv .refs/BepInEx/core/BepInEx.Core.dll .refs/BepInEx/core/BepInEx.Unity.IL2CPP.dll .refs/BepInEx/core/Il2CppInterop.Runtime.dll .refs/
  rmdir -p .refs/BepInEx/core 2>/dev/null || true
fi

"$DOTNET" build stubs/CoreModule/CoreModule.csproj -c Release -o .refs/stubs --nologo -v q
"$DOTNET" build stubs/AnimationModule/AnimationModule.csproj -c Release -o .refs/stubs --nologo -v q
"$DOTNET" build TelosBridge.IL2CPP.csproj -c Release -o .build --nologo -v q
cp .build/TelosBridge.IL2CPP.dll ../TelosBridge.IL2CPP.dll
echo "Built bridge/TelosBridge.IL2CPP.dll ($(wc -c < ../TelosBridge.IL2CPP.dll) bytes)"
