using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace ScruffBridge
{
    /// <summary>
    /// One piece of a model: a mesh with one material. Already in Unity's coordinates
    /// (left-handed, Y up), with node transforms baked into the vertices.
    /// </summary>
    public class ModelPart
    {
        public string Name;
        /// <summary>x,y,z per vertex.</summary>
        public float[] Positions;
        /// <summary>x,y,z per vertex, or null (Unity recalculates them).</summary>
        public float[] Normals;
        /// <summary>u,v per vertex (Unity's convention: v up), or null.</summary>
        public float[] UVs;
        /// <summary>Three per triangle, clockwise seen from the front (Unity's winding).</summary>
        public int[] Indices;
        /// <summary>r,g,b,a, 0..1.</summary>
        public float[] Color = { 1f, 1f, 1f, 1f };
        /// <summary>A PNG or JPEG for the base color, or null.</summary>
        public byte[] Texture;

        public int VertexCount { get { return Positions.Length / 3; } }
    }

    /// <summary>
    /// Reads 3D models for load_model: Wavefront OBJ (+ MTL) and glTF 2.0 (.glb, or .gltf with its
    /// .bin and images). Static meshes only: skins, animations and morph targets are left out.
    /// No Unity types in here, so it's testable on plain Mono.
    /// </summary>
    public static class ModelFile
    {
        const long MaxFileBytes = 256L * 1024 * 1024;
        const int MaxVertices = 4000000;

        public static List<ModelPart> Load(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("No file at " + path);
            if (new FileInfo(path).Length > MaxFileBytes) throw new InvalidOperationException("That model is over 256 MB; Telos loads smaller ones.");
            string ext = Path.GetExtension(path).ToLowerInvariant();
            List<ModelPart> parts;
            if (ext == ".obj") parts = Obj.Read(path);
            else if (ext == ".glb" || ext == ".gltf") parts = Gltf.Read(path);
            else throw new InvalidOperationException("Telos loads .glb, .gltf and .obj models (convert others with Blender: File > Export > glTF 2.0).");
            int total = 0;
            foreach (ModelPart p in parts) total += p.VertexCount;
            if (parts.Count == 0 || total == 0) throw new InvalidOperationException("That file has no triangle meshes in it.");
            if (total > MaxVertices) throw new InvalidOperationException("That model has " + total + " vertices; Telos loads up to " + MaxVertices + ".");
            return parts;
        }

        /// <summary>
        /// Splits a part into pieces of at most maxVertices each (Unity before 2017.3 has 16-bit
        /// mesh indices: 65535 vertices per mesh).
        /// </summary>
        public static List<ModelPart> Split(ModelPart part, int maxVertices)
        {
            var result = new List<ModelPart>();
            if (part.VertexCount <= maxVertices)
            {
                result.Add(part);
                return result;
            }
            var map = new Dictionary<int, int>();
            var pos = new List<float>();
            var nrm = new List<float>();
            var uv = new List<float>();
            var idx = new List<int>();
            Action flush = () =>
            {
                if (idx.Count == 0) return;
                result.Add(new ModelPart
                {
                    Name = part.Name + " " + (result.Count + 1),
                    Positions = pos.ToArray(),
                    Normals = part.Normals != null ? nrm.ToArray() : null,
                    UVs = part.UVs != null ? uv.ToArray() : null,
                    Indices = idx.ToArray(),
                    Color = part.Color,
                    Texture = part.Texture,
                });
                map.Clear(); pos.Clear(); nrm.Clear(); uv.Clear(); idx.Clear();
            };
            for (int t = 0; t + 2 < part.Indices.Length; t += 3)
            {
                if (map.Count + 3 > maxVertices) flush();
                for (int k = 0; k < 3; k++)
                {
                    int old = part.Indices[t + k];
                    int now;
                    if (!map.TryGetValue(old, out now))
                    {
                        now = map.Count;
                        map[old] = now;
                        pos.Add(part.Positions[old * 3]); pos.Add(part.Positions[old * 3 + 1]); pos.Add(part.Positions[old * 3 + 2]);
                        if (part.Normals != null) { nrm.Add(part.Normals[old * 3]); nrm.Add(part.Normals[old * 3 + 1]); nrm.Add(part.Normals[old * 3 + 2]); }
                        if (part.UVs != null) { uv.Add(part.UVs[old * 2]); uv.Add(part.UVs[old * 2 + 1]); }
                    }
                    idx.Add(now);
                }
            }
            flush();
            return result;
        }

        /// <summary>Min x,y,z then max x,y,z over all parts.</summary>
        public static float[] Bounds(List<ModelPart> parts)
        {
            var b = new[] { float.MaxValue, float.MaxValue, float.MaxValue, float.MinValue, float.MinValue, float.MinValue };
            foreach (ModelPart p in parts)
            {
                for (int i = 0; i < p.Positions.Length; i += 3)
                {
                    for (int k = 0; k < 3; k++)
                    {
                        b[k] = Math.Min(b[k], p.Positions[i + k]);
                        b[k + 3] = Math.Max(b[k + 3], p.Positions[i + k]);
                    }
                }
            }
            return b;
        }

        internal static float F(string s)
        {
            return float.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        // ------------------------------------------------------------------ OBJ

        static class Obj
        {
            class Material
            {
                public float[] Color = { 1f, 1f, 1f, 1f };
                public string TexturePath;
            }

            class Builder
            {
                public string Name;
                public Material Mat;
                public readonly Dictionary<string, int> Seen = new Dictionary<string, int>();
                public readonly List<float> Pos = new List<float>(), Nrm = new List<float>(), Uv = new List<float>();
                public readonly List<int> Idx = new List<int>();
                public bool HasNormals = true, HasUVs = true;
            }

            public static List<ModelPart> Read(string path)
            {
                string dir = Path.GetDirectoryName(Path.GetFullPath(path));
                var v = new List<float>();
                var vt = new List<float>();
                var vn = new List<float>();
                var materials = new Dictionary<string, Material>();
                var builders = new List<Builder>();
                Builder cur = null;
                Func<string, Builder> start = (name) =>
                {
                    Material m;
                    materials.TryGetValue(name ?? "", out m);
                    var b = new Builder { Name = string.IsNullOrEmpty(name) ? "model" : name, Mat = m ?? new Material() };
                    builders.Add(b);
                    return b;
                };
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line[0] == '#') continue;
                    string[] t = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    switch (t[0])
                    {
                        case "v": v.Add(F(t[1])); v.Add(F(t[2])); v.Add(F(t[3])); break;
                        case "vt": vt.Add(F(t[1])); vt.Add(t.Length > 2 ? F(t[2]) : 0f); break;
                        case "vn": vn.Add(F(t[1])); vn.Add(F(t[2])); vn.Add(F(t[3])); break;
                        case "mtllib":
                            ReadMtl(Path.Combine(dir, line.Substring(7).Trim()), materials);
                            break;
                        case "usemtl":
                            cur = start(line.Substring(6).Trim());
                            break;
                        case "f":
                            if (cur == null) cur = start(null);
                            var corners = new int[t.Length - 1];
                            for (int i = 1; i < t.Length; i++) corners[i - 1] = Corner(cur, t[i], v, vt, vn);
                            // A polygon becomes a fan of triangles; winding flips with the X mirror below.
                            for (int i = 1; i + 1 < corners.Length; i++)
                            {
                                cur.Idx.Add(corners[0]);
                                cur.Idx.Add(corners[i + 1]);
                                cur.Idx.Add(corners[i]);
                            }
                            break;
                    }
                }
                var parts = new List<ModelPart>();
                foreach (Builder b in builders)
                {
                    if (b.Idx.Count == 0) continue;
                    var part = new ModelPart
                    {
                        Name = b.Name,
                        Positions = b.Pos.ToArray(),
                        Normals = b.HasNormals ? b.Nrm.ToArray() : null,
                        UVs = b.HasUVs ? b.Uv.ToArray() : null,
                        Indices = b.Idx.ToArray(),
                        Color = b.Mat.Color,
                    };
                    if (b.Mat.TexturePath != null && File.Exists(b.Mat.TexturePath)) part.Texture = File.ReadAllBytes(b.Mat.TexturePath);
                    parts.Add(part);
                }
                return parts;
            }

            /// <summary>A face corner "v/vt/vn" (1-based, negative counts from the end) as an index into the part.</summary>
            static int Corner(Builder b, string spec, List<float> v, List<float> vt, List<float> vn)
            {
                int found;
                if (b.Seen.TryGetValue(spec, out found)) return found;
                string[] p = spec.Split('/');
                int vi = Ref(p[0], v.Count / 3);
                int ti = p.Length > 1 && p[1].Length > 0 ? Ref(p[1], vt.Count / 2) : -1;
                int ni = p.Length > 2 && p[2].Length > 0 ? Ref(p[2], vn.Count / 3) : -1;
                // OBJ is right-handed like glTF: mirror X into Unity's left-handed space.
                b.Pos.Add(-v[vi * 3]); b.Pos.Add(v[vi * 3 + 1]); b.Pos.Add(v[vi * 3 + 2]);
                if (ni >= 0) { b.Nrm.Add(-vn[ni * 3]); b.Nrm.Add(vn[ni * 3 + 1]); b.Nrm.Add(vn[ni * 3 + 2]); }
                else { b.HasNormals = false; b.Nrm.Add(0); b.Nrm.Add(0); b.Nrm.Add(0); }
                if (ti >= 0) { b.Uv.Add(vt[ti * 2]); b.Uv.Add(vt[ti * 2 + 1]); }
                else { b.HasUVs = false; b.Uv.Add(0); b.Uv.Add(0); }
                int index = b.Pos.Count / 3 - 1;
                b.Seen[spec] = index;
                return index;
            }

            static int Ref(string s, int count)
            {
                int i = int.Parse(s, CultureInfo.InvariantCulture);
                int r = i < 0 ? count + i : i - 1;
                if (r < 0 || r >= count) throw new InvalidOperationException("The OBJ file refers to a vertex that isn't there (" + s + ").");
                return r;
            }

            static void ReadMtl(string path, Dictionary<string, Material> into)
            {
                if (!File.Exists(path)) return;
                string dir = Path.GetDirectoryName(path);
                Material cur = null;
                foreach (string raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    string[] t = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (t.Length < 2) continue;
                    if (t[0] == "newmtl") into[line.Substring(6).Trim()] = cur = new Material();
                    else if (cur == null) continue;
                    else if (t[0] == "Kd" && t.Length >= 4) { cur.Color[0] = F(t[1]); cur.Color[1] = F(t[2]); cur.Color[2] = F(t[3]); }
                    else if (t[0] == "d") cur.Color[3] = F(t[1]);
                    else if (t[0] == "Tr") cur.Color[3] = 1f - F(t[1]);
                    // Options (-s 1 1 1 ...) come first; the file name is last.
                    else if (t[0] == "map_Kd") cur.TexturePath = Path.Combine(dir, t[t.Length - 1]);
                }
            }
        }

        // ------------------------------------------------------------------ glTF

        static class Gltf
        {
            class Doc
            {
                public Dictionary<string, object> Root;
                public List<byte[]> Buffers = new List<byte[]>();
                public string Dir;
            }

            public static List<ModelPart> Read(string path)
            {
                byte[] file = File.ReadAllBytes(path);
                var doc = new Doc { Dir = Path.GetDirectoryName(Path.GetFullPath(path)) };
                byte[] glbBin = null;
                string json;
                if (file.Length >= 12 && BitConverter.ToUInt32(file, 0) == 0x46546C67) // "glTF"
                {
                    int at = 12;
                    json = null;
                    while (at + 8 <= file.Length)
                    {
                        int len = BitConverter.ToInt32(file, at);
                        uint type = BitConverter.ToUInt32(file, at + 4);
                        if (at + 8 + len > file.Length) throw new InvalidOperationException("The .glb file is cut off.");
                        if (type == 0x4E4F534A) json = Encoding.UTF8.GetString(file, at + 8, len); // JSON
                        else if (type == 0x004E4942) { glbBin = new byte[len]; Buffer.BlockCopy(file, at + 8, glbBin, 0, len); } // BIN
                        at += 8 + len;
                    }
                    if (json == null) throw new InvalidOperationException("The .glb file has no JSON chunk.");
                }
                else json = Encoding.UTF8.GetString(file);

                doc.Root = Json.Parse(json) as Dictionary<string, object>;
                if (doc.Root == null) throw new InvalidOperationException("That isn't a glTF file.");
                foreach (object e in List(doc.Root, "extensionsRequired"))
                {
                    string ext = e as string;
                    if (ext == "KHR_draco_mesh_compression" || ext == "EXT_meshopt_compression" || ext == "KHR_mesh_quantization")
                        throw new InvalidOperationException("This model is compressed (" + ext + "). Export it again without compression (in Blender: glTF export, Data > Compression off).");
                }
                foreach (object b in List(doc.Root, "buffers"))
                {
                    var buf = (Dictionary<string, object>)b;
                    string uri = Str(buf, "uri");
                    doc.Buffers.Add(uri == null ? glbBin : LoadUri(doc, uri));
                }

                var parts = new List<ModelPart>();
                List<object> nodes = List(doc.Root, "nodes");
                List<object> roots;
                List<object> scenes = List(doc.Root, "scenes");
                if (scenes.Count > 0)
                {
                    int scene = (int)Num(doc.Root, "scene", 0);
                    roots = List((Dictionary<string, object>)scenes[Math.Min(scene, scenes.Count - 1)], "nodes");
                }
                else
                {
                    // No scene: every node that isn't someone's child.
                    var children = new HashSet<int>();
                    foreach (object n in nodes) foreach (object c in List((Dictionary<string, object>)n, "children")) children.Add(Convert.ToInt32(c));
                    roots = new List<object>();
                    for (int i = 0; i < nodes.Count; i++) if (!children.Contains(i)) roots.Add((double)i);
                }
                if (nodes.Count == 0 && List(doc.Root, "meshes").Count > 0)
                {
                    for (int m = 0; m < List(doc.Root, "meshes").Count; m++) AddMesh(doc, m, Identity(), parts);
                    return parts;
                }
                foreach (object r in roots) Walk(doc, nodes, Convert.ToInt32(r), Identity(), parts, 0);
                return parts;
            }

            static void Walk(Doc doc, List<object> nodes, int index, float[] parent, List<ModelPart> parts, int depth)
            {
                if (depth > 64 || index < 0 || index >= nodes.Count) return;
                var node = (Dictionary<string, object>)nodes[index];
                float[] world = Mul(parent, Local(node));
                if (node.ContainsKey("mesh")) AddMesh(doc, (int)Num(node, "mesh", 0), world, parts);
                foreach (object c in List(node, "children")) Walk(doc, nodes, Convert.ToInt32(c), world, parts, depth + 1);
            }

            static void AddMesh(Doc doc, int meshIndex, float[] m, List<ModelPart> parts)
            {
                var mesh = (Dictionary<string, object>)List(doc.Root, "meshes")[meshIndex];
                string name = Str(mesh, "name") ?? ("mesh " + meshIndex);
                foreach (object po in List(mesh, "primitives"))
                {
                    var prim = (Dictionary<string, object>)po;
                    if ((int)Num(prim, "mode", 4) != 4) continue; // triangles only (no lines/points)
                    var attrs = (Dictionary<string, object>)prim["attributes"];
                    if (!attrs.ContainsKey("POSITION")) continue;
                    float[] pos = ReadFloats(doc, Convert.ToInt32(attrs["POSITION"]), 3);
                    float[] nrm = attrs.ContainsKey("NORMAL") ? ReadFloats(doc, Convert.ToInt32(attrs["NORMAL"]), 3) : null;
                    float[] uv = attrs.ContainsKey("TEXCOORD_0") ? ReadFloats(doc, Convert.ToInt32(attrs["TEXCOORD_0"]), 2) : null;
                    int count = pos.Length / 3;
                    int[] idx;
                    if (prim.ContainsKey("indices")) idx = ReadInts(doc, Convert.ToInt32(prim["indices"]));
                    else
                    {
                        idx = new int[count];
                        for (int i = 0; i < count; i++) idx[i] = i;
                    }
                    // Into world space, then mirrored on X into Unity's left-handed space.
                    for (int i = 0; i < count; i++)
                    {
                        float x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
                        pos[i * 3] = -(m[0] * x + m[4] * y + m[8] * z + m[12]);
                        pos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                        pos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
                        if (nrm != null)
                        {
                            float nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
                            float wx = m[0] * nx + m[4] * ny + m[8] * nz, wy = m[1] * nx + m[5] * ny + m[9] * nz, wz = m[2] * nx + m[6] * ny + m[10] * nz;
                            float len = (float)Math.Sqrt(wx * wx + wy * wy + wz * wz);
                            if (len > 1e-8f) { wx /= len; wy /= len; wz /= len; }
                            nrm[i * 3] = -wx; nrm[i * 3 + 1] = wy; nrm[i * 3 + 2] = wz;
                        }
                        if (uv != null) uv[i * 2 + 1] = 1f - uv[i * 2 + 1]; // glTF's v runs down, Unity's up
                    }
                    // A mirror (and a mirroring node transform) flips which side is the front.
                    bool flip = Det3(m) > 0;
                    for (int t = 0; t + 2 < idx.Length; t += 3)
                    {
                        if (idx[t] >= count || idx[t + 1] >= count || idx[t + 2] >= count) throw new InvalidOperationException("The model refers to a vertex that isn't there.");
                        if (flip) { int s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
                    }
                    var part = new ModelPart { Name = name, Positions = pos, Normals = nrm, UVs = uv, Indices = idx };
                    if (prim.ContainsKey("material")) ApplyMaterial(doc, (int)Num(prim, "material", 0), part);
                    parts.Add(part);
                }
            }

            static void ApplyMaterial(Doc doc, int index, ModelPart part)
            {
                List<object> mats = List(doc.Root, "materials");
                if (index < 0 || index >= mats.Count) return;
                var mat = (Dictionary<string, object>)mats[index];
                object pbrObj;
                if (!mat.TryGetValue("pbrMetallicRoughness", out pbrObj)) return;
                var pbr = (Dictionary<string, object>)pbrObj;
                List<object> factor = List(pbr, "baseColorFactor");
                if (factor.Count == 4) for (int i = 0; i < 4; i++) part.Color[i] = (float)Convert.ToDouble(factor[i]);
                object texObj;
                if (!pbr.TryGetValue("baseColorTexture", out texObj)) return;
                int texIndex = (int)Num((Dictionary<string, object>)texObj, "index", -1);
                List<object> textures = List(doc.Root, "textures");
                if (texIndex < 0 || texIndex >= textures.Count) return;
                var tex = (Dictionary<string, object>)textures[texIndex];
                int imageIndex = (int)Num(tex, "source", -1);
                List<object> images = List(doc.Root, "images");
                if (imageIndex < 0 || imageIndex >= images.Count) return;
                var image = (Dictionary<string, object>)images[imageIndex];
                string mime = Str(image, "mimeType") ?? "";
                string uri = Str(image, "uri");
                if (mime.Contains("ktx") || mime.Contains("webp") || (uri != null && (uri.EndsWith(".ktx2") || uri.EndsWith(".webp")))) return; // Unity can't load those at runtime
                if (image.ContainsKey("bufferView")) part.Texture = View(doc, (int)Num(image, "bufferView", 0));
                else if (uri != null) part.Texture = LoadUri(doc, uri);
            }

            // ------------------------------------------------ accessors

            static float[] ReadFloats(Doc doc, int accessorIndex, int want)
            {
                var acc = (Dictionary<string, object>)List(doc.Root, "accessors")[accessorIndex];
                int count = (int)Num(acc, "count", 0);
                int comps = Components(Str(acc, "type"));
                if (comps < want) throw new InvalidOperationException("A model attribute has the wrong shape.");
                int ctype = (int)Num(acc, "componentType", 5126);
                bool normalized = acc.ContainsKey("normalized") && (bool)acc["normalized"];
                var result = new float[count * want];
                if (!acc.ContainsKey("bufferView")) return result; // all zeros (sparse-only accessors aren't supported)
                Slice s = Locate(doc, acc, comps, ctype);
                for (int i = 0; i < count; i++)
                {
                    int at = s.Offset + i * s.Stride;
                    for (int k = 0; k < want; k++) result[i * want + k] = Component(s.Data, at + k * Size(ctype), ctype, normalized);
                }
                return result;
            }

            static int[] ReadInts(Doc doc, int accessorIndex)
            {
                var acc = (Dictionary<string, object>)List(doc.Root, "accessors")[accessorIndex];
                int count = (int)Num(acc, "count", 0);
                int ctype = (int)Num(acc, "componentType", 5125);
                var result = new int[count];
                Slice s = Locate(doc, acc, 1, ctype);
                for (int i = 0; i < count; i++)
                {
                    int at = s.Offset + i * s.Stride;
                    result[i] = ctype == 5125 ? (int)BitConverter.ToUInt32(s.Data, at) : ctype == 5123 ? BitConverter.ToUInt16(s.Data, at) : s.Data[at];
                }
                return result;
            }

            struct Slice
            {
                public byte[] Data;
                public int Offset;
                public int Stride;
            }

            static Slice Locate(Doc doc, Dictionary<string, object> acc, int comps, int ctype)
            {
                var view = (Dictionary<string, object>)List(doc.Root, "bufferViews")[(int)Num(acc, "bufferView", 0)];
                byte[] data = doc.Buffers[(int)Num(view, "buffer", 0)];
                if (data == null) throw new InvalidOperationException("The model's data buffer is missing.");
                int stride = (int)Num(view, "byteStride", 0);
                int elem = comps * Size(ctype);
                var s = new Slice { Data = data, Offset = (int)Num(view, "byteOffset", 0) + (int)Num(acc, "byteOffset", 0), Stride = stride > 0 ? stride : elem };
                int count = (int)Num(acc, "count", 0);
                if (count > 0 && s.Offset + (count - 1) * s.Stride + elem > data.Length) throw new InvalidOperationException("The model's data is cut off.");
                return s;
            }

            static byte[] View(Doc doc, int index)
            {
                var view = (Dictionary<string, object>)List(doc.Root, "bufferViews")[index];
                byte[] data = doc.Buffers[(int)Num(view, "buffer", 0)];
                int offset = (int)Num(view, "byteOffset", 0), length = (int)Num(view, "byteLength", 0);
                var result = new byte[length];
                Buffer.BlockCopy(data, offset, result, 0, length);
                return result;
            }

            static float Component(byte[] d, int at, int ctype, bool normalized)
            {
                switch (ctype)
                {
                    case 5126: return BitConverter.ToSingle(d, at);
                    case 5121: return normalized ? d[at] / 255f : d[at];
                    case 5123: return normalized ? BitConverter.ToUInt16(d, at) / 65535f : BitConverter.ToUInt16(d, at);
                    case 5120: return normalized ? Math.Max((sbyte)d[at] / 127f, -1f) : (sbyte)d[at];
                    case 5122: return normalized ? Math.Max(BitConverter.ToInt16(d, at) / 32767f, -1f) : BitConverter.ToInt16(d, at);
                    case 5125: return BitConverter.ToUInt32(d, at);
                }
                throw new InvalidOperationException("Unknown number format in the model (" + ctype + ").");
            }

            static int Size(int ctype)
            {
                return ctype == 5120 || ctype == 5121 ? 1 : ctype == 5122 || ctype == 5123 ? 2 : 4;
            }

            static int Components(string type)
            {
                switch (type)
                {
                    case "SCALAR": return 1;
                    case "VEC2": return 2;
                    case "VEC3": return 3;
                    case "VEC4": return 4;
                    case "MAT4": return 16;
                }
                return 0;
            }

            static byte[] LoadUri(Doc doc, string uri)
            {
                if (uri.StartsWith("data:"))
                {
                    int comma = uri.IndexOf(',');
                    return Convert.FromBase64String(uri.Substring(comma + 1));
                }
                string file = Path.GetFullPath(Path.Combine(doc.Dir, Uri.UnescapeDataString(uri)));
                // Only files next to the model (its .bin and textures), never elsewhere on disk.
                if (!file.StartsWith(doc.Dir, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The model points outside its folder (" + uri + ").");
                if (!File.Exists(file)) throw new FileNotFoundException("The model needs " + uri + ", which isn't next to it.");
                return File.ReadAllBytes(file);
            }

            // ------------------------------------------------ matrices (column-major, like glTF)

            static float[] Identity()
            {
                return new float[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
            }

            static float[] Local(Dictionary<string, object> node)
            {
                List<object> matrix = List(node, "matrix");
                if (matrix.Count == 16)
                {
                    var m = new float[16];
                    for (int i = 0; i < 16; i++) m[i] = (float)Convert.ToDouble(matrix[i]);
                    return m;
                }
                float[] t = Vec(node, "translation", new float[] { 0, 0, 0 });
                float[] r = Vec(node, "rotation", new float[] { 0, 0, 0, 1 });
                float[] s = Vec(node, "scale", new float[] { 1, 1, 1 });
                float x = r[0], y = r[1], z = r[2], w = r[3];
                return new[]
                {
                    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
                    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
                    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
                    t[0], t[1], t[2], 1,
                };
            }

            static float[] Mul(float[] a, float[] b)
            {
                var r = new float[16];
                for (int col = 0; col < 4; col++)
                    for (int row = 0; row < 4; row++)
                    {
                        float sum = 0;
                        for (int k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
                        r[col * 4 + row] = sum;
                    }
                return r;
            }

            static float Det3(float[] m)
            {
                return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
            }

            static float[] Vec(Dictionary<string, object> o, string key, float[] fallback)
            {
                List<object> l = List(o, key);
                if (l.Count != fallback.Length) return fallback;
                var v = new float[l.Count];
                for (int i = 0; i < l.Count; i++) v[i] = (float)Convert.ToDouble(l[i]);
                return v;
            }

            // ------------------------------------------------ JSON helpers

            static List<object> List(Dictionary<string, object> o, string key)
            {
                object v;
                return o.TryGetValue(key, out v) && v is List<object> ? (List<object>)v : new List<object>();
            }

            static double Num(Dictionary<string, object> o, string key, double fallback)
            {
                object v;
                return o.TryGetValue(key, out v) && v is double ? (double)v : fallback;
            }

            static string Str(Dictionary<string, object> o, string key)
            {
                object v;
                return o.TryGetValue(key, out v) ? v as string : null;
            }
        }
    }
}
