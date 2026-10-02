using System;
using System.Collections.Generic;
using System.Linq;
using ScruffBridge;

// Test harness for ModelFile (bridge/src/ModelFile.cs): loads a model and prints what the
// Unity side would build from it, as JSON. "ModelDump.exe <file> [maxVerticesPerMesh]".
public static class ModelDump
{
    public static int Main(string[] args)
    {
        try
        {
            List<ModelPart> parts = ModelFile.Load(args[0]);
            if (args.Length > 1) parts = parts.SelectMany(p => ModelFile.Split(p, int.Parse(args[1]))).ToList();
            var outParts = parts.Select(p => (object)new Dictionary<string, object>
            {
                { "name", p.Name },
                { "positions", p.Positions.Select(f => (object)Math.Round(f, 4)).ToList() },
                { "normals", p.Normals == null ? null : p.Normals.Select(f => (object)Math.Round(f, 4)).ToList() },
                { "uvs", p.UVs == null ? null : p.UVs.Select(f => (object)Math.Round(f, 4)).ToList() },
                { "indices", p.Indices.Select(i => (object)i).ToList() },
                { "color", p.Color.Select(f => (object)Math.Round(f, 4)).ToList() },
                { "texture", p.Texture == null ? 0 : p.Texture.Length },
            }).ToList();
            Console.WriteLine(Json.Write(new Dictionary<string, object> { { "parts", outParts }, { "bounds", ModelFile.Bounds(parts).Select(f => (object)Math.Round(f, 4)).ToList() } }));
            return 0;
        }
        catch (Exception e)
        {
            Console.WriteLine(Json.Write(new Dictionary<string, object> { { "error", e.Message } }));
            return 1;
        }
    }
}
