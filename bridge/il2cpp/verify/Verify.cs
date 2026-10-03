using System;
using System.Linq;
using Mono.Cecil;

// Build check for the IL2CPP bridge: every BepInEx, Il2CppInterop and UnityEngine member the
// plugin calls must exist in the assemblies it will meet in a game. A call that compiles against
// one signature but meets another fails at runtime (MissingMethodException), and when that's on
// the start-up path the bridge never connects.
//   dotnet Verify.dll <TelosBridge.IL2CPP.dll> <dir;dir;...>
static class Verify
{
    static int Main(string[] args)
    {
        var resolver = new DefaultAssemblyResolver();
        foreach (string dir in args[1].Split(';')) resolver.AddSearchDirectory(dir);
        var module = ModuleDefinition.ReadModule(args[0], new ReaderParameters { AssemblyResolver = resolver });
        Func<string, bool> checkedScope = s => s.StartsWith("BepInEx") || s.StartsWith("Il2Cpp") || s.StartsWith("UnityEngine");
        int ok = 0, missing = 0;
        foreach (MemberReference m in module.GetMemberReferences())
        {
            if (!checkedScope(m.DeclaringType.Scope.Name)) continue;
            IMemberDefinition found = null;
            try { found = m.Resolve(); } catch { }
            if (found != null) { ok++; continue; }
            missing++;
            Console.WriteLine("  missing: " + m.FullName);
        }
        foreach (TypeReference t in module.GetTypeReferences())
        {
            if (!checkedScope(t.Scope.Name)) continue;
            TypeDefinition found = null;
            try { found = t.Resolve(); } catch { }
            if (found != null) { ok++; continue; }
            missing++;
            Console.WriteLine("  missing type: " + t.FullName);
        }
        Console.WriteLine("Checked " + (ok + missing) + " references against real IL2CPP assemblies: " + (missing == 0 ? "all present." : missing + " missing."));
        return missing == 0 ? 0 : 1;
    }
}
