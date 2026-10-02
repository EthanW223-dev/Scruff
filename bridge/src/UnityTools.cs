using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace ScruffBridge
{
    /// <summary>
    /// What the AI can do inside a Unity game. Objects are addressed by id (GetInstanceID of the
    /// GameObject); components by type name; members by name or dotted path.
    /// </summary>
    public static class UnityTools
    {
        delegate object Handler(Args a, MonoBehaviour host);

        class Tool
        {
            public string Name;
            public string Description;
            public Dictionary<string, object> Schema;
            public Handler Run;
        }

        const int MaxReply = 14000;
        static readonly List<Tool> Tools = new List<Tool>();
        static readonly Dictionary<int, GameObject> Known = new Dictionary<int, GameObject>();
        static readonly Dictionary<string, Type> UnityTypes = new Dictionary<string, Type>();

        /// <summary>Members that are noise, or that have side effects when read (renderer.material copies the material).</summary>
        static readonly HashSet<string> Skip = new HashSet<string>
        {
            "material", "materials", "mesh", "hideFlags", "name", "tag", "transform", "gameObject", "runInEditMode",
            "useGUILayout", "worldToLocalMatrix", "localToWorldMatrix", "isActiveAndEnabled",
        };

        // ------------------------------------------------------------------ protocol

        public static void Setup()
        {
            Reflect.ObjectResolver = ResolveReference;
            Reflect.ObjectDescriber = DescribeObject;
            if (Tools.Count > 0) return;

            Define("find",
                "Start here. Find objects in the running game by part of their name, a component type (e.g. 'PlayerController', " +
                "'SpriteRenderer', 'Light') or tag. Returns ids for the other tools. include_assets also lists prefabs that " +
                "aren't placed in the level (things spawn can copy).",
                S("name:string?:Part of the object's name, any case",
                  "component:string?:A component type name, or part of one",
                  "tag:string?:Unity tag, e.g. Player",
                  "include_inactive:boolean?:Also hidden/disabled objects",
                  "include_assets:boolean?:Also prefabs and other objects that aren't in the scene",
                  "limit:integer?:Default 30"),
                Find);
            Define("inspect",
                "Everything on one object: position, children, and every component with its fields and properties (private " +
                "ones too) and their current values. Give component to see just that one in more depth.",
                S("id:integer:Object id from find", "component:string?:Only this component"),
                Inspect);
            Define("get",
                "Read one value, following a dotted path from a component (e.g. 'stats.maxHealth', 'inventory[0]'), or " +
                "from a class's static members when you give type instead of id (e.g. type 'GameManager', path 'Instance.money').",
                S("id:integer?:Object id", "component:string?:Component type on that object (default GameObject)",
                  "type:string?:A class name, for static values", "path:string?:Dotted path; leave out to list everything"),
                Get);
            Define("set",
                "Change any field or property: on a component of an object (id + component + path), or static (type + path, e.g. " +
                "'GameManager' + 'Instance.money'). Numbers, true/false, text, enum names, [x,y,z] vectors and colors " +
                "('red', '#ff8800', [1,0.5,0]) all work. Returns the value before and after.",
                S("id:integer?:Object id", "component:string?:Component type on that object",
                  "type:string?:A class name, for static values", "path:string:Field or property, dotted for nested",
                  "value:any:The new value"),
                Set);
            Define("call",
                "Call one of the game's own methods, e.g. AddItem('soup', 5), Heal(100), Die(), UnlockAll(). On a component " +
                "(id + component), on what a path leads to, or static (type). Coroutines are started.",
                S("id:integer?:Object id", "component:string?:Component type on that object",
                  "type:string?:A class name, for static methods or a static path", "path:string?:Dotted path to the object to call it on",
                  "method:string:Method name", "args:array?:Arguments in order"),
                Call);
            Define("types",
                "Search the game's own code for classes by name (any of the words, e.g. 'player inventory manager save'): " +
                "their static values (singletons like Instance), methods, and how many exist in the level right now with " +
                "ids. Leave query empty to list the game's singletons (e.g. GameManager.Instance), the usual way in.",
                S("query:string?:Words from class names; empty for the singletons", "limit:integer?:Default 12"),
                Types);
            Define("transform",
                "Move, rotate or resize an object: position/rotation (degrees)/scale as [x,y,z]; scale can be one number. " +
                "relative adds (or multiplies, for scale) instead of replacing.",
                S("id:integer:Object id", "position:any?:[x,y,z]", "rotation:any?:[x,y,z] in degrees", "scale:any?:[x,y,z] or one number",
                  "relative:boolean?:Add to / multiply the current values", "local:boolean?:Relative to the parent"),
                TransformTool);
            Define("color",
                "Recolor an object: sprites, UI, lights, text, and the materials of 3D models. A color name, '#rrggbb' or [r,g,b(,a)].",
                S("id:integer:Object id", "color:any:e.g. 'red', '#33ccff', [1, 0.5, 0]", "children:boolean?:Also its children (default true)"),
                ColorTool);
            Define("copy_look",
                "Make one object look like another (skins, avatars): copies sprites, meshes, materials and, by default, the " +
                "animations from from_id onto to_id.",
                S("from_id:integer:Object whose look to copy", "to_id:integer:Object to change",
                  "animation:boolean?:Also copy the animation controller (default true)"),
                CopyLook);
            Define("spawn",
                "Make copies of an object or prefab (collectibles, enemies, props) next to it or next to another object.",
                S("id:integer:What to copy", "count:integer?:How many (default 1, max 50)",
                  "near_id:integer?:Place them next to this object instead (e.g. the player)", "spacing:any?:[x,y,z] between copies (default [1,0,0])"),
                Spawn);
            Define("set_active",
                "Show or hide an object (walls, obstacles, enemies, UI). Hiding is undoable, unlike destroy.",
                S("id:integer:Object id", "active:boolean:true to show, false to hide"),
                SetActive);
            Define("destroy", "Remove an object for good (until the level reloads). Prefer set_active false.",
                S("id:integer:Object id"), DestroyTool);
            Define("world",
                "Game-wide physics and time: time_scale (1 normal, 0.5 slow motion, 2 fast), gravity ([x,y,z] or just y, " +
                "normally -9.81) and gravity_2d ([x,y] or y). Returns the current values; give nothing to just read them.",
                S("time_scale:number?:Game speed", "gravity:any?:3D gravity", "gravity_2d:any?:2D gravity"),
                World);
            Define("load_model",
                "Bring a 3D model into this game from a file (merging games: a character or item exported from another game " +
                "with FModel or AssetRipper, or any model from Blender): .glb, .gltf or .obj on this computer. It appears " +
                "next to an object (e.g. the player) or in front of the camera, sized to fit, drawn with this game's own " +
                "shaders. replace_id makes an object look like the model instead (its scripts and collisions stay). Static " +
                "only: no skeleton or animations. Returns an id for transform, color, spawn, destroy.",
                S("file:string:Full path of the .glb, .gltf or .obj file",
                  "near_id:integer?:Put it next to this object (default: in front of the camera)",
                  "replace_id:integer?:Make this object look like the model instead (hides its own look)",
                  "size:number?:Height in world units (default: the replaced object's height, else 2)",
                  "offset:any?:[x,y,z] from near_id in its own directions (default 2 in front of it)",
                  "rotation:any?:[x,y,z] degrees to turn it",
                  "color:any?:Tint instead of the model's own colors"),
                LoadModel);
            Define("scenes",
                "The levels/maps: which are loaded and which the game has; load one by name or number (this changes the map).",
                S("load:any?:Scene name or build index to load"),
                Scenes);
        }

        static void Define(string name, string description, Dictionary<string, object> schema, Handler run)
        {
            Tools.Add(new Tool { Name = name, Description = description, Schema = schema, Run = run });
        }

        /// <summary>Compact schema: "name:type[?]:description", '?' marks optional; type "any" takes anything.</summary>
        static Dictionary<string, object> S(params string[] fields)
        {
            var props = new Dictionary<string, object>();
            var required = new List<object>();
            foreach (string f in fields)
            {
                string[] p = f.Split(new[] { ':' }, 3);
                string type = p[1].TrimEnd('?');
                var prop = new Dictionary<string, object> { { "description", p[2] } };
                if (type != "any") prop["type"] = type;
                if (type == "array") prop["items"] = new Dictionary<string, object>();
                props[p[0]] = prop;
                if (!p[1].EndsWith("?")) required.Add(p[0]);
            }
            var schema = new Dictionary<string, object> { { "type", "object" }, { "properties", props } };
            if (required.Count > 0) schema["required"] = required;
            return schema;
        }

        public static Dictionary<string, object> Hello()
        {
            return new Dictionary<string, object>
            {
                { "type", "hello" },
                { "name", "Unity bridge: " + Application.productName },
                { "game", "unity" },
                {
                    "description",
                    "Live access inside " + Application.productName + " (Unity " + Application.unityVersion + "): find any object, " +
                    "read and change any field or property (private too), call the game's own methods, recolor, resize, move, " +
                    "copy looks between characters, spawn copies, hide things, change time and gravity, and load levels."
                },
                {
                    "tools",
                    Tools.Select(t => (object)new Dictionary<string, object>
                    {
                        { "name", t.Name }, { "description", t.Description }, { "input_schema", t.Schema },
                    }).ToList()
                },
            };
        }

        public static Dictionary<string, object> Run(Dictionary<string, object> call, MonoBehaviour host)
        {
            object id;
            call.TryGetValue("id", out id);
            object name;
            call.TryGetValue("tool", out name);
            var reply = new Dictionary<string, object> { { "type", "result" }, { "id", id } };
            Tool tool = Tools.FirstOrDefault(t => t.Name == (name as string));
            if (tool == null)
            {
                reply["ok"] = false;
                reply["error"] = "No tool " + name;
                return reply;
            }
            try
            {
                object input;
                call.TryGetValue("input", out input);
                object result = tool.Run(new Args(input), host);
                string json = Json.Write(result);
                reply["ok"] = true;
                reply["content"] = json.Length <= MaxReply
                    ? result
                    : json.Substring(0, MaxReply) + " … (cut off: ask for less, e.g. one component, a filter or a limit)";
            }
            catch (Exception e)
            {
                reply["ok"] = false;
                reply["error"] = Reflect.Unwrap(e).Message;
            }
            return reply;
        }

        // ------------------------------------------------------------------ objects

        static GameObject Obj(Args a, string key)
        {
            if (!a.Has(key)) throw new ArgumentException("Missing \"" + key + "\" (an object id from find).");
            return ById(a.Int(key, 0));
        }

        static GameObject ById(int id)
        {
            GameObject go;
            if (Known.TryGetValue(id, out go) && go != null) return go;
            foreach (Object o in Resources.FindObjectsOfTypeAll(typeof(GameObject)))
            {
                if (o.GetInstanceID() != id) continue;
                go = (GameObject)o;
                Known[id] = go;
                return go;
            }
            throw new ArgumentException("No object with id " + id + ". It may be gone (a new level?); use find again.");
        }

        static int Remember(GameObject go)
        {
            int id = go.GetInstanceID();
            Known[id] = go;
            return id;
        }

        static string PathOf(GameObject go)
        {
            var parts = new List<string>();
            for (Transform t = go.transform; t != null; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return string.Join("/", parts.ToArray());
        }

        static bool TypeMatches(Type t, string query)
        {
            return string.Equals(t.Name, query, StringComparison.OrdinalIgnoreCase) || string.Equals(t.FullName, query, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The component to act on: by exact type name, then partial; "GameObject" means the object itself.</summary>
        static object Target(GameObject go, string component, out Type type)
        {
            if (string.IsNullOrEmpty(component) || string.Equals(component, "GameObject", StringComparison.OrdinalIgnoreCase))
            {
                type = typeof(GameObject);
                return go;
            }
            Component[] all = go.GetComponents<Component>().Where(c => c != null).ToArray();
            Component found = all.FirstOrDefault(c => TypeMatches(c.GetType(), component))
                ?? all.FirstOrDefault(c => c.GetType().Name.IndexOf(component, StringComparison.OrdinalIgnoreCase) >= 0);
            if (found == null)
            {
                throw new ArgumentException(go.name + " has no " + component + ". It has: " +
                    string.Join(", ", all.Select(c => c.GetType().Name).ToArray()) + ". (Children may have it: inspect them.)");
            }
            type = found.GetType();
            return found;
        }

        static object Summary(GameObject go)
        {
            var info = new Dictionary<string, object>
            {
                { "id", Remember(go) },
                { "name", go.name },
                { "path", PathOf(go) },
                { "active", go.activeInHierarchy },
                { "components", go.GetComponents<Component>().Where(c => c != null && !(c is Transform)).Select(c => c.GetType().Name).Take(10).ToList() },
            };
            if (!go.scene.IsValid()) info["asset"] = true;
            return info;
        }

        static object DescribeObject(object value)
        {
            var o = value as Object;
            if (o == null) return "(destroyed)";
            var info = new Dictionary<string, object> { { "ref", o.name }, { "type", o.GetType().Name } };
            var c = o as Component;
            if (c != null) info["id"] = Remember(c.gameObject);
            var go = o as GameObject;
            if (go != null) info["id"] = Remember(go);
            return info;
        }

        /// <summary>Unity object parameters: {"id": 123} for a scene object, or a name ("Coin", "RedMaterial").</summary>
        static object ResolveReference(object json, Type type)
        {
            var dict = json as Dictionary<string, object>;
            if (dict != null && dict.ContainsKey("id"))
            {
                GameObject go = ById(Convert.ToInt32(dict["id"]));
                if (type == typeof(GameObject) || type == typeof(Object)) return go;
                if (typeof(Component).IsAssignableFrom(type))
                {
                    Component c = go.GetComponent(type);
                    if (c == null) throw new ArgumentException(go.name + " has no " + type.Name + ".");
                    return c;
                }
            }
            string name = dict != null && dict.ContainsKey("name") ? Convert.ToString(dict["name"]) : json as string;
            if (name == null) throw new ArgumentException("For a " + type.Name + ", give {\"id\": …} or its name.");
            Object[] all = Resources.FindObjectsOfTypeAll(type);
            Object hit = all.FirstOrDefault(o => o.name == name)
                ?? all.FirstOrDefault(o => string.Equals(o.name, name, StringComparison.OrdinalIgnoreCase))
                ?? all.FirstOrDefault(o => o.name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0);
            if (hit == null) throw new ArgumentException("No " + type.Name + " named \"" + name + "\".");
            return hit;
        }

        // ------------------------------------------------------------------ tools

        static object Find(Args a, MonoBehaviour host)
        {
            string name = a.Str("name"), component = a.Str("component"), tag = a.Str("tag");
            bool inactive = a.Bool("include_inactive", false), assets = a.Bool("include_assets", false);
            int limit = Math.Max(1, Math.Min(a.Int("limit", 30), 100));
            IEnumerable<Object> source = inactive || assets
                ? Resources.FindObjectsOfTypeAll(typeof(GameObject))
                : Object.FindObjectsOfType(typeof(GameObject));
            var hits = new List<GameObject>();
            foreach (Object o in source)
            {
                var go = (GameObject)o;
                if ((go.hideFlags & HideFlags.HideAndDontSave) == HideFlags.HideAndDontSave) continue;
                bool inScene = go.scene.IsValid();
                if (!inScene && !assets) continue;
                if (inScene && !inactive && !go.activeInHierarchy) continue;
                if (name != null && Reflect.Score(go.name, name) == 0) continue;
                if (tag != null && !string.Equals(SafeTag(go), tag, StringComparison.OrdinalIgnoreCase)) continue;
                if (component != null && !go.GetComponents<Component>().Any(c =>
                        c != null && c.GetType().Name.IndexOf(component, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                hits.Add(go);
            }
            // Exact names, then the best matches and top-level objects first: usually what the player means.
            var ordered = hits
                .OrderBy(g => name != null && string.Equals(g.name, name, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenByDescending(g => name != null ? Reflect.Score(g.name, name) : 0)
                .ThenBy(g => g.scene.IsValid() ? 0 : 1)
                .ThenBy(g => Depth(g.transform))
                .Take(limit)
                .Select(Summary)
                .ToList();
            var result = new Dictionary<string, object> { { "count", hits.Count }, { "objects", ordered } };
            if (hits.Count > limit) result["note"] = "Showing " + limit + " of " + hits.Count + "; narrow it with name, component or tag.";
            if (hits.Count == 0) result["note"] = "Nothing matched. Try part of the name, a component type, include_inactive, or types to search the code.";
            return result;
        }

        static int Depth(Transform t)
        {
            int d = 0;
            for (; t.parent != null; t = t.parent) d++;
            return d;
        }

        static string SafeTag(GameObject go)
        {
            try { return go.tag; }
            catch { return ""; }
        }

        static object Inspect(Args a, MonoBehaviour host)
        {
            GameObject go = Obj(a, "id");
            string only = a.Str("component");
            Transform t = go.transform;
            var info = new Dictionary<string, object>
            {
                { "id", Remember(go) },
                { "name", go.name },
                { "path", PathOf(go) },
                { "active", go.activeSelf },
                { "tag", SafeTag(go) },
                { "layer", LayerMask.LayerToName(go.layer) },
                { "position", Reflect.Describe(t.position, 1) },
                { "rotation", Reflect.Describe(t.eulerAngles, 1) },
                { "scale", Reflect.Describe(t.localScale, 1) },
            };
            if (t.parent != null) info["parent"] = new Dictionary<string, object> { { "id", Remember(t.parent.gameObject) }, { "name", t.parent.name } };
            var children = new List<object>();
            for (int i = 0; i < t.childCount && i < 25; i++)
            {
                GameObject child = t.GetChild(i).gameObject;
                children.Add(new Dictionary<string, object> { { "id", Remember(child) }, { "name", child.name } });
            }
            if (t.childCount > 0) info["children"] = children;
            if (t.childCount > 25) info["children_total"] = t.childCount;

            var components = new List<object>();
            foreach (Component c in go.GetComponents<Component>())
            {
                if (c == null || c is Transform) continue;
                if (only != null && !TypeMatches(c.GetType(), only) && c.GetType().Name.IndexOf(only, StringComparison.OrdinalIgnoreCase) < 0) continue;
                components.Add(DescribeComponent(c, only != null));
            }
            info["components"] = components;
            return info;
        }

        static object DescribeComponent(Component c, bool deep)
        {
            Type type = c.GetType();
            bool builtin = type.Namespace != null && type.Namespace.StartsWith("UnityEngine");
            var entry = new Dictionary<string, object> { { "type", type.Name } };
            var behaviour = c as Behaviour;
            if (behaviour != null) entry["enabled"] = behaviour.enabled;
            var members = new Dictionary<string, object>();
            foreach (Reflect.Member m in Reflect.ListMembers(type, false, builtin ? typeof(Component) : typeof(MonoBehaviour), Skip).Take(deep ? 120 : 50))
            {
                // Unity's own components: properties only; their fields are internals.
                if (builtin && m.Field != null) continue;
                object value;
                try { value = Reflect.Describe(m.Get(c), deep ? 2 : 0); }
                catch (Exception e) { value = "(unreadable: " + Reflect.Unwrap(e).Message + ")"; }
                string key = m.Writable ? m.Name : m.Name + " (read-only)";
                members[key] = value;
            }
            entry["values"] = members;
            if (deep)
            {
                entry["methods"] = type.GetMethods(Reflect.Instance | BindingFlags.DeclaredOnly)
                    .Where(mi => !mi.IsSpecialName && !mi.Name.StartsWith("<"))
                    .Select(mi => (object)Reflect.Signature(mi)).Take(40).ToList();
            }
            return entry;
        }

        static object Get(Args a, MonoBehaviour host)
        {
            Type type;
            object target = Root(a, out type);
            string path = a.Str("path");
            if (string.IsNullOrEmpty(path))
            {
                var c = target as Component;
                if (c != null) return DescribeComponent(c, true);
                if (target == null) return StaticSummary(type, 40);
                return Reflect.Describe(target, 2);
            }
            return new Dictionary<string, object> { { "path", path }, { "value", Reflect.Describe(Reflect.Get(target, type, path), 2) } };
        }

        static object Set(Args a, MonoBehaviour host)
        {
            Type type;
            object target = Root(a, out type);
            string path = a.Need("path");
            if (!a.Present("value")) throw new ArgumentException("Missing \"value\".");
            object before = Reflect.Set(target, type, path, a.Raw("value"));
            object after = Reflect.Get(target, type, path);
            return new Dictionary<string, object>
            {
                { "path", path },
                { "before", Reflect.Describe(before, 1) },
                { "after", Reflect.Describe(after, 1) },
            };
        }

        /// <summary>id (+ component) for an object, or type for statics.</summary>
        static object Root(Args a, out Type type)
        {
            if (a.Has("id")) return Target(Obj(a, "id"), a.Str("component"), out type);
            if (a.Has("type"))
            {
                type = Reflect.FindType(a.Str("type"));
                return null;
            }
            throw new ArgumentException("Give id (an object from find) or type (a class name from types).");
        }

        static object Call(Args a, MonoBehaviour host)
        {
            Type type;
            object target = Root(a, out type);
            string path = a.Str("path");
            if (!string.IsNullOrEmpty(path))
            {
                target = Reflect.Get(target, type, path);
                if (target == null) throw new NullReferenceException(path + " is empty (null).");
                type = target.GetType();
            }
            var args = a.Raw("args") as List<object>;
            object result = Reflect.Call(target, type, a.Need("method"), args);
            var routine = result as IEnumerator;
            if (routine != null)
            {
                var owner = target as MonoBehaviour ?? host;
                owner.StartCoroutine(routine);
                return new Dictionary<string, object> { { "result", "started (it runs over the next frames)" } };
            }
            return new Dictionary<string, object> { { "result", Reflect.Describe(result, 1) } };
        }

        static object Types(Args a, MonoBehaviour host)
        {
            string query = a.Str("query", "");
            int limit = Math.Max(1, Math.Min(a.Int("limit", 12), 40));
            if (query.Trim().Length == 0)
            {
                return new Dictionary<string, object>
                {
                    { "singletons", Reflect.Singletons(60) },
                    { "note", "Read one with get (type + path, e.g. 'GameManager' + 'Instance'), or search classes by name with query." },
                };
            }
            var hits = Reflect.AllTypes(true)
                .Where(t => !t.Name.StartsWith("<") && !t.IsGenericTypeDefinition)
                .Select(t => new { t, score = Reflect.Score(t.Name, query) })
                .Where(x => x.score > 0)
                .OrderByDescending(x => x.score)
                .ThenBy(x => x.t.Name.Length)
                .Take(limit)
                .Select(x => StaticSummary(x.t, 12))
                .ToList();
            return new Dictionary<string, object> { { "types", hits }, { "note", hits.Count == 0 ? "No class names match \"" + query + "\". Try other words, or an empty query for the singletons." : null } };
        }

        static object StaticSummary(Type t, int maxMembers)
        {
            var info = new Dictionary<string, object> { { "type", t.FullName } };
            if (t.BaseType != null) info["base"] = t.BaseType.Name;
            if (t.IsEnum)
            {
                info["values"] = Enum.GetNames(t).Take(40).Cast<object>().ToList();
                return info;
            }
            var statics = new Dictionary<string, object>();
            foreach (Reflect.Member m in Reflect.ListMembers(t, true, null, null).Take(maxMembers))
            {
                // Reading a static property can run game code (singletons that create themselves), so
                // only fields are read here; properties are read when asked for with get.
                if (m.Property != null)
                {
                    statics[m.Name] = "(property: read it with get)";
                    continue;
                }
                try { statics[m.Name] = Reflect.Describe(m.Get(null), 0); }
                catch (Exception e) { statics[m.Name] = "(unreadable: " + Reflect.Unwrap(e).Message + ")"; }
            }
            if (statics.Count > 0) info["static"] = statics;
            if (typeof(Object).IsAssignableFrom(t) && !t.IsAbstract && !t.ContainsGenericParameters)
            {
                Object[] live = Object.FindObjectsOfType(t);
                info["in_level"] = live.Length;
                if (live.Length > 0)
                {
                    info["ids"] = live.Take(8).Select(o =>
                    {
                        var c = o as Component;
                        return c != null ? (object)Remember(c.gameObject) : o.GetInstanceID();
                    }).ToList();
                }
            }
            info["methods"] = t.GetMethods(Reflect.Instance | Reflect.Static | BindingFlags.DeclaredOnly)
                .Where(mi => !mi.IsSpecialName && !mi.Name.StartsWith("<"))
                .Select(mi => (object)mi.Name).Distinct().Take(25).ToList();
            return info;
        }

        static object TransformTool(Args a, MonoBehaviour host)
        {
            GameObject go = Obj(a, "id");
            Transform t = go.transform;
            bool relative = a.Bool("relative", false), local = a.Bool("local", false);
            if (a.Has("position"))
            {
                var v = (Vector3)Reflect.Convert(a.Raw("position"), typeof(Vector3));
                if (relative) v += local ? t.localPosition : t.position;
                if (local) t.localPosition = v; else t.position = v;
                // A physics body would snap it back next step; move that too.
                SetIfPresent(go, "Rigidbody", "position", t.position);
                SetIfPresent(go, "Rigidbody2D", "position", new Vector2(t.position.x, t.position.y));
            }
            if (a.Has("rotation"))
            {
                var e = (Vector3)Reflect.Convert(a.Raw("rotation"), typeof(Vector3));
                if (relative) e += local ? t.localEulerAngles : t.eulerAngles;
                if (local) t.localEulerAngles = e; else t.eulerAngles = e;
            }
            if (a.Has("scale"))
            {
                var s = (Vector3)Reflect.Convert(a.Raw("scale"), typeof(Vector3));
                if (relative) s = Vector3.Scale(t.localScale, s);
                t.localScale = s;
            }
            return new Dictionary<string, object>
            {
                { "position", Reflect.Describe(t.position, 1) },
                { "rotation", Reflect.Describe(t.eulerAngles, 1) },
                { "scale", Reflect.Describe(t.localScale, 1) },
            };
        }

        static void SetIfPresent(GameObject go, string componentType, string member, object value)
        {
            Component c = go.GetComponents<Component>().FirstOrDefault(x => x != null && x.GetType().Name == componentType);
            if (c == null) return;
            try
            {
                Reflect.Member m = Reflect.FindMember(c.GetType(), member, false);
                if (m != null) m.Set(c, value);
            }
            catch { }
        }

        static object ColorTool(Args a, MonoBehaviour host)
        {
            GameObject go = Obj(a, "id");
            var color = (UnityEngine.Color)Reflect.Convert(a.Raw("color"), typeof(UnityEngine.Color));
            Component[] targets = a.Bool("children", true) ? go.GetComponentsInChildren<Component>(true) : go.GetComponents<Component>();
            int changed = 0;
            var what = new HashSet<string>();
            foreach (Component c in targets)
            {
                if (c == null) continue;
                PropertyInfo p = c.GetType().GetProperty("color", BindingFlags.Public | BindingFlags.Instance);
                if (p != null && p.PropertyType == typeof(UnityEngine.Color) && p.GetSetMethod() != null)
                {
                    p.SetValue(c, color, null); // SpriteRenderer, UI Image/Text, Light, TextMesh...
                    changed++;
                    what.Add(c.GetType().Name);
                    continue;
                }
                var r = c as Renderer;
                if (r == null) continue;
                foreach (Material m in r.materials) // this object's own copies, so others keep their look
                {
                    foreach (string prop in new[] { "_Color", "_BaseColor", "_TintColor", "_MainColor" })
                    {
                        if (!m.HasProperty(prop)) continue;
                        m.SetColor(prop, color);
                        changed++;
                        what.Add(c.GetType().Name);
                        break;
                    }
                }
            }
            if (changed == 0) throw new InvalidOperationException(go.name + " has nothing colorable (no sprite, UI, light or material with a color). Try its children or parent.");
            return new Dictionary<string, object> { { "changed", changed }, { "on", what.ToList() } };
        }

        static object CopyLook(Args a, MonoBehaviour host)
        {
            GameObject from = Obj(a, "from_id"), to = Obj(a, "to_id");
            var copied = new List<object>();
            SpriteRenderer fs = from.GetComponentInChildren<SpriteRenderer>(true), ts = to.GetComponentInChildren<SpriteRenderer>(true);
            if (fs != null && ts != null)
            {
                ts.sprite = fs.sprite;
                ts.color = fs.color;
                copied.Add("sprite");
            }
            MeshFilter fm = from.GetComponentInChildren<MeshFilter>(true), tm = to.GetComponentInChildren<MeshFilter>(true);
            if (fm != null && tm != null)
            {
                tm.sharedMesh = fm.sharedMesh;
                copied.Add("mesh");
            }
            SkinnedMeshRenderer fk = from.GetComponentInChildren<SkinnedMeshRenderer>(true), tk = to.GetComponentInChildren<SkinnedMeshRenderer>(true);
            if (fk != null && tk != null)
            {
                tk.sharedMesh = fk.sharedMesh;
                tk.sharedMaterials = fk.sharedMaterials;
                copied.Add("skinned mesh");
            }
            Renderer fr = from.GetComponentsInChildren<Renderer>(true).FirstOrDefault(r => !(r is SpriteRenderer));
            Renderer tr = to.GetComponentsInChildren<Renderer>(true).FirstOrDefault(r => !(r is SpriteRenderer));
            if (fr != null && tr != null)
            {
                tr.sharedMaterials = fr.sharedMaterials;
                copied.Add("materials");
            }
            // UI images (and anything else with a sprite property).
            Component fi = from.GetComponentsInChildren<Component>(true).FirstOrDefault(c => c != null && !(c is SpriteRenderer) && HasSprite(c));
            Component ti = to.GetComponentsInChildren<Component>(true).FirstOrDefault(c => c != null && !(c is SpriteRenderer) && HasSprite(c));
            if (fi != null && ti != null && fi.GetType() == ti.GetType())
            {
                PropertyInfo p = fi.GetType().GetProperty("sprite");
                p.SetValue(ti, p.GetValue(fi, null), null);
                copied.Add("UI sprite");
            }
            if (a.Bool("animation", true))
            {
                Animator fa = from.GetComponentInChildren<Animator>(true), ta = to.GetComponentInChildren<Animator>(true);
                if (fa != null && ta != null)
                {
                    // Sprite animations would otherwise put the old look straight back.
                    ta.runtimeAnimatorController = fa.runtimeAnimatorController;
                    if (fa.avatar != null) ta.avatar = fa.avatar;
                    copied.Add("animations");
                }
            }
            if (copied.Count == 0) throw new InvalidOperationException("Found nothing to copy: the two objects don't share a kind of visual (sprite, mesh, material).");
            return new Dictionary<string, object> { { "copied", copied } };
        }

        static bool HasSprite(Component c)
        {
            PropertyInfo p = c.GetType().GetProperty("sprite", BindingFlags.Public | BindingFlags.Instance);
            return p != null && p.PropertyType == typeof(Sprite) && p.GetSetMethod() != null;
        }

        static object Spawn(Args a, MonoBehaviour host)
        {
            GameObject source = Obj(a, "id");
            int count = Math.Max(1, Math.Min(a.Int("count", 1), 50));
            Transform anchor = a.Has("near_id") ? Obj(a, "near_id").transform : source.transform;
            Vector3 spacing = a.Has("spacing") ? (Vector3)Reflect.Convert(a.Raw("spacing"), typeof(Vector3)) : Vector3.right;
            Transform parent = source.scene.IsValid() ? source.transform.parent : null;
            var ids = new List<object>();
            for (int i = 1; i <= count; i++)
            {
                var copy = (GameObject)Object.Instantiate(source, anchor.position + spacing * i, source.transform.rotation);
                if (parent != null) copy.transform.SetParent(parent, true);
                copy.name = source.name;
                copy.SetActive(true);
                ids.Add(Remember(copy));
            }
            return new Dictionary<string, object> { { "spawned", ids.Count }, { "ids", ids } };
        }

        static object SetActive(Args a, MonoBehaviour host)
        {
            GameObject go = Obj(a, "id");
            go.SetActive(a.Bool("active", true));
            return new Dictionary<string, object> { { "name", go.name }, { "active", go.activeSelf } };
        }

        static object DestroyTool(Args a, MonoBehaviour host)
        {
            GameObject go = Obj(a, "id");
            string name = go.name;
            Object.Destroy(go);
            return "Removed " + name + ".";
        }

        static object World(Args a, MonoBehaviour host)
        {
            if (a.Has("time_scale")) Time.timeScale = Mathf.Max(0f, (float)a.Num("time_scale").Value);
            var info = new Dictionary<string, object> { { "time_scale", Math.Round(Time.timeScale, 3) } };
            // Physics lives in optional modules; reach it by name so games without one still work.
            Gravity(a, "gravity", "UnityEngine.Physics", typeof(Vector3), info);
            Gravity(a, "gravity_2d", "UnityEngine.Physics2D", typeof(Vector2), info);
            return info;
        }

        static void Gravity(Args a, string key, string typeName, Type vectorType, Dictionary<string, object> info)
        {
            Type physics = UnityType(typeName);
            PropertyInfo g = physics != null ? physics.GetProperty("gravity", BindingFlags.Public | BindingFlags.Static) : null;
            if (g == null)
            {
                if (a.Has(key)) throw new InvalidOperationException("This game doesn't use " + typeName + ".");
                return;
            }
            if (a.Has(key))
            {
                object raw = a.Raw(key);
                // Just a number: that's "down", the y part.
                if (raw is double) raw = vectorType == typeof(Vector3) ? new List<object> { 0.0, raw, 0.0 } : new List<object> { 0.0, raw };
                g.SetValue(null, Reflect.Convert(raw, vectorType), null);
            }
            info[key] = Reflect.Describe(g.GetValue(null, null), 1);
        }

        static Type UnityType(string fullName)
        {
            Type t;
            if (UnityTypes.TryGetValue(fullName, out t)) return t;
            t = null;
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (!asm.GetName().Name.StartsWith("UnityEngine")) continue;
                t = asm.GetType(fullName, false);
                if (t != null) break;
            }
            UnityTypes[fullName] = t;
            return t;
        }

        // ------------------------------------------------------------------ models

        static readonly PropertyInfo IndexFormatProperty = typeof(Mesh).GetProperty("indexFormat");

        static object LoadModel(Args a, MonoBehaviour host)
        {
            string file = a.Need("file").Trim().Trim('"');
            List<ModelPart> parts = ModelFile.Load(file);
            GameObject replace = a.Has("replace_id") ? Obj(a, "replace_id") : null;
            Shader shader = PickShader(replace);
            bool tint = a.Has("color");
            UnityEngine.Color tintColor = tint ? (UnityEngine.Color)Reflect.Convert(a.Raw("color"), typeof(UnityEngine.Color)) : UnityEngine.Color.white;

            float[] b = ModelFile.Bounds(parts);
            // The model's own origin moves to its bottom center, so "next to" and "size" mean what they say.
            var pivot = new Vector3((b[0] + b[3]) / 2f, b[1], (b[2] + b[5]) / 2f);
            var root = new GameObject("Telos model: " + Path.GetFileNameWithoutExtension(file));
            var textures = new Dictionary<byte[], Texture2D>();
            int meshes = 0, vertices = 0, textured = 0;
            foreach (ModelPart whole in parts)
            {
                // Unity before 2017.3 has 16-bit mesh indices; split big parts for it.
                List<ModelPart> pieces = IndexFormatProperty != null ? new List<ModelPart> { whole } : ModelFile.Split(whole, 65000);
                foreach (ModelPart p in pieces)
                {
                    var go = new GameObject(string.IsNullOrEmpty(p.Name) ? "part" : p.Name);
                    go.transform.SetParent(root.transform, false);
                    go.transform.localPosition = -pivot;
                    var mesh = new Mesh { name = go.name };
                    if (p.VertexCount > 65000) IndexFormatProperty.SetValue(mesh, Enum.ToObject(IndexFormatProperty.PropertyType, 1), null);
                    mesh.vertices = Vectors3(p.Positions);
                    if (p.UVs != null) mesh.uv = Vectors2(p.UVs);
                    mesh.triangles = p.Indices;
                    if (p.Normals != null) mesh.normals = Vectors3(p.Normals);
                    else mesh.RecalculateNormals();
                    mesh.RecalculateBounds();
                    go.AddComponent<MeshFilter>().sharedMesh = mesh;
                    var material = new Material(shader);
                    PaintMaterial(material, tint ? tintColor : new UnityEngine.Color(p.Color[0], p.Color[1], p.Color[2], p.Color[3]));
                    if (p.Texture != null && !tint)
                    {
                        Texture2D tex;
                        if (!textures.TryGetValue(p.Texture, out tex)) textures[p.Texture] = tex = LoadTexture(p.Texture);
                        if (tex != null && TextureMaterial(material, tex)) textured++;
                    }
                    go.AddComponent<MeshRenderer>().sharedMaterial = material;
                    meshes++;
                    vertices += p.VertexCount;
                }
            }

            float height = b[4] - b[1], extent = Math.Max(b[3] - b[0], Math.Max(height, b[5] - b[2]));
            Bounds replaced = replace != null ? RenderBounds(replace) : new Bounds();
            float size = a.Has("size")
                ? (float)a.Num("size").Value
                : replace != null && replaced.size.y > 0.01f ? replaced.size.y : 2f;
            float scale = height > 1e-5f ? size / height : extent > 1e-5f ? size / extent : 1f;
            root.transform.localScale = Vector3.one * scale;

            int hidden = 0;
            if (replace != null)
            {
                Vector3 bottom = replaced.size == Vector3.zero ? replace.transform.position : new Vector3(replaced.center.x, replaced.min.y, replaced.center.z);
                root.transform.position = bottom;
                root.transform.rotation = replace.transform.rotation;
                foreach (Renderer r in replace.GetComponentsInChildren<Renderer>(true))
                {
                    if (!r.enabled) continue;
                    r.enabled = false;
                    hidden++;
                }
                // Moves and turns with the object it replaces.
                root.transform.SetParent(replace.transform, true);
            }
            else
            {
                Transform anchor = a.Has("near_id") ? Obj(a, "near_id").transform : (Camera.main != null ? Camera.main.transform : null);
                if (anchor != null)
                {
                    Vector3 offset = a.Has("offset") ? (Vector3)Reflect.Convert(a.Raw("offset"), typeof(Vector3)) : new Vector3(0, 0, a.Has("near_id") ? 2f : 5f);
                    root.transform.position = anchor.position + anchor.rotation * offset;
                    // Upright, facing the same way as the anchor (a tilted camera shouldn't tilt the model).
                    root.transform.rotation = Quaternion.Euler(0, anchor.eulerAngles.y, 0);
                }
            }
            if (a.Has("rotation")) root.transform.rotation *= Quaternion.Euler((Vector3)Reflect.Convert(a.Raw("rotation"), typeof(Vector3)));

            var result = new Dictionary<string, object>
            {
                { "id", Remember(root) },
                { "name", root.name },
                { "meshes", meshes },
                { "vertices", vertices },
                { "textured_parts", textured },
                { "shader", shader.name },
                { "height", Math.Round(size, 2) },
                { "position", Reflect.Describe(root.transform.position, 1) },
            };
            if (replace != null)
            {
                result["replaced"] = replace.name;
                result["hidden_renderers"] = hidden;
                result["note"] = "set_active false on this id and set the replaced object's renderers back on (or reload the level) to undo.";
            }
            if (textured == 0 && parts.Exists(p => p.Texture != null) && !tint) result["textures"] = "The model has textures this game couldn't load (it only takes PNG and JPEG); it shows its base colors.";
            return result;
        }

        static Vector3[] Vectors3(float[] f)
        {
            var v = new Vector3[f.Length / 3];
            for (int i = 0; i < v.Length; i++) v[i] = new Vector3(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
            return v;
        }

        static Vector2[] Vectors2(float[] f)
        {
            var v = new Vector2[f.Length / 2];
            for (int i = 0; i < v.Length; i++) v[i] = new Vector2(f[i * 2], f[i * 2 + 1]);
            return v;
        }

        static Bounds RenderBounds(GameObject go)
        {
            Renderer[] rs = go.GetComponentsInChildren<Renderer>(false);
            if (rs.Length == 0) return new Bounds(go.transform.position, Vector3.zero);
            Bounds b = rs[0].bounds;
            foreach (Renderer r in rs) b.Encapsulate(r.bounds);
            return b;
        }

        /// <summary>
        /// A shader this game draws with: one of its own (they're guaranteed to be in the build and to
        /// suit its render pipeline), preferring ordinary lit ones; Shader.Find only as a fallback.
        /// </summary>
        static Shader PickShader(GameObject like)
        {
            var seen = new List<Shader>();
            IEnumerable<Renderer> renderers = like != null
                ? like.GetComponentsInChildren<Renderer>(true)
                : Object.FindObjectsOfType<MeshRenderer>().Cast<Renderer>().Concat(Object.FindObjectsOfType<SkinnedMeshRenderer>().Cast<Renderer>());
            foreach (Renderer r in renderers)
            {
                if (r == null || r is SpriteRenderer) continue;
                foreach (Material m in r.sharedMaterials)
                {
                    if (m == null || m.shader == null || seen.Contains(m.shader) || m.shader.name.StartsWith("Hidden")) continue;
                    if (!m.HasProperty("_MainTex") && !m.HasProperty("_BaseMap") && !m.HasProperty("_BaseColorMap")) continue;
                    seen.Add(m.shader);
                    if (seen.Count >= 200) break;
                }
            }
            string[] ordinary = { "Standard", "/Lit", "Lit", "Diffuse", "Toon", "Simple" };
            foreach (string word in ordinary)
            {
                Shader s = seen.FirstOrDefault(x => x.name.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0 && x.name.IndexOf("Transparent", StringComparison.OrdinalIgnoreCase) < 0);
                if (s != null) return s;
            }
            if (seen.Count > 0) return seen[0];
            foreach (string name in new[] { "Standard", "Universal Render Pipeline/Lit", "HDRP/Lit", "Legacy Shaders/Diffuse", "Diffuse", "Mobile/Diffuse", "Unlit/Texture", "Sprites/Default" })
            {
                Shader s = Shader.Find(name);
                if (s != null) return s;
            }
            throw new InvalidOperationException("This game has no shader Telos can draw a model with (no 3D objects in this level?). Try again in a level with 3D objects.");
        }

        static void PaintMaterial(Material m, UnityEngine.Color color)
        {
            foreach (string prop in new[] { "_Color", "_BaseColor", "_TintColor", "_MainColor" })
                if (m.HasProperty(prop)) m.SetColor(prop, color);
        }

        static bool TextureMaterial(Material m, Texture2D tex)
        {
            bool any = false;
            foreach (string prop in new[] { "_MainTex", "_BaseMap", "_BaseColorMap" })
            {
                if (!m.HasProperty(prop)) continue;
                m.SetTexture(prop, tex);
                any = true;
            }
            return any;
        }

        /// <summary>PNG/JPEG bytes to a texture. Unity 2017.1 moved LoadImage to ImageConversion; older ones have it on Texture2D.</summary>
        static Texture2D LoadTexture(byte[] data)
        {
            var tex = new Texture2D(2, 2);
            bool ok = false;
            Type conv = UnityType("UnityEngine.ImageConversion");
            MethodInfo m = conv != null ? conv.GetMethod("LoadImage", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Texture2D), typeof(byte[]) }, null) : null;
            try
            {
                if (m != null) ok = (bool)m.Invoke(null, new object[] { tex, data });
                else
                {
                    MethodInfo im = typeof(Texture2D).GetMethod("LoadImage", new[] { typeof(byte[]) });
                    if (im != null) ok = (bool)im.Invoke(tex, new object[] { data });
                }
            }
            catch (Exception e)
            {
                Runner.Log.LogWarning("Couldn't load a model texture: " + Reflect.Unwrap(e).Message);
            }
            if (ok) return tex;
            Object.Destroy(tex);
            return null;
        }

        static object Scenes(Args a, MonoBehaviour host)
        {
            if (a.Has("load"))
            {
                object load = a.Raw("load");
                if (load is double) SceneManager.LoadScene(Convert.ToInt32(load));
                else SceneManager.LoadScene(Convert.ToString(load));
                return "Loading " + load + ". Objects from the old level are gone; use find again once it's loaded.";
            }
            var loaded = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene s = SceneManager.GetSceneAt(i);
                loaded.Add(new Dictionary<string, object> { { "name", s.name }, { "index", s.buildIndex }, { "objects", s.rootCount } });
            }
            var all = new List<object>();
            for (int i = 0; i < SceneManager.sceneCountInBuildSettings; i++)
                all.Add(i + ": " + Path.GetFileNameWithoutExtension(SceneUtility.GetScenePathByBuildIndex(i)));
            return new Dictionary<string, object> { { "loaded", loaded }, { "in_game", all } };
        }
    }
}
