#!/bin/sh
# Builds ScruffBridge.dll, the BepInEx 5 plugin Scruff installs into Unity (Mono) games.
# Compiled with Mono's C# compiler against .NET 3.5, Unity 5.6 and BepInEx 5.4 reference
# assemblies from NuGet, so the one DLL loads in any Mono Unity game from 5.x on.
# Needs: mcs (apt install mono-mcs), curl, unzip.
set -e
cd "$(dirname "$0")"
mkdir -p .refs
fetch() {
  [ -d ".refs/$1" ] && return 0
  curl -sSfL -o ".refs/$1.nupkg" "$2"
  mkdir -p ".refs/$1" && (cd ".refs/$1" && unzip -q -o "../$1.nupkg")
}
fetch net35 https://api.nuget.org/v3-flatcontainer/microsoft.netframework.referenceassemblies.net35/1.0.3/microsoft.netframework.referenceassemblies.net35.1.0.3.nupkg
fetch unityengine https://nuget.bepinex.dev/v3/package/unityengine/5.6.1/unityengine.5.6.1.nupkg
fetch baselib https://nuget.bepinex.dev/v3/package/bepinex.baselib/5.4.21/bepinex.baselib.5.4.21.nupkg

NET=.refs/net35/build/.NETFramework/v3.5
mcs -nologo -target:library -optimize+ -nostdlib -noconfig -langversion:6 \
  -r:$NET/mscorlib.dll -r:$NET/System.dll -r:$NET/System.Core.dll \
  -r:.refs/unityengine/lib/net35/UnityEngine.dll -r:.refs/baselib/lib/net35/BepInEx.dll \
  -out:ScruffBridge.dll src/*.cs
echo "Built bridge/ScruffBridge.dll ($(wc -c < ScruffBridge.dll) bytes)"
