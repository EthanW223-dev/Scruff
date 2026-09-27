using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Scruff
{
    /// <summary>
    /// Builds flat-shaded, vertex-coloured low-poly meshes out of simple shapes. Every face gets its own vertices
    /// so normals are per-face, which gives the faceted Gorilla Tag look.
    ///
    /// Vertex colour alpha stores emission (see ScruffFlat.shader), controlled with <see cref="Emission"/>
    /// (always glows) and <see cref="NightEmission"/> (glows only at night).
    /// </summary>
    public class MeshBuilder
    {
        readonly List<Vector3> vertices = new List<Vector3>();
        readonly List<Vector3> normals = new List<Vector3>();
        readonly List<Color> colors = new List<Color>();
        readonly List<int> triangles = new List<int>();
        readonly Stack<Matrix4x4> matrixStack = new Stack<Matrix4x4>();

        Matrix4x4 matrix = Matrix4x4.identity;

        /// <summary>0..1, how much newly added geometry glows at all times.</summary>
        public float Emission;
        /// <summary>0..1, how much newly added geometry glows at night.</summary>
        public float NightEmission;
        /// <summary>When true, triangles are wound the other way (faces point inwards).</summary>
        public bool Flip;
        /// <summary>When true, colour alpha is written as-is (for the Transparent material) instead of encoding emission.</summary>
        public bool RawAlpha;

        public int VertexCount => vertices.Count;
        public bool IsEmpty => vertices.Count == 0;

        public Matrix4x4 Matrix
        {
            get => matrix;
            set => matrix = value;
        }

        public void PushMatrix(Matrix4x4 m)
        {
            matrixStack.Push(matrix);
            matrix = matrix * m;
        }

        public void PushTRS(Vector3 pos, Quaternion rot, Vector3 scale) => PushMatrix(Matrix4x4.TRS(pos, rot, scale));

        public void PushTRS(Vector3 pos, Quaternion rot) => PushMatrix(Matrix4x4.TRS(pos, rot, Vector3.one));

        public void PopMatrix()
        {
            if (matrixStack.Count > 0) matrix = matrixStack.Pop();
        }

        public void Clear()
        {
            vertices.Clear();
            normals.Clear();
            colors.Clear();
            triangles.Clear();
            matrixStack.Clear();
            matrix = Matrix4x4.identity;
            Emission = 0f;
            NightEmission = 0f;
            Flip = false;
            RawAlpha = false;
        }

        Color Encode(Color c)
        {
            var vc = Util.ToVertexColor(c);
            if (RawAlpha) return vc;
            if (Emission > 0f) vc.a = 1f - (0.5f + 0.5f * Mathf.Clamp01(Emission));
            else if (NightEmission > 0f) vc.a = 1f - 0.5f * Mathf.Clamp01(NightEmission);
            else vc.a = 1f;
            return vc;
        }

        /// <summary>Adds a triangle. Vertices must be clockwise when seen from the front (Unity's convention).</summary>
        public void AddTriangle(Vector3 a, Vector3 b, Vector3 c, Color color)
        {
            if (Flip)
            {
                var tmp = b;
                b = c;
                c = tmp;
            }
            a = matrix.MultiplyPoint3x4(a);
            b = matrix.MultiplyPoint3x4(b);
            c = matrix.MultiplyPoint3x4(c);
            Vector3 n = Vector3.Cross(b - a, c - a);
            if (n.sqrMagnitude < 1e-14f) return; // degenerate
            n.Normalize();
            var enc = Encode(color);
            int i = vertices.Count;
            vertices.Add(a);
            vertices.Add(b);
            vertices.Add(c);
            normals.Add(n);
            normals.Add(n);
            normals.Add(n);
            colors.Add(enc);
            colors.Add(enc);
            colors.Add(enc);
            triangles.Add(i);
            triangles.Add(i + 1);
            triangles.Add(i + 2);
        }

        /// <summary>Adds a quad from four corners, clockwise when seen from the front.</summary>
        public void AddQuad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, Color color)
        {
            AddTriangle(a, b, c, color);
            AddTriangle(a, c, d, color);
        }

        public void AddBox(Vector3 center, Vector3 size, Color color) => AddBox(center, size, Quaternion.identity, color, color);

        public void AddBox(Vector3 center, Vector3 size, Quaternion rotation, Color color) => AddBox(center, size, rotation, color, color);

        /// <summary>Axis-aligned (in local space) box with a separate colour for the top face.</summary>
        public void AddBox(Vector3 center, Vector3 size, Quaternion rotation, Color sides, Color top, Color? bottom = null)
        {
            Vector3 h = size * 0.5f;
            Vector3 P(float x, float y, float z) => center + rotation * new Vector3(x * h.x, y * h.y, z * h.z);
            Color bot = bottom ?? sides;

            AddQuad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), top);        // +Y
            AddQuad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), bot);     // -Y
            AddQuad(P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), P(-1, -1, 1), sides);       // +Z
            AddQuad(P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), sides);   // -Z
            AddQuad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), sides);       // +X
            AddQuad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), sides);   // -X
        }

        /// <summary>Box given by min/max corners (handy for world building).</summary>
        public void AddBoxMinMax(Vector3 min, Vector3 max, Color sides, Color top)
        {
            AddBox((min + max) * 0.5f, max - min, Quaternion.identity, sides, top);
        }

        /// <summary>
        /// Truncated cone standing on <paramref name="bottomCenter"/> along +Y (rotated by <paramref name="rotation"/>).
        /// Radius 0 at the top gives a cone; equal radii a cylinder.
        /// </summary>
        public void AddFrustum(Vector3 bottomCenter, float bottomRadius, float topRadius, float height, int segments, Color color,
            Quaternion? rotation = null, bool capTop = true, bool capBottom = true, Color? capColor = null)
        {
            Quaternion r = rotation ?? Quaternion.identity;
            segments = Mathf.Max(3, segments);
            Color cap = capColor ?? color;
            Vector3 up = r * Vector3.up;
            Vector3 topCenter = bottomCenter + up * height;

            for (int i = 0; i < segments; i++)
            {
                float a0 = (i / (float)segments) * Mathf.PI * 2f;
                float a1 = ((i + 1) / (float)segments) * Mathf.PI * 2f;
                Vector3 d0 = r * new Vector3(Mathf.Cos(a0), 0f, Mathf.Sin(a0));
                Vector3 d1 = r * new Vector3(Mathf.Cos(a1), 0f, Mathf.Sin(a1));
                Vector3 b0 = bottomCenter + d0 * bottomRadius;
                Vector3 b1 = bottomCenter + d1 * bottomRadius;
                Vector3 t0 = topCenter + d0 * topRadius;
                Vector3 t1 = topCenter + d1 * topRadius;

                if (topRadius > 0.0001f)
                    AddQuad(b0, t0, t1, b1, color);
                else
                    AddTriangle(b0, topCenter, b1, color);

                if (capTop && topRadius > 0.0001f) AddTriangle(topCenter, t1, t0, cap);
                if (capBottom && bottomRadius > 0.0001f) AddTriangle(bottomCenter, b0, b1, cap);
            }
        }

        public void AddCylinder(Vector3 bottomCenter, float radius, float height, int segments, Color color,
            Quaternion? rotation = null, Color? capColor = null)
        {
            AddFrustum(bottomCenter, radius, radius, height, segments, color, rotation, true, true, capColor);
        }

        /// <summary>Cylinder between two points.</summary>
        public void AddCylinderBetween(Vector3 from, Vector3 to, float radius, int segments, Color color)
        {
            Vector3 dir = to - from;
            float len = dir.magnitude;
            if (len < 1e-5f) return;
            Quaternion rot = Quaternion.FromToRotation(Vector3.up, dir / len);
            AddFrustum(from, radius, radius, len, segments, color, rot);
        }

        /// <summary>Low-poly UV sphere (or ellipsoid via <paramref name="scale"/>).</summary>
        public void AddSphere(Vector3 center, float radius, Color color, int segments = 8, int rings = 5, Vector3? scale = null)
        {
            Vector3 s = (scale ?? Vector3.one) * radius;
            segments = Mathf.Max(3, segments);
            rings = Mathf.Max(2, rings);
            Vector3 P(int ring, int seg)
            {
                float phi = Mathf.PI * ring / rings;
                float theta = Mathf.PI * 2f * seg / segments;
                var d = new Vector3(Mathf.Sin(phi) * Mathf.Cos(theta), Mathf.Cos(phi), Mathf.Sin(phi) * Mathf.Sin(theta));
                return center + Vector3.Scale(d, s);
            }

            for (int j = 0; j < rings; j++)
            {
                for (int i = 0; i < segments; i++)
                {
                    AddQuad(P(j + 1, i), P(j, i), P(j, i + 1), P(j + 1, i + 1), color);
                }
            }
        }

        /// <summary>Octahedron-ish crystal/gem shape, elongated along Y.</summary>
        public void AddGem(Vector3 center, float radius, float height, int sides, Color color, float twist = 0f)
        {
            sides = Mathf.Max(3, sides);
            Vector3 top = center + Vector3.up * height * 0.5f;
            Vector3 bottom = center - Vector3.up * height * 0.5f;
            for (int i = 0; i < sides; i++)
            {
                float a0 = twist + (i / (float)sides) * Mathf.PI * 2f;
                float a1 = twist + ((i + 1) / (float)sides) * Mathf.PI * 2f;
                Vector3 p0 = center + new Vector3(Mathf.Cos(a0), 0f, Mathf.Sin(a0)) * radius;
                Vector3 p1 = center + new Vector3(Mathf.Cos(a1), 0f, Mathf.Sin(a1)) * radius;
                AddTriangle(p0, top, p1, color);
                AddTriangle(p1, bottom, p0, color);
            }
        }

        /// <summary>Flat, double-sided leaf/diamond shape lying in the XZ plane pointing along +Z (length) - used for plant leaves.</summary>
        public void AddLeaf(Vector3 basePos, Quaternion rotation, float length, float width, Color color, float droop = 0f)
        {
            Vector3 tip = basePos + rotation * new Vector3(0f, -droop, length);
            Vector3 mid = basePos + rotation * new Vector3(0f, droop * 0.25f, length * 0.45f);
            Vector3 left = mid + rotation * new Vector3(-width * 0.5f, 0f, 0f);
            Vector3 right = mid + rotation * new Vector3(width * 0.5f, 0f, 0f);
            // top side
            AddTriangle(basePos, left, mid, color);
            AddTriangle(basePos, mid, right, color);
            AddTriangle(left, tip, mid, color);
            AddTriangle(mid, tip, right, color);
            // bottom side
            Color under = color * 0.8f;
            under.a = 1f;
            AddTriangle(basePos, mid, left, under);
            AddTriangle(basePos, right, mid, under);
            AddTriangle(left, mid, tip, under);
            AddTriangle(mid, right, tip, under);
        }

        /// <summary>Appends another builder's geometry (already baked in its own space) transformed by the current matrix.</summary>
        public void Append(MeshBuilder other)
        {
            int offset = vertices.Count;
            for (int i = 0; i < other.vertices.Count; i++)
            {
                vertices.Add(matrix.MultiplyPoint3x4(other.vertices[i]));
                normals.Add(matrix.MultiplyVector(other.normals[i]).normalized);
                colors.Add(other.colors[i]);
            }
            for (int i = 0; i < other.triangles.Count; i++) triangles.Add(other.triangles[i] + offset);
        }

        public Mesh ToMesh(string name = "Scruff Mesh")
        {
            var mesh = new Mesh { name = name };
            if (vertices.Count > 65000) mesh.indexFormat = IndexFormat.UInt32;
            mesh.SetVertices(vertices);
            mesh.SetNormals(normals);
            mesh.SetColors(colors);
            mesh.SetTriangles(triangles, 0);
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>Creates a GameObject with this mesh using the shared flat material.</summary>
        public GameObject ToGameObject(string name, Transform parent = null)
        {
            var go = new GameObject(name);
            if (parent != null) go.transform.SetParent(parent, false);
            go.AddComponent<MeshFilter>().sharedMesh = ToMesh(name);
            go.AddComponent<MeshRenderer>().sharedMaterial = ScruffMaterials.Flat;
            return go;
        }

        public static MeshRenderer AddRenderer(GameObject go, Mesh mesh, Material material = null)
        {
            go.GetOrAdd<MeshFilter>().sharedMesh = mesh;
            var r = go.GetOrAdd<MeshRenderer>();
            r.sharedMaterial = material != null ? material : ScruffMaterials.Flat;
            r.shadowCastingMode = ShadowCastingMode.Off;
            r.receiveShadows = false;
            return r;
        }
    }
}
