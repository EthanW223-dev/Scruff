using System;
using System.Collections.Generic;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;

namespace ScruffBridge
{
    /// <summary>
    /// IL2CPP plumbing the Mono bridge doesn't need. Il2CppInterop hands an object back wrapped as
    /// the type it was asked for: GetComponents&lt;Component&gt;() gives Components, even for a
    /// PlayerHealth. So C#'s `as`, `is` and GetType() can't see what an object really is. These
    /// look up its actual IL2CPP class and rewrap it as that class's managed type, so reflection
    /// sees every field and property it has.
    /// </summary>
    public static class Il2Cpp
    {
        static readonly Dictionary<IntPtr, Type> ByClass = new Dictionary<IntPtr, Type>();
        static readonly Dictionary<string, Type> ByName = new Dictionary<string, Type>();

        /// <summary>The managed type of the object's actual IL2CPP class (or its nearest wrapped base).</summary>
        public static Type RealType(object o)
        {
            if (o == null) return null;
            var b = o as Il2CppObjectBase;
            if (b == null || b.Pointer == IntPtr.Zero) return o.GetType();
            IntPtr klass = IL2CPP.il2cpp_object_get_class(b.Pointer);
            Type t;
            if (ByClass.TryGetValue(klass, out t)) return t;
            t = o.GetType();
            try
            {
                Il2CppSystem.Object obj = b.TryCast<Il2CppSystem.Object>();
                for (Il2CppSystem.Type it = obj != null ? obj.GetIl2CppType() : null; it != null; it = it.BaseType)
                {
                    Type managed = Managed(it.FullName);
                    if (managed != null && t.IsAssignableFrom(managed))
                    {
                        t = managed;
                        break;
                    }
                }
            }
            catch
            {
                // Keep the wrapper's own type.
            }
            ByClass[klass] = t;
            return t;
        }

        /// <summary>The same object, wrapped as its real type (a component as PlayerHealth, not just Component).</summary>
        public static object Real(object o)
        {
            var b = o as Il2CppObjectBase;
            if (b == null || b.Pointer == IntPtr.Zero) return o;
            Type t = RealType(o);
            if (t == null || t == o.GetType()) return o;
            try { return Activator.CreateInstance(t, b.Pointer); }
            catch { return o; }
        }

        /// <summary>The object wrapped as exactly this type (what a field or parameter of that type takes).</summary>
        public static object CastTo(object o, Type t)
        {
            var b = o as Il2CppObjectBase;
            if (b == null || t == null || t.IsInstanceOfType(o) || !typeof(Il2CppObjectBase).IsAssignableFrom(t)) return o;
            try { return Activator.CreateInstance(t, b.Pointer); }
            catch { return o; }
        }

        /// <summary>IL2CPP's version of `o as T`: null when the object isn't a T.</summary>
        public static T As<T>(object o) where T : Il2CppObjectBase
        {
            var b = o as Il2CppObjectBase;
            if (b == null || b.Pointer == IntPtr.Zero) return null;
            try { return b.TryCast<T>(); }
            catch { return null; }
        }

        /// <summary>IL2CPP's version of `o is T`.</summary>
        public static bool Is<T>(object o) where T : Il2CppObjectBase
        {
            return As<T>(o) != null;
        }

        /// <summary>The real type's name, for showing ("PlayerHealth", not "Component").</summary>
        public static string TypeName(object o)
        {
            Type t = RealType(o);
            return t == null ? "null" : t.Name;
        }

        /// <summary>A managed type as IL2CPP's Type, for Unity calls that take one (FindObjectsOfType, GetComponent).</summary>
        public static Il2CppSystem.Type Of(Type t)
        {
            return Il2CppType.From(t);
        }

        /// <summary>
        /// The managed type Il2CppInterop made for an IL2CPP class name: Unity's keep their names, a
        /// game's get "Il2Cpp" in front of the namespace ("Il2Cpp" alone when there is none), and
        /// mscorlib's live under Il2CppSystem.
        /// </summary>
        static Type Managed(string fullName)
        {
            if (string.IsNullOrEmpty(fullName)) return null;
            Type t;
            if (ByName.TryGetValue(fullName, out t)) return t;
            int nested = fullName.IndexOf('+');
            string outer = nested < 0 ? fullName : fullName.Substring(0, nested);
            var names = new List<string> { fullName, outer.IndexOf('.') < 0 ? "Il2Cpp." + fullName : "Il2Cpp" + fullName };
            t = null;
            foreach (System.Reflection.Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.IsDynamic) continue;
                foreach (string n in names)
                {
                    Type c = null;
                    try { c = asm.GetType(n, false); }
                    catch { }
                    if (c != null && typeof(Il2CppObjectBase).IsAssignableFrom(c))
                    {
                        t = c;
                        break;
                    }
                }
                if (t != null) break;
            }
            ByName[fullName] = t;
            return t;
        }
    }
}
