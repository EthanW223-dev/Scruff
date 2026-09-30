using System;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace ScruffBridge
{
    /// <summary>
    /// Telos's Unity bridge for IL2CPP games: a BepInEx 6 plugin that connects to the Telos hub
    /// as a game adapter and lets the AI find, inspect and change anything in the running game.
    /// Same adapter protocol as the Mono bridge (bridge/ScruffBridge.dll), so the hub treats
    /// both the same; only the Unity plumbing differs.
    /// </summary>
    [BepInPlugin("dev.scruff.bridge", "Scruff Bridge", Version)]
    public class Plugin : BasePlugin
    {
        public const string Version = "1.1.0";

        public override void Load()
        {
            string url = Config.Bind("Scruff", "HubUrl", "ws://127.0.0.1:7777/ws/adapter", "Where Telos's hub listens for game adapters.").Value;
            // The runner has to be an IL2CPP type for Unity to drive it: ClassInjector builds a
            // native class on top of this managed one.
            ClassInjector.RegisterTypeInIl2Cpp<Runner>();
            // Some games destroy stray objects (BepInEx's own included): the bridge lives on a
            // hidden object of its own, so it keeps running whatever happens to this one.
            var host = new GameObject("ScruffBridge");
            host.hideFlags = HideFlags.HideAndDontSave;
            Object.DontDestroyOnLoad(host);
            var runner = host.AddComponent<Runner>();
            runner.Begin(url, Log);
            Log.LogInfo("Telos bridge " + Version + " (IL2CPP) loaded; connecting to " + url);
        }
    }
}
