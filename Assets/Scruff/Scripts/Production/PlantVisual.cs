using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>Procedural low-poly plant for a given growth amount. Meshes are cached per strain/growth step/variant.</summary>
    public static class PlantVisual
    {
        public const int Steps = 24;
        public const int Variants = 6;

        static readonly Dictionary<string, Mesh> cache = new Dictionary<string, Mesh>();
        static readonly MeshBuilder mb = new MeshBuilder();

        static readonly Color Stem = new Color(0.38f, 0.48f, 0.22f);
        static readonly Color LeafDark = new Color(0.22f, 0.45f, 0.18f);
        static readonly Color LeafLight = new Color(0.36f, 0.62f, 0.26f);

        public static int Step(float growth) => Mathf.Clamp(Mathf.RoundToInt(growth * Steps), 0, Steps);

        public static float StemHeight(float growth) => 0.035f + growth * 0.46f;

        public static Mesh Get(StrainDef strain, float growth, int variant)
        {
            int step = Step(growth);
            variant = Mathf.Abs(variant) % Variants;
            string key = $"{strain?.Id}_{step}_{variant}";
            if (cache.TryGetValue(key, out var m) && m != null) return m;

            float g = step / (float)Steps;
            var rng = new System.Random(variant * 7919 + 17);
            Color tint = strain != null ? strain.Color : LeafLight;
            Color leafA = Color.Lerp(LeafDark, tint, 0.2f);
            Color leafB = Color.Lerp(LeafLight, tint, 0.25f);

            mb.Clear();
            float h = StemHeight(g);
            float stemR = 0.004f + 0.007f * g;
            mb.AddFrustum(Vector3.zero, stemR, stemR * 0.5f, h, 5, Stem);

            if (g < 0.08f)
            {
                // sprout: two little seed leaves
                float s = 0.018f + g * 0.3f;
                mb.AddLeaf(new Vector3(0f, h, 0f), Quaternion.Euler(-25f, 0f, 0f), s, s * 0.7f, leafB);
                mb.AddLeaf(new Vector3(0f, h, 0f), Quaternion.Euler(-25f, 180f, 0f), s, s * 0.7f, leafB);
            }
            else
            {
                int nodes = 1 + Mathf.FloorToInt(g * 5f);
                float baseYaw = (float)rng.NextDouble() * 360f;
                for (int n = 0; n < nodes; n++)
                {
                    float t = nodes == 1 ? 0.8f : 0.25f + 0.7f * n / (nodes - 1f);
                    float y = h * t;
                    float size = (0.035f + 0.11f * g) * (1f - 0.35f * n / Mathf.Max(1f, nodes));
                    float yaw = baseYaw + n * 90f + (float)rng.NextDouble() * 20f;
                    for (int side = 0; side < 2; side++)
                        AddFan(new Vector3(0f, y, 0f), yaw + side * 180f, size, n % 2 == 0 ? leafA : leafB, g);
                }
                // crown
                AddFan(new Vector3(0f, h, 0f), baseYaw + 45f, 0.03f + 0.04f * g, leafB, g, 60f);
            }

            m = mb.ToMesh("Plant " + key);
            cache[key] = m;
            return m;
        }

        static void AddFan(Vector3 at, float yaw, float size, Color color, float g, float tiltUp = 25f)
        {
            // Five-fingered fan leaf
            for (int i = 0; i < 5; i++)
            {
                float spread = (i - 2) * 26f;
                float len = size * (1f - Mathf.Abs(i - 2) * 0.2f);
                var rot = Quaternion.Euler(0f, yaw + spread, 0f) * Quaternion.Euler(-tiltUp + Mathf.Abs(i - 2) * 8f, 0f, 0f);
                mb.AddLeaf(at, rot, len, len * 0.26f, color, len * 0.18f * g);
            }
        }

        /// <summary>Local positions where buds sit on a plant of the given growth.</summary>
        public static void BudPositions(float growth, int variant, int count, List<Vector3> result)
        {
            result.Clear();
            float h = StemHeight(growth);
            var rng = new System.Random(variant * 104729 + 3);
            result.Add(new Vector3(0f, h + 0.005f, 0f));
            for (int i = 1; i < count; i++)
            {
                float yaw = (i * 137.5f + (float)rng.NextDouble() * 20f) * Mathf.Deg2Rad;
                float t = 0.55f + 0.4f * (i % 3) / 2f;
                float r = 0.03f + 0.04f * (1f - t);
                result.Add(new Vector3(Mathf.Cos(yaw) * r, h * t, Mathf.Sin(yaw) * r));
            }
        }
    }
}
