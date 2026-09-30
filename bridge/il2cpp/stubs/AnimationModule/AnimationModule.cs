// Compile-time-only stub for UnityEngine.AnimationModule (Animator lives there, not in
// CoreModule). Same deal as the CoreModule stub: never deployed, unifies at runtime.
using System;
using System.Reflection;


namespace UnityEngine
{
    public class Avatar : Object
    {
        public Avatar(IntPtr ptr) : base(ptr) { }
    }

    public class RuntimeAnimatorController : Object
    {
        public RuntimeAnimatorController(IntPtr ptr) : base(ptr) { }
    }

    public class Animator : Behaviour
    {
        public Animator(IntPtr ptr) : base(ptr) { }
        public RuntimeAnimatorController runtimeAnimatorController { get; set; }
        public Avatar avatar { get; set; }
    }
}
