using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;

namespace ScruffBridge
{
    /// <summary>
    /// Reads and changes any field, property or method on the game's objects by name, including
    /// private ones and nested paths ("stats.maxHealth", "inventory[2].count"), and converts
    /// between JSON and the game's types. Knows Unity types only by name, so it has no engine
    /// dependency (and can be tested on plain .NET).
    /// </summary>
    public static class Reflect
    {
        public const BindingFlags Instance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        public const BindingFlags Static = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

        /// <summary>Turns {"id": 123} or a name into a Unity object of the wanted type (set by the Unity side).</summary>
        public static Func<object, Type, object> ObjectResolver;
        /// <summary>Describes a Unity object reference (name, type, id), set by the Unity side.</summary>
        public static Func<object, object> ObjectDescriber;

        static readonly HashSet<string> SkipAssemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "mscorlib", "System", "System.Core", "System.Xml", "System.Data", "System.Configuration", "Mono.Security",
            "netstandard", "BepInEx", "BepInEx.Preloader", "BepInEx.Harmony", "0Harmony", "HarmonyXInterop",
            "MonoMod.RuntimeDetour", "MonoMod.Utils", "Mono.Cecil", "ScruffBridge",
        };

        // ------------------------------------------------------------------ members

        public class Member
        {
            public string Name;
            public Type Type;
            public FieldInfo Field;
            public PropertyInfo Property;
            public bool IsStatic;

            public bool Writable
            {
                get { return Field != null ? !Field.IsInitOnly && !Field.IsLiteral : Property.GetSetMethod(true) != null; }
            }

            public object Get(object target)
            {
                return Field != null ? Field.GetValue(target) : Property.GetValue(target, null);
            }

            public void Set(object target, object value)
            {
                if (Field != null)
                {
                    if (Field.IsLiteral) throw new InvalidOperationException(Name + " is a constant.");
                    Field.SetValue(target, value);
                }
                else
                {
                    if (Property.GetSetMethod(true) == null) throw new InvalidOperationException(Name + " can't be set (read-only).");
                    Property.SetValue(target, value, null);
                }
            }
        }

        /// <summary>A field or property by name: exact first, then any case, then auto-property backing fields.</summary>
        public static Member FindMember(Type type, string name, bool isStatic)
        {
            BindingFlags flags = isStatic ? Static : Instance;
            foreach (bool ignoreCase in new[] { false, true })
            {
                for (Type t = type; t != null; t = t.BaseType)
                {
                    foreach (FieldInfo f in t.GetFields(flags | BindingFlags.DeclaredOnly))
                    {
                        string shown = CleanName(f.Name);
                        if (string.Equals(shown, name, ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                        {
                            // Prefer the property over its compiler-made backing field when both exist.
                            if (shown != f.Name)
                            {
                                PropertyInfo p = t.GetProperty(shown, flags | BindingFlags.DeclaredOnly);
                                if (p != null && p.GetIndexParameters().Length == 0 && p.GetSetMethod(true) != null) return FromProperty(p, isStatic);
                            }
                            return new Member { Name = shown, Type = f.FieldType, Field = f, IsStatic = isStatic };
                        }
                    }
                    foreach (PropertyInfo p in t.GetProperties(flags | BindingFlags.DeclaredOnly))
                    {
                        if (p.GetIndexParameters().Length == 0 && p.GetGetMethod(true) != null &&
                            string.Equals(p.Name, name, ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                            return FromProperty(p, isStatic);
                    }
                }
            }
            return null;
        }

        static Member FromProperty(PropertyInfo p, bool isStatic)
        {
            return new Member { Name = p.Name, Type = p.PropertyType, Property = p, IsStatic = isStatic };
        }

        static string CleanName(string name)
        {
            // Auto-properties compile to "<Health>k__BackingField".
            if (name.Length > 2 && name[0] == '<')
            {
                int end = name.IndexOf('>');
                if (end > 1) return name.Substring(1, end - 1);
            }
            return name;
        }

        /// <summary>Everything worth showing on an object: fields (private too) and simple properties.</summary>
        public static List<Member> ListMembers(Type type, bool isStatic, Type stopAt, ICollection<string> skip)
        {
            BindingFlags flags = (isStatic ? Static : Instance) | BindingFlags.DeclaredOnly;
            var seen = new HashSet<string>();
            var list = new List<Member>();
            for (Type t = type; t != null && t != stopAt && t != typeof(object); t = t.BaseType)
            {
                foreach (FieldInfo f in t.GetFields(flags))
                {
                    string name = CleanName(f.Name);
                    if (f.Name.Contains("$") || f.Name.StartsWith("<>") || !seen.Add(name)) continue;
                    if (skip != null && skip.Contains(name)) continue;
                    list.Add(new Member { Name = name, Type = f.FieldType, Field = f, IsStatic = isStatic });
                }
                foreach (PropertyInfo p in t.GetProperties(flags))
                {
                    if (p.GetIndexParameters().Length != 0 || p.GetGetMethod(true) == null || !seen.Add(p.Name)) continue;
                    if (skip != null && skip.Contains(p.Name)) continue;
                    list.Add(FromProperty(p, isStatic));
                }
            }
            return list;
        }

        // ------------------------------------------------------------------ paths

        struct Segment
        {
            public string Name;
            public int Index; // -1: none
        }

        static List<Segment> ParsePath(string path)
        {
            var segs = new List<Segment>();
            foreach (string raw in path.Split('.'))
            {
                string part = raw.Trim();
                if (part.Length == 0) continue;
                int open = part.IndexOf('[');
                if (open < 0) { segs.Add(new Segment { Name = part, Index = -1 }); continue; }
                string name = part.Substring(0, open);
                int index = int.Parse(part.Substring(open + 1, part.IndexOf(']') - open - 1), CultureInfo.InvariantCulture);
                if (name.Length > 0) segs.Add(new Segment { Name = name, Index = -1 });
                segs.Add(new Segment { Name = null, Index = index });
            }
            if (segs.Count == 0) throw new ArgumentException("Empty path.");
            return segs;
        }

        /// <summary>Reads a dotted path. `target` is null for a static path on `type`.</summary>
        public static object Get(object target, Type type, string path)
        {
            object current = target;
            Type currentType = type;
            bool isStatic = target == null;
            foreach (Segment seg in ParsePath(path))
            {
                if (seg.Name == null)
                {
                    current = ElementAt(current, seg.Index);
                }
                else
                {
                    Member m = FindMember(currentType, seg.Name, isStatic);
                    if (m == null) throw new MissingMemberException(Describe(currentType) + " has no \"" + seg.Name + "\". " + Suggest(currentType, isStatic, seg.Name));
                    current = m.Get(current);
                }
                isStatic = false;
                if (current == null) return null;
                currentType = current.GetType();
            }
            return current;
        }

        /// <summary>Sets a dotted path, writing structs (Vector3 and the like) back up the chain. Returns the old value.</summary>
        public static object Set(object target, Type type, string path, object json)
        {
            List<Segment> segs = ParsePath(path);
            object before;
            SetAt(target, type, target == null, segs, 0, json, out before);
            return before;
        }

        static object SetAt(object obj, Type type, bool isStatic, List<Segment> segs, int i, object json, out object before)
        {
            Segment seg = segs[i];
            bool last = i == segs.Count - 1;
            if (seg.Name == null)
            {
                IList list = obj as IList;
                if (list == null) throw new ArgumentException("[" + seg.Index + "] needs a list or array.");
                if (seg.Index < 0 || seg.Index >= list.Count) throw new ArgumentOutOfRangeException("Index " + seg.Index + " is outside 0.." + (list.Count - 1) + ".");
                Type elementType = ElementType(list.GetType()) ?? (list[seg.Index] != null ? list[seg.Index].GetType() : typeof(object));
                if (last)
                {
                    before = list[seg.Index];
                    list[seg.Index] = Convert(json, elementType);
                }
                else
                {
                    object element = list[seg.Index];
                    if (element == null) throw new NullReferenceException("Item " + seg.Index + " is empty.");
                    list[seg.Index] = SetAt(element, element.GetType(), false, segs, i + 1, json, out before);
                }
                return obj;
            }

            Member m = FindMember(type, seg.Name, isStatic);
            if (m == null) throw new MissingMemberException(Describe(type) + " has no \"" + seg.Name + "\". " + Suggest(type, isStatic, seg.Name));
            if (last)
            {
                before = m.Get(obj);
                m.Set(obj, Convert(json, m.Type));
                return obj;
            }
            object child = m.Get(obj);
            if (child == null) throw new NullReferenceException(m.Name + " is empty (null), so nothing inside it can be set.");
            object updated = SetAt(child, child.GetType(), false, segs, i + 1, json, out before);
            // Structs are copies: put the changed copy back.
            if (child.GetType().IsValueType) m.Set(obj, updated);
            return obj;
        }

        static object ElementAt(object obj, int index)
        {
            IList list = obj as IList;
            if (list != null)
            {
                if (index < 0 || index >= list.Count) throw new ArgumentOutOfRangeException("Index " + index + " is outside 0.." + (list.Count - 1) + ".");
                return list[index];
            }
            IEnumerable seq = obj as IEnumerable;
            if (seq != null)
            {
                int n = 0;
                foreach (object item in seq) if (n++ == index) return item;
                throw new ArgumentOutOfRangeException("Index " + index + " is past the end.");
            }
            throw new ArgumentException("[" + index + "] needs a list or array.");
        }

        static Type ElementType(Type listType)
        {
            if (listType.IsArray) return listType.GetElementType();
            foreach (Type i in listType.GetInterfaces())
                if (i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>)) return i.GetGenericArguments()[0];
            return null;
        }

        static string Suggest(Type type, bool isStatic, string wanted)
        {
            var names = ListMembers(type, isStatic, null, null).Select(m => m.Name).ToList();
            var close = names.Where(n => Similar(n, wanted)).Take(8).ToList();
            var shown = (close.Count > 0 ? close : names.Take(25)).ToArray();
            return shown.Length == 0 ? "It has no fields." : (close.Count > 0 ? "Did you mean: " : "It has: ") + string.Join(", ", shown);
        }

        /// <summary>Close enough to be a typo or a partial name: "speeed" → speed, "hp" → maxHp.</summary>
        static bool Similar(string name, string wanted)
        {
            string a = name.ToLowerInvariant(), b = wanted.ToLowerInvariant();
            if (a.Contains(b) || b.Contains(a)) return true;
            return Distance(a, b) <= Math.Max(1, Math.Min(a.Length, b.Length) / 4);
        }

        static int Distance(string a, string b)
        {
            var prev = new int[b.Length + 1];
            var cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
                var t = prev; prev = cur; cur = t;
            }
            return prev[b.Length];
        }

        // ------------------------------------------------------------------ methods

        public static object Call(object target, Type type, string method, List<object> args)
        {
            args = args ?? new List<object>();
            BindingFlags flags = target == null ? Static : Instance;
            var candidates = new List<MethodInfo>();
            for (Type t = type; t != null; t = t.BaseType)
                foreach (MethodInfo mi in t.GetMethods(flags | BindingFlags.DeclaredOnly))
                    if (string.Equals(mi.Name, method, StringComparison.OrdinalIgnoreCase) && !mi.IsGenericMethodDefinition) candidates.Add(mi);
            if (candidates.Count == 0)
            {
                var names = new HashSet<string>();
                for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
                    foreach (MethodInfo mi in t.GetMethods(flags | BindingFlags.DeclaredOnly))
                        if (!mi.IsSpecialName && !mi.Name.StartsWith("<")) names.Add(mi.Name);
                var close = names.Where(n => Similar(n, method)).Take(10).ToArray();
                throw new MissingMethodException(Describe(type) + " has no method \"" + method + "\". " +
                    (close.Length > 0 ? "Did you mean: " + string.Join(", ", close) : "It has: " + string.Join(", ", names.Take(30).ToArray())));
            }
            Exception lastError = null;
            foreach (MethodInfo mi in candidates.OrderBy(m => Math.Abs(m.GetParameters().Length - args.Count)))
            {
                ParameterInfo[] ps = mi.GetParameters();
                int required = ps.Count(p => !p.IsOptional);
                if (args.Count < required || args.Count > ps.Length) continue;
                object[] values = new object[ps.Length];
                try
                {
                    for (int k = 0; k < ps.Length; k++)
                        values[k] = k < args.Count ? Convert(args[k], ps[k].ParameterType) : ps[k].DefaultValue;
                }
                catch (Exception e)
                {
                    lastError = e;
                    continue;
                }
                try
                {
                    return mi.Invoke(target, values);
                }
                catch (TargetInvocationException e)
                {
                    throw new InvalidOperationException("The game's " + mi.Name + " failed: " + (e.InnerException ?? e).Message);
                }
            }
            throw new ArgumentException("No version of " + method + " takes those arguments. It takes: " +
                string.Join(" | ", candidates.Select(Signature).ToArray()) + (lastError != null ? " (" + lastError.Message + ")" : ""));
        }

        public static string Signature(MethodInfo mi)
        {
            return mi.Name + "(" + string.Join(", ", mi.GetParameters().Select(p => Describe(p.ParameterType) + " " + p.Name).ToArray()) + ")";
        }

        // ------------------------------------------------------------------ JSON → game types

        static readonly Dictionary<string, float[]> NamedColors = new Dictionary<string, float[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "red", new[] { 1f, 0f, 0f } }, { "green", new[] { 0f, 1f, 0f } }, { "blue", new[] { 0f, 0f, 1f } },
            { "white", new[] { 1f, 1f, 1f } }, { "black", new[] { 0f, 0f, 0f } }, { "yellow", new[] { 1f, 0.92f, 0.016f } },
            { "cyan", new[] { 0f, 1f, 1f } }, { "magenta", new[] { 1f, 0f, 1f } }, { "gray", new[] { 0.5f, 0.5f, 0.5f } },
            { "grey", new[] { 0.5f, 0.5f, 0.5f } }, { "orange", new[] { 1f, 0.5f, 0f } }, { "purple", new[] { 0.5f, 0f, 0.5f } },
            { "pink", new[] { 1f, 0.41f, 0.71f } }, { "brown", new[] { 0.6f, 0.3f, 0.1f } }, { "gold", new[] { 1f, 0.84f, 0f } },
        };

        public static object Convert(object json, Type t)
        {
            if (t == typeof(object)) return json;
            Type nullable = Nullable.GetUnderlyingType(t);
            if (nullable != null) return json == null ? null : Convert(json, nullable);
            if (json == null)
            {
                if (t.IsValueType) throw new ArgumentException("A " + Describe(t) + " can't be empty.");
                return null;
            }
            if (t == typeof(string)) return json is string ? json : Json.Write(json);
            if (t == typeof(bool))
            {
                if (json is bool) return json;
                if (json is double) return (double)json != 0;
                string s = json.ToString().Trim().ToLowerInvariant();
                if (s == "true" || s == "yes" || s == "on" || s == "1") return true;
                if (s == "false" || s == "no" || s == "off" || s == "0") return false;
                throw new ArgumentException("\"" + json + "\" isn't true or false.");
            }
            if (t.IsEnum)
            {
                if (json is double) return Enum.ToObject(t, System.Convert.ToInt64(json));
                string s = json.ToString();
                try { return Enum.Parse(t, s, true); }
                catch { throw new ArgumentException("\"" + s + "\" isn't one of " + string.Join(", ", Enum.GetNames(t)) + "."); }
            }
            if (t.IsPrimitive || t == typeof(decimal))
            {
                double d = json is double ? (double)json : double.Parse(json.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture);
                if (t != typeof(float) && t != typeof(double) && t != typeof(decimal)) d = Math.Round(d);
                return System.Convert.ChangeType(d, t, CultureInfo.InvariantCulture);
            }
            if (t.IsArray)
            {
                IList items = AsList(json);
                Array arr = Array.CreateInstance(t.GetElementType(), items.Count);
                for (int i = 0; i < items.Count; i++) arr.SetValue(Convert(items[i], t.GetElementType()), i);
                return arr;
            }
            if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(List<>))
            {
                IList list = (IList)Activator.CreateInstance(t);
                foreach (object item in AsList(json)) list.Add(Convert(item, t.GetGenericArguments()[0]));
                return list;
            }
            if (IsUnityObject(t))
            {
                if (ObjectResolver == null) throw new InvalidOperationException("Object references need the game running.");
                return ObjectResolver(json, t);
            }
            if (t.FullName == "UnityEngine.Color" || t.FullName == "UnityEngine.Color32") return ToColor(json, t);
            if (t.FullName == "UnityEngine.Quaternion")
            {
                IList q = json as IList;
                if (q != null && q.Count == 3)
                {
                    MethodInfo euler = t.GetMethod("Euler", new[] { typeof(float), typeof(float), typeof(float) });
                    return euler.Invoke(null, new object[] { F(q[0]), F(q[1]), F(q[2]) });
                }
            }
            if (t.IsValueType) return ToStruct(json, t);
            var dict = json as Dictionary<string, object>;
            if (dict != null && t.GetConstructor(Type.EmptyTypes) != null)
            {
                object obj = Activator.CreateInstance(t);
                foreach (var kv in dict) Set(obj, t, kv.Key, kv.Value);
                return obj;
            }
            throw new ArgumentException("Can't turn " + Json.Write(json) + " into a " + Describe(t) + ".");
        }

        static IList AsList(object json)
        {
            IList list = json as IList;
            if (list == null) throw new ArgumentException("Expected a list, got " + Json.Write(json) + ".");
            return list;
        }

        static float F(object o)
        {
            return (float)System.Convert.ToDouble(o, CultureInfo.InvariantCulture);
        }

        /// <summary>Vector2/3/4 and other small structs: [x, y, z], {"x": 1}, or one number for all.</summary>
        static object ToStruct(object json, Type t)
        {
            object box = Activator.CreateInstance(t);
            FieldInfo[] fields = t.GetFields(BindingFlags.Public | BindingFlags.Instance);
            var dict = json as Dictionary<string, object>;
            if (dict != null)
            {
                foreach (var kv in dict)
                {
                    FieldInfo f = fields.FirstOrDefault(x => string.Equals(x.Name, kv.Key, StringComparison.OrdinalIgnoreCase));
                    if (f == null) throw new ArgumentException(Describe(t) + " has no \"" + kv.Key + "\"; it has " + string.Join(", ", fields.Select(x => x.Name).ToArray()) + ".");
                    f.SetValue(box, Convert(kv.Value, f.FieldType));
                }
                return box;
            }
            IList list = json as IList;
            if (list == null && json is double) list = fields.Select(_ => json).ToList();
            if (list == null) throw new ArgumentException("Can't turn " + Json.Write(json) + " into a " + Describe(t) + ".");
            if (list.Count > fields.Length) throw new ArgumentException(Describe(t) + " has only " + fields.Length + " parts.");
            for (int i = 0; i < list.Count; i++) fields[i].SetValue(box, Convert(list[i], fields[i].FieldType));
            return box;
        }

        static object ToColor(object json, Type t)
        {
            float r, g, b, a = 1f;
            string s = json as string;
            if (s != null)
            {
                s = s.Trim();
                float[] named;
                if (NamedColors.TryGetValue(s, out named)) { r = named[0]; g = named[1]; b = named[2]; }
                else
                {
                    string hex = s.TrimStart('#');
                    if (hex.Length != 6 && hex.Length != 8) throw new ArgumentException("\"" + s + "\" isn't a color. Use a name, #rrggbb, or [r, g, b].");
                    r = int.Parse(hex.Substring(0, 2), NumberStyles.HexNumber) / 255f;
                    g = int.Parse(hex.Substring(2, 2), NumberStyles.HexNumber) / 255f;
                    b = int.Parse(hex.Substring(4, 2), NumberStyles.HexNumber) / 255f;
                    if (hex.Length == 8) a = int.Parse(hex.Substring(6, 2), NumberStyles.HexNumber) / 255f;
                }
            }
            else
            {
                IList list = json as IList;
                var dict = json as Dictionary<string, object>;
                if (dict != null)
                {
                    list = new List<object> { dict["r"], dict["g"], dict["b"] };
                    if (dict.ContainsKey("a")) list.Add(dict["a"]);
                }
                if (list == null || list.Count < 3) throw new ArgumentException("A color is a name, #rrggbb, or [r, g, b(, a)].");
                float scale = list.Cast<object>().Any(v => F(v) > 1f) ? 255f : 1f;
                r = F(list[0]) / scale;
                g = F(list[1]) / scale;
                b = F(list[2]) / scale;
                if (list.Count > 3) a = F(list[3]) / scale;
            }
            if (t.FullName == "UnityEngine.Color32")
                return Activator.CreateInstance(t, (byte)(r * 255), (byte)(g * 255), (byte)(b * 255), (byte)(a * 255));
            return Activator.CreateInstance(t, r, g, b, a);
        }

        // ------------------------------------------------------------------ game values → JSON

        public static bool IsUnityObject(Type t)
        {
            for (; t != null; t = t.BaseType) if (t.FullName == "UnityEngine.Object") return true;
            return false;
        }

        /// <summary>A JSON-friendly view of a value, `depth` levels into objects.</summary>
        public static object Describe(object value, int depth)
        {
            if (value == null) return null;
            Type t = value.GetType();
            if (value is string)
            {
                string s = (string)value;
                return s.Length > 300 ? s.Substring(0, 300) + "…" : s;
            }
            if (value is bool || value is int || value is long || value is short || value is byte || value is uint || value is ushort || value is sbyte || value is ulong) return value;
            if (value is float || value is double || value is decimal)
            {
                double d = System.Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return double.IsNaN(d) || double.IsInfinity(d) ? (object)d.ToString(CultureInfo.InvariantCulture) : Math.Round(d, 4);
            }
            if (t.IsEnum) return value.ToString();
            if (IsUnityObject(t)) return ObjectDescriber != null ? ObjectDescriber(value) : Describe(t);
            if (t.IsValueType && !t.IsPrimitive)
            {
                // Vector3, Color, Quaternion and friends: their public fields.
                var parts = new Dictionary<string, object>();
                foreach (FieldInfo f in t.GetFields(BindingFlags.Public | BindingFlags.Instance).Take(8))
                    parts[f.Name] = Describe(f.GetValue(value), Math.Max(0, depth - 1));
                return parts.Count > 0 ? (object)parts : value.ToString();
            }
            if (value is Delegate) return "(function)";
            IDictionary dict = value as IDictionary;
            if (dict != null)
            {
                var items = new Dictionary<string, object>();
                int n = 0;
                foreach (DictionaryEntry kv in dict)
                {
                    if (n++ >= 15) break;
                    items[System.Convert.ToString(kv.Key, CultureInfo.InvariantCulture)] = depth > 0 ? Describe(kv.Value, depth - 1) : Short(kv.Value);
                }
                return new Dictionary<string, object> { { "count", dict.Count }, { "items", items } };
            }
            IEnumerable seq = value as IEnumerable;
            if (seq != null)
            {
                var items = new List<object>();
                int count = 0;
                foreach (object item in seq)
                {
                    if (count < 15) items.Add(depth > 0 ? Describe(item, depth - 1) : Short(item));
                    count++;
                    if (count > 10000) break;
                }
                return new Dictionary<string, object> { { "count", count }, { "items", items } };
            }
            if (depth <= 0) return Describe(t);
            var fields = new Dictionary<string, object>();
            foreach (Member m in ListMembers(t, false, null, null).Take(25))
            {
                try { fields[m.Name] = Describe(m.Get(value), depth - 1); }
                catch (Exception e) { fields[m.Name] = "(error: " + Unwrap(e).Message + ")"; }
            }
            return new Dictionary<string, object> { { "type", Describe(t) }, { "fields", fields } };
        }

        static object Short(object value)
        {
            if (value == null) return null;
            Type t = value.GetType();
            if (t.IsPrimitive || value is string || t.IsEnum || IsUnityObject(t) || t.IsValueType) return Describe(value, 0);
            return Describe(t);
        }

        public static string Describe(Type t)
        {
            if (t == null) return "?";
            if (!t.IsGenericType) return t.Name;
            string name = t.Name;
            int tick = name.IndexOf('`');
            if (tick > 0) name = name.Substring(0, tick);
            return name + "<" + string.Join(", ", t.GetGenericArguments().Select(Describe).ToArray()) + ">";
        }

        public static Exception Unwrap(Exception e)
        {
            while (e is TargetInvocationException && e.InnerException != null) e = e.InnerException;
            return e;
        }

        // ------------------------------------------------------------------ types

        /// <summary>The game's own assemblies first (Assembly-CSharp), then everything else loaded.</summary>
        public static IEnumerable<Type> AllTypes(bool gameOnly)
        {
            var assemblies = AppDomain.CurrentDomain.GetAssemblies()
                .Where(a => !gameOnly || IsGameAssembly(a))
                .OrderBy(a => a.GetName().Name.StartsWith("Assembly-CSharp") ? 0 : 1);
            foreach (Assembly a in assemblies)
            {
                Type[] types;
                try { types = a.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(x => x != null).ToArray(); }
                catch { continue; }
                foreach (Type t in types) yield return t;
            }
        }

        public static bool IsGameAssembly(Assembly a)
        {
            string name = a.GetName().Name;
            if (SkipAssemblies.Contains(name)) return false;
            if (name.StartsWith("System.") || name.StartsWith("Mono.") || name.StartsWith("Microsoft.")) return false;
            if (name.StartsWith("UnityEngine") || name.StartsWith("Unity.") || name.StartsWith("UnityEditor")) return false;
            return true;
        }

        /// <summary>
        /// How well a name matches what the AI asked for: 100 for the whole phrase ("game manager" finds
        /// GameManager), otherwise one point per word found, 0 for none.
        /// </summary>
        public static int Score(string name, string query)
        {
            if (string.IsNullOrEmpty(query)) return 0;
            string n = name.ToLowerInvariant();
            string q = query.Trim().ToLowerInvariant();
            if (q.Length > 0 && n.Contains(q.Replace(" ", "").Replace("_", ""))) return 100;
            int score = 0;
            foreach (string w in q.Split(new[] { ' ', ',', '.', '/' }, StringSplitOptions.RemoveEmptyEntries))
                if (w.Length >= 2 && n.Contains(w)) score++;
            return score;
        }

        /// <summary>
        /// The game's singletons ("GameManager.Instance"): a static field or property holding the class
        /// itself, declared on it or on a generic base like Singleton&lt;GameManager&gt;. The usual way
        /// into a Unity game's state.
        /// </summary>
        public static List<string> Singletons(int limit)
        {
            var found = new List<string>();
            foreach (Type t in AllTypes(true))
            {
                if (t.IsGenericTypeDefinition || t.Name.StartsWith("<")) continue;
                for (Type owner = t; owner != null && owner != typeof(object); owner = owner.BaseType)
                {
                    if (owner != t && !owner.IsGenericType) continue; // only the class itself or a generic base
                    foreach (FieldInfo f in owner.GetFields(Static | BindingFlags.DeclaredOnly))
                        if (f.FieldType == t) found.Add(t.FullName + "." + CleanName(f.Name));
                    foreach (PropertyInfo p in owner.GetProperties(Static | BindingFlags.DeclaredOnly))
                        if (p.PropertyType == t && p.GetIndexParameters().Length == 0) found.Add(t.FullName + "." + p.Name);
                }
                if (found.Count >= limit) break;
            }
            return found.Distinct().Take(limit).ToList();
        }

        public static Type FindType(string name)
        {
            Type exact = null, loose = null;
            foreach (Type t in AllTypes(false))
            {
                if (t.FullName == name) return t;
                if (exact == null && t.Name == name) exact = t;
                if (loose == null && string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase)) loose = t;
            }
            Type found = exact ?? loose;
            if (found == null) throw new TypeLoadException("No type named \"" + name + "\". Use types to search.");
            return found;
        }
    }
}
