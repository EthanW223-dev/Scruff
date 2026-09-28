using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using BepInEx;
using BepInEx.Logging;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace ScruffBridge
{
    /// <summary>
    /// Scruff's Unity bridge: a BepInEx plugin that connects to the Scruff hub as a game adapter
    /// and lets the AI find, inspect and change anything in the running game.
    /// </summary>
    [BepInPlugin("dev.scruff.bridge", "Scruff Bridge", Version)]
    public class Plugin : BaseUnityPlugin
    {
        public const string Version = "1.1.0";

        void Awake()
        {
            string url = Config.Bind("Scruff", "HubUrl", "ws://127.0.0.1:7777/ws/adapter", "Where Scruff's hub listens for game adapters.").Value;
            // Some games destroy stray objects (BepInEx's own included): the bridge lives on a
            // hidden object of its own, so it keeps running whatever happens to this one.
            var host = new GameObject("ScruffBridge");
            host.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(host);
            host.AddComponent<Runner>().Begin(url, Logger);
        }
    }

    /// <summary>
    /// The connection to Scruff. Calls arrive on a network thread and run on Unity's main thread
    /// in Update, a few per frame, since Unity's API only works there.
    /// </summary>
    public class Runner : MonoBehaviour
    {
        const int FrameBudgetMs = 8;

        internal static ManualLogSource Log;
        string url;
        Thread thread;
        volatile bool running;
        volatile WebSocketClient socket;
        readonly Queue<Dictionary<string, object>> calls = new Queue<Dictionary<string, object>>();
        readonly Queue<string> events = new Queue<string>();

        public void Begin(string hubUrl, ManualLogSource log)
        {
            url = hubUrl;
            Log = log;
            // The Scruff overlay takes focus while the player types; many games pause without this.
            Application.runInBackground = true;
            UnityTools.Setup();
            SceneManager.sceneLoaded += OnSceneLoaded;
            running = true;
            thread = new Thread(ConnectionLoop) { IsBackground = true, Name = "Scruff bridge" };
            thread.Start();
            Log.LogInfo("Scruff bridge " + Plugin.Version + " started; connecting to " + url);
        }

        void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            lock (events) events.Enqueue("Scene loaded: " + scene.name);
        }

        void OnApplicationQuit()
        {
            running = false;
            WebSocketClient s = socket;
            if (s != null) s.Dispose();
        }

        void ConnectionLoop()
        {
            bool warned = false;
            while (running)
            {
                try
                {
                    WebSocketClient s = WebSocketClient.Connect(url, 3000);
                    socket = s;
                    s.Send(Json.Write(UnityTools.Hello()));
                    Log.LogInfo("Connected to Scruff.");
                    warned = false;
                    while (running)
                    {
                        string text = s.Receive();
                        if (text == null) break;
                        var msg = Json.Parse(text) as Dictionary<string, object>;
                        object type;
                        if (msg != null && msg.TryGetValue("type", out type) && (type as string) == "call")
                            lock (calls) calls.Enqueue(msg);
                    }
                    Log.LogInfo("Disconnected from Scruff; retrying.");
                }
                catch (Exception e)
                {
                    // Scruff isn't running yet: keep trying quietly.
                    if (!warned) Log.LogInfo("Waiting for Scruff (" + e.Message + ")");
                    warned = true;
                }
                WebSocketClient old = socket;
                socket = null;
                if (old != null) old.Dispose();
                for (int i = 0; i < 20 && running; i++) Thread.Sleep(100);
            }
        }

        void Update()
        {
            WebSocketClient s = socket;
            if (s == null) return;
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < FrameBudgetMs)
            {
                Dictionary<string, object> call;
                lock (calls)
                {
                    if (calls.Count == 0) break;
                    call = calls.Dequeue();
                }
                Send(s, UnityTools.Run(call, this));
            }
            lock (events)
            {
                while (events.Count > 0)
                    Send(s, new Dictionary<string, object> { { "type", "event" }, { "text", events.Dequeue() } });
            }
        }

        static void Send(WebSocketClient s, object message)
        {
            try { s.Send(Json.Write(message)); }
            catch (Exception e) { Log.LogWarning("Couldn't reply to Scruff: " + e.Message); }
        }
    }
}
