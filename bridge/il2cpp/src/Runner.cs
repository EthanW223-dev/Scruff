using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using BepInEx.Logging;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace ScruffBridge
{
    /// <summary>
    /// The connection to Telos. Calls arrive on a network thread and run on Unity's main thread
    /// in Update, a few per frame, since Unity's API only works there.
    ///
    /// Everything is static: ClassInjector can't make native fields for arbitrary managed types
    /// (queues, threads), but static fields stay purely managed, which is all this needs.
    /// </summary>
    public class Runner : MonoBehaviour
    {
        const int FrameBudgetMs = 8;

        static ManualLogSource Log;
        static string url;
        static Runner self;
        static Thread thread;
        static volatile bool running;
        static volatile WebSocketClient socket;
        static readonly Queue<Dictionary<string, object>> calls = new Queue<Dictionary<string, object>>();
        static readonly Queue<string> events = new Queue<string>();

        // Injected types are built by Il2Cpp around this constructor.
        public Runner(IntPtr ptr) : base(ptr)
        {
        }

        public void Begin(string hubUrl, ManualLogSource log)
        {
            url = hubUrl;
            Log = log;
            self = this;
            // The Telos overlay takes focus while the player types; many games pause without this.
            Application.runInBackground = true;
            UnityTools.Setup();
            SceneManager.sceneLoaded += OnSceneLoaded;
            running = true;
            thread = new Thread(ConnectionLoop) { IsBackground = true, Name = "Telos bridge" };
            thread.Start();
            Log.LogInfo("Telos bridge " + Plugin.Version + " (IL2CPP) started; connecting to " + url);
        }

        static void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            lock (events) events.Enqueue("Scene loaded: " + scene.name);
        }

        public void OnApplicationQuit()
        {
            running = false;
            WebSocketClient s = socket;
            if (s != null) s.Dispose();
        }

        static void ConnectionLoop()
        {
            bool warned = false;
            while (running)
            {
                try
                {
                    WebSocketClient s = WebSocketClient.Connect(url, 3000);
                    socket = s;
                    s.Send(Json.Write(UnityTools.Hello()));
                    Log.LogInfo("Connected to Telos.");
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
                    Log.LogInfo("Disconnected from Telos; retrying.");
                }
                catch (Exception e)
                {
                    // Telos isn't running yet: keep trying quietly.
                    if (!warned) Log.LogInfo("Waiting for Telos (" + e.Message + ")");
                    warned = true;
                }
                WebSocketClient old = socket;
                socket = null;
                if (old != null) old.Dispose();
                for (int i = 0; i < 20 && running; i++) Thread.Sleep(100);
            }
        }

        public void Update()
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
                Send(s, UnityTools.Run(call, self));
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
            catch (Exception e) { Log.LogWarning("Couldn't reply to Telos: " + e.Message); }
        }
    }
}
