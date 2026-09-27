using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Procedural low-poly models for every item in the game. Meshes are cached and shared, so spawning a
    /// hundred baggies costs one mesh. All models are built with their pivot at the bottom centre, +Z forward.
    /// </summary>
    public static class ModelFactory
    {
        static readonly Dictionary<string, Mesh> cache = new Dictionary<string, Mesh>();
        static readonly MeshBuilder mb = new MeshBuilder();

        public static Mesh Cached(string key, System.Action<MeshBuilder> build)
        {
            if (cache.TryGetValue(key, out var mesh) && mesh != null) return mesh;
            mb.Clear();
            build(mb);
            mesh = mb.ToMesh(key);
            cache[key] = mesh;
            return mesh;
        }

        public static GameObject MeshObject(string name, Mesh mesh, Transform parent = null)
        {
            var go = new GameObject(name);
            if (parent != null) go.transform.SetParent(parent, false);
            MeshBuilder.AddRenderer(go, mesh);
            return go;
        }

        public static BoxCollider Box(GameObject go, Vector3 center, Vector3 size)
        {
            var c = go.AddComponent<BoxCollider>();
            c.center = center;
            c.size = size;
            return c;
        }

        public static SphereCollider Sphere(GameObject go, Vector3 center, float radius)
        {
            var c = go.AddComponent<SphereCollider>();
            c.center = center;
            c.radius = radius;
            return c;
        }

        public static CapsuleCollider Capsule(GameObject go, Vector3 center, float radius, float height, int direction = 1)
        {
            var c = go.AddComponent<CapsuleCollider>();
            c.center = center;
            c.radius = radius;
            c.height = height;
            c.direction = direction;
            return c;
        }

        // ------------------------------------------------------------------ Growing

        public static readonly Color Terracotta = new Color(0.72f, 0.40f, 0.26f);
        public static readonly Color SoilDry = new Color(0.42f, 0.30f, 0.20f);
        public static readonly Color SoilWet = new Color(0.22f, 0.15f, 0.10f);

        public static Mesh Pot() => Cached("pot", b =>
        {
            b.AddFrustum(Vector3.zero, 0.105f, 0.135f, 0.19f, 10, Terracotta, capTop: false);
            Color rim = Color.Lerp(Terracotta, Color.black, 0.08f);
            b.AddFrustum(new Vector3(0f, 0.17f, 0f), 0.145f, 0.148f, 0.035f, 10, rim, capTop: false, capBottom: true);
            // rim top ring + inner wall (inward facing) so you can't see through the pot
            b.Flip = true;
            b.AddFrustum(new Vector3(0f, 0.015f, 0f), 0.095f, 0.13f, 0.19f, 10, new Color(0.34f, 0.21f, 0.15f), capTop: false, capBottom: false);
            b.Flip = false;
            b.AddCylinder(new Vector3(0f, 0.005f, 0f), 0.098f, 0.01f, 10, new Color(0.3f, 0.2f, 0.14f));
            for (int i = 0; i < 10; i++)
            {
                float a0 = i / 10f * Mathf.PI * 2f, a1 = (i + 1) / 10f * Mathf.PI * 2f;
                Vector3 o0 = new Vector3(Mathf.Cos(a0), 0f, Mathf.Sin(a0)), o1 = new Vector3(Mathf.Cos(a1), 0f, Mathf.Sin(a1));
                Vector3 y = Vector3.up * 0.205f;
                b.AddQuad(y + o0 * 0.13f, y + o1 * 0.13f, y + o1 * 0.148f, y + o0 * 0.148f, rim);
            }
        });

        public static Mesh SoilDisk() => Cached("soil_disk", b =>
        {
            b.AddCylinder(new Vector3(0f, -0.012f, 0f), 0.128f, 0.012f, 10, Color.white);
            // a few clumps
            b.AddBox(new Vector3(0.04f, 0.002f, 0.03f), new Vector3(0.025f, 0.012f, 0.02f), Quaternion.Euler(0, 30, 0), Color.white * 0.9f + new Color(0, 0, 0, 1));
            b.AddBox(new Vector3(-0.05f, 0.002f, -0.02f), new Vector3(0.02f, 0.01f, 0.03f), Quaternion.Euler(0, 70, 0), Color.white * 0.85f + new Color(0, 0, 0, 1));
        });

        public static Mesh Bud(Color color) => Cached("bud_" + ColorUtility.ToHtmlStringRGB(color), b =>
        {
            Color dark = Color.Lerp(color, Color.black, 0.2f);
            Color hair = new Color(0.9f, 0.55f, 0.25f);
            b.AddSphere(new Vector3(0f, 0.022f, 0f), 0.022f, color, 7, 4, new Vector3(1f, 1.2f, 1f));
            b.AddSphere(new Vector3(0.014f, 0.016f, 0.006f), 0.015f, dark, 6, 3);
            b.AddSphere(new Vector3(-0.012f, 0.018f, -0.008f), 0.014f, dark, 6, 3);
            b.AddSphere(new Vector3(0.002f, 0.042f, 0.002f), 0.012f, color, 6, 3);
            b.AddBox(new Vector3(0.01f, 0.03f, 0.018f), new Vector3(0.004f, 0.012f, 0.004f), Quaternion.Euler(20, 0, 30), hair);
            b.AddBox(new Vector3(-0.015f, 0.036f, 0.01f), new Vector3(0.004f, 0.01f, 0.004f), Quaternion.Euler(-20, 0, -30), hair);
            b.AddBox(new Vector3(0.004f, 0.02f, -0.02f), new Vector3(0.004f, 0.01f, 0.004f), Quaternion.Euler(-30, 0, 10), hair);
        });

        public static Mesh Crystal(Color color) => Cached("crystal_" + ColorUtility.ToHtmlStringRGB(color), b =>
        {
            Color light = Color.Lerp(color, Color.white, 0.35f);
            b.Emission = 0.15f;
            b.AddGem(new Vector3(0f, 0.03f, 0f), 0.017f, 0.06f, 5, color);
            b.AddGem(new Vector3(0.016f, 0.02f, 0.006f), 0.01f, 0.036f, 4, light, 0.4f);
            b.AddGem(new Vector3(-0.012f, 0.018f, -0.01f), 0.009f, 0.03f, 4, light, 0.9f);
        });

        public static Mesh Seed() => Cached("seed", b =>
        {
            b.AddSphere(new Vector3(0f, 0.006f, 0f), 0.006f, new Color(0.45f, 0.35f, 0.22f), 6, 3, new Vector3(0.8f, 1f, 1.3f));
        });

        public static Mesh SeedPacket(Color color) => Cached("seedpacket_" + ColorUtility.ToHtmlStringRGB(color), b =>
        {
            b.AddBox(new Vector3(0f, 0.045f, 0f), new Vector3(0.065f, 0.09f, 0.008f), color);
            b.AddBox(new Vector3(0f, 0.035f, 0f), new Vector3(0.05f, 0.04f, 0.0095f), new Color(0.95f, 0.93f, 0.85f));
            b.AddLeaf(new Vector3(0f, 0.022f, -0.0051f), Quaternion.Euler(-90f, 0f, 0f), 0.028f, 0.016f, new Color(0.3f, 0.55f, 0.25f));
            b.AddBox(new Vector3(0f, 0.087f, 0f), new Vector3(0.066f, 0.008f, 0.009f), Color.Lerp(color, Color.black, 0.3f));
        });

        public static Mesh SoilBag() => Cached("soilbag", b =>
        {
            Color bag = new Color(0.45f, 0.33f, 0.22f);
            b.AddBox(new Vector3(0f, 0.12f, 0f), new Vector3(0.19f, 0.24f, 0.085f), bag);
            b.AddBox(new Vector3(0f, 0.25f, 0f), new Vector3(0.17f, 0.03f, 0.05f), Color.Lerp(bag, Color.black, 0.25f));
            b.AddBox(new Vector3(0f, 0.12f, -0.0435f), new Vector3(0.13f, 0.1f, 0.002f), new Color(0.9f, 0.86f, 0.7f));
            b.AddBox(new Vector3(0f, 0.12f, 0.0435f), new Vector3(0.13f, 0.1f, 0.002f), new Color(0.9f, 0.86f, 0.7f));
            b.AddLeaf(new Vector3(0f, 0.09f, -0.0448f), Quaternion.Euler(-90f, 0f, 0f), 0.07f, 0.04f, new Color(0.3f, 0.6f, 0.25f));
        });

        public static Mesh WateringCan() => Cached("wateringcan", b =>
        {
            Color c = new Color(0.30f, 0.62f, 0.52f);
            Color d = Color.Lerp(c, Color.black, 0.3f);
            b.AddCylinder(Vector3.zero, 0.07f, 0.15f, 10, c, null, d);
            b.AddFrustum(new Vector3(0f, 0.15f, -0.01f), 0.045f, 0.035f, 0.02f, 8, d);
            b.AddCylinderBetween(new Vector3(0f, 0.04f, 0.05f), new Vector3(0f, 0.2f, 0.19f), 0.011f, 6, c);
            b.AddFrustum(new Vector3(0f, 0.2f, 0.19f), 0.013f, 0.026f, 0.025f, 8, d, Quaternion.Euler(45f, 0f, 0f));
            // handle
            b.AddBox(new Vector3(0f, 0.21f, -0.035f), new Vector3(0.022f, 0.02f, 0.1f), d);
            b.AddBox(new Vector3(0f, 0.18f, -0.085f), new Vector3(0.022f, 0.07f, 0.02f), d);
            b.AddBox(new Vector3(0f, 0.105f, -0.08f), new Vector3(0.022f, 0.09f, 0.02f), d);
        });

        public static Mesh Bottle(Color body, Color cap, float radius, float height) =>
            Cached($"bottle_{ColorUtility.ToHtmlStringRGB(body)}_{ColorUtility.ToHtmlStringRGB(cap)}_{radius}_{height}", b =>
            {
                float bodyH = height * 0.7f;
                b.AddCylinder(Vector3.zero, radius, bodyH, 8, body);
                b.AddFrustum(new Vector3(0f, bodyH, 0f), radius, radius * 0.4f, height * 0.12f, 8, body, capTop: false);
                b.AddCylinder(new Vector3(0f, bodyH + height * 0.12f, 0f), radius * 0.4f, height * 0.08f, 8, body);
                b.AddCylinder(new Vector3(0f, bodyH + height * 0.2f, 0f), radius * 0.45f, height * 0.08f, 8, cap);
                b.AddCylinder(new Vector3(0f, bodyH * 0.25f, 0f), radius * 1.02f, bodyH * 0.45f, 8, new Color(0.95f, 0.94f, 0.9f));
            });

        public static Mesh GlowBottle() => Cached("glowbottle", b =>
        {
            b.Emission = 0.8f;
            b.AddCylinder(Vector3.zero, 0.03f, 0.09f, 8, new Color(0.35f, 1f, 0.55f));
            b.Emission = 0f;
            b.AddFrustum(new Vector3(0f, 0.09f, 0f), 0.03f, 0.012f, 0.02f, 8, new Color(0.35f, 1f, 0.55f), capTop: false);
            b.AddCylinder(new Vector3(0f, 0.11f, 0f), 0.013f, 0.015f, 8, new Color(0.15f, 0.15f, 0.18f));
        });

        public static Mesh Can(Color main, Color stripe) => Cached($"can_{ColorUtility.ToHtmlStringRGB(main)}_{ColorUtility.ToHtmlStringRGB(stripe)}", b =>
        {
            b.AddCylinder(Vector3.zero, 0.028f, 0.105f, 10, main, null, Palette.Metal);
            b.AddCylinder(new Vector3(0f, 0.035f, 0f), 0.0285f, 0.03f, 10, stripe, null, stripe);
            b.AddCylinder(new Vector3(0f, 0.105f, 0f), 0.024f, 0.006f, 10, Palette.Metal);
        });

        public static Mesh SmallBox(Color main, Color stripe, Vector3 size) => Cached($"smallbox_{ColorUtility.ToHtmlStringRGB(main)}_{size}", b =>
        {
            b.AddBox(new Vector3(0f, size.y * 0.5f, 0f), size, main);
            b.AddBox(new Vector3(0f, size.y * 0.55f, 0f), new Vector3(size.x * 1.01f, size.y * 0.25f, size.z * 1.01f), stripe);
        });

        public static Mesh Candy() => Cached("candy", b =>
        {
            Color pink = new Color(0.95f, 0.45f, 0.65f);
            Color wrap = new Color(0.98f, 0.9f, 0.95f);
            b.AddSphere(new Vector3(0f, 0.022f, 0f), 0.022f, pink, 8, 5, new Vector3(1.2f, 1f, 1f));
            b.AddFrustum(new Vector3(0.024f, 0.022f, 0f), 0.004f, 0.016f, 0.025f, 6, wrap, Quaternion.Euler(0f, 0f, -90f));
            b.AddFrustum(new Vector3(-0.024f, 0.022f, 0f), 0.004f, 0.016f, 0.025f, 6, wrap, Quaternion.Euler(0f, 0f, 90f));
        });

        public static Mesh GlitterTube() => Cached("glitter", b =>
        {
            b.AddCylinder(Vector3.zero, 0.014f, 0.1f, 8, new Color(0.6f, 0.35f, 0.8f));
            b.Emission = 0.9f;
            for (int i = 0; i < 6; i++)
            {
                float a = i * 1.1f;
                b.AddBox(new Vector3(Mathf.Cos(a) * 0.0145f, 0.015f + i * 0.013f, Mathf.Sin(a) * 0.0145f), Vector3.one * 0.004f,
                    i % 2 == 0 ? new Color(1f, 0.85f, 1f) : new Color(0.8f, 0.95f, 1f));
            }
            b.Emission = 0f;
            b.AddCylinder(new Vector3(0f, 0.1f, 0f), 0.015f, 0.012f, 8, new Color(0.95f, 0.95f, 0.95f));
        });

        // ------------------------------------------------------------------ Packaging

        public static Mesh Baggie() => Cached("baggie", b =>
        {
            b.AddBox(new Vector3(0f, 0.045f, 0f), new Vector3(0.07f, 0.09f, 0.012f), new Color(0.86f, 0.9f, 0.94f));
            b.AddBox(new Vector3(0f, 0.086f, 0f), new Vector3(0.072f, 0.007f, 0.014f), new Color(0.35f, 0.55f, 0.9f));
        });

        public static Mesh BagContents() => Cached("bag_contents", b =>
        {
            b.AddBox(new Vector3(0f, 0.5f, 0f), new Vector3(1f, 1f, 1f), Color.white);
        });

        public static Mesh JarGlass() => Cached("jar_glass", b =>
        {
            b.RawAlpha = true;
            b.AddCylinder(Vector3.zero, 0.042f, 0.1f, 10, new Color(0.8f, 0.92f, 1f, 0.28f));
        });

        public static Mesh JarLid() => Cached("jar_lid", b =>
        {
            b.AddCylinder(new Vector3(0f, 0.1f, 0f), 0.044f, 0.018f, 10, new Color(0.18f, 0.2f, 0.22f));
            b.AddCylinder(Vector3.zero, 0.043f, 0.006f, 10, new Color(0.7f, 0.82f, 0.9f));
        });

        public static Mesh JarContents() => Cached("jar_contents", b =>
        {
            b.AddCylinder(Vector3.zero, 1f, 1f, 10, Color.white);
        });

        public static Mesh Cash(int stacks) => Cached("cash_" + stacks, b =>
        {
            Color bill = new Color(0.45f, 0.68f, 0.40f);
            Color band = new Color(0.95f, 0.9f, 0.7f);
            for (int i = 0; i < stacks; i++)
            {
                Vector3 c = new Vector3(0f, 0.007f + i * 0.0125f, 0f);
                b.AddBox(c, new Vector3(0.078f, 0.012f, 0.036f), Quaternion.Euler(0f, i * 7f, 0f), bill, Color.Lerp(bill, Color.white, 0.15f));
                b.AddBox(c, new Vector3(0.016f, 0.0128f, 0.0365f), Quaternion.Euler(0f, i * 7f, 0f), band);
            }
        });

        // ------------------------------------------------------------------ Player hand

        /// <summary>
        /// Chunky Gorilla-Tag-style mitt. Returns meshes for the palm, the three-finger block, the index finger and
        /// the thumb so they can be animated separately. Pivots: palm centre; fingers at knuckles.
        /// </summary>
        public static void HandParts(bool left, Color fur, Color skin, out Mesh palm, out Mesh fingers, out Mesh index, out Mesh thumb)
        {
            string side = left ? "L" : "R";
            string key = ColorUtility.ToHtmlStringRGB(fur);
            float s = left ? -1f : 1f;

            palm = Cached($"hand_palm_{side}_{key}", b =>
            {
                b.AddBox(new Vector3(0f, 0f, 0f), new Vector3(0.085f, 0.04f, 0.09f), Quaternion.identity, fur, fur);
                b.AddBox(new Vector3(0f, -0.021f, 0.005f), new Vector3(0.07f, 0.004f, 0.075f), skin);
                b.AddBox(new Vector3(0f, 0f, -0.055f), new Vector3(0.07f, 0.034f, 0.03f), Color.Lerp(fur, Color.black, 0.15f));
            });
            fingers = Cached($"hand_fingers_{side}_{key}", b =>
            {
                b.AddBox(new Vector3(s * 0.012f, 0f, 0.03f), new Vector3(0.058f, 0.032f, 0.06f), Quaternion.identity, fur, fur);
                b.AddBox(new Vector3(s * 0.012f, -0.017f, 0.03f), new Vector3(0.05f, 0.003f, 0.05f), skin);
            });
            index = Cached($"hand_index_{side}_{key}", b =>
            {
                b.AddBox(new Vector3(0f, 0f, 0.032f), new Vector3(0.024f, 0.028f, 0.064f), Quaternion.identity, fur, fur);
                b.AddBox(new Vector3(0f, -0.0145f, 0.036f), new Vector3(0.02f, 0.003f, 0.05f), skin);
            });
            thumb = Cached($"hand_thumb_{side}_{key}", b =>
            {
                b.AddBox(new Vector3(0f, 0f, 0.022f), new Vector3(0.026f, 0.026f, 0.05f), Quaternion.identity, fur, fur);
            });
        }
    }
}
