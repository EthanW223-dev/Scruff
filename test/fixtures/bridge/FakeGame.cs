// A stand-in for a Unity game, for testing the bridge's own code (WebSocket client, JSON and the
// reflection that reads and changes the game's objects) against a real Scruff hub under Mono.
// Unity itself can't run in the tests, so Vector3 and Color are small look-alikes here.
using System;
using System.Collections.Generic;
using ScruffBridge;

namespace UnityEngine
{
    public struct Vector3
    {
        public float x, y, z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
    }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; }
    }
}

namespace FakeGame
{
    public enum Mode { Walk, Fly, Swim }

    public class Item
    {
        public string name;
        public int count;
    }

    public class Stats
    {
        public float maxHealth = 100;
        private int armor = 3;
        public int Armor { get { return armor; } }
    }

    public class Player
    {
        public float speed = 5;
        private float jumpHeight = 2;
        public Stats stats = new Stats();
        public UnityEngine.Vector3 position = new UnityEngine.Vector3(1, 2, 3);
        public UnityEngine.Color tint = new UnityEngine.Color(1, 1, 1, 1);
        public List<Item> items = new List<Item> { new Item { name = "soup", count = 3 }, new Item { name = "water", count = 1 } };
        public Mode mode = Mode.Walk;
        public int Gold { get; set; }
        public string motto = "";
        public float health = 50;

        public void Heal(float amount) { health = Math.Min(stats.maxHealth, health + amount); }

        public int AddItem(string name, int count)
        {
            Item it = items.Find(i => i.name == name);
            if (it == null) { it = new Item { name = name }; items.Add(it); }
            it.count += count;
            return it.count;
        }

        public float JumpHeight() { return jumpHeight; }
    }

    public class Singleton<T> where T : class, new()
    {
        public static T Instance = new T();
    }

    public class AudioDirector : Singleton<AudioDirector>
    {
        public float volume = 1;
    }

    public class GameManager
    {
        public static GameManager Instance = new GameManager();
        public Player player = new Player();
        public int money = 50;
    }

    public static class Program
    {
        static Dictionary<string, object> Tool(string name)
        {
            return new Dictionary<string, object> { { "name", name }, { "description", name }, { "input_schema", new Dictionary<string, object> { { "type", "object" } } } };
        }

        public static int Main(string[] args)
        {
            WebSocketClient ws = WebSocketClient.Connect(args[0], 3000);
            ws.Send(Json.Write(new Dictionary<string, object>
            {
                { "type", "hello" }, { "name", "Fake Unity game" }, { "game", "unity" },
                { "tools", new List<object> { Tool("get"), Tool("set"), Tool("call"), Tool("echo"), Tool("types") } },
            }));
            while (true)
            {
                string text = ws.Receive();
                if (text == null) return 0;
                var msg = (Dictionary<string, object>)Json.Parse(text);
                if ((string)msg["type"] != "call") continue;
                var reply = new Dictionary<string, object> { { "type", "result" }, { "id", msg["id"] } };
                try
                {
                    var a = new Args(msg.ContainsKey("input") ? msg["input"] : null);
                    object result;
                    string tool = (string)msg["tool"];
                    if (tool == "echo")
                    {
                        result = a.Raw("text");
                    }
                    else if (tool == "types")
                    {
                        string query = a.Str("query", "");
                        var names = new List<object>();
                        if (query.Length == 0) foreach (string s in Reflect.Singletons(20)) names.Add(s);
                        else
                        {
                            var ranked = new List<KeyValuePair<int, string>>();
                            foreach (Type t in Reflect.AllTypes(true))
                            {
                                int score = Reflect.Score(t.Name, query);
                                if (score > 0) ranked.Add(new KeyValuePair<int, string>(score, t.FullName));
                            }
                            ranked.Sort((x, y) => y.Key != x.Key ? y.Key - x.Key : string.CompareOrdinal(x.Value, y.Value));
                            foreach (var kv in ranked) names.Add(kv.Value);
                        }
                        result = names;
                    }
                    else
                    {
                        Type type = Reflect.FindType(a.Need("type"));
                        string path = a.Str("path");
                        if (tool == "get")
                        {
                            result = new Dictionary<string, object> { { "value", Reflect.Describe(Reflect.Get(null, type, a.Need("path")), 2) } };
                        }
                        else if (tool == "set")
                        {
                            object before = Reflect.Set(null, type, a.Need("path"), a.Raw("value"));
                            result = new Dictionary<string, object>
                            {
                                { "before", Reflect.Describe(before, 1) },
                                { "after", Reflect.Describe(Reflect.Get(null, type, a.Need("path")), 1) },
                            };
                        }
                        else
                        {
                            object target = null;
                            if (!string.IsNullOrEmpty(path)) { target = Reflect.Get(null, type, path); type = target.GetType(); }
                            result = new Dictionary<string, object> { { "result", Reflect.Describe(Reflect.Call(target, type, a.Need("method"), a.Raw("args") as List<object>), 1) } };
                        }
                    }
                    reply["ok"] = true;
                    reply["content"] = result;
                }
                catch (Exception e)
                {
                    reply["ok"] = false;
                    reply["error"] = Reflect.Unwrap(e).Message;
                }
                ws.Send(Json.Write(reply));
            }
        }
    }
}
