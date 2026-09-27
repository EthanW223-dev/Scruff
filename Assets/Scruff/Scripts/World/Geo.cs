using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>Helpers for building static furniture/world geometry: one combined mesh plus simple box colliders.</summary>
    public static class Geo
    {
        public static GameObject Mesh(string name, Transform parent, Action<MeshBuilder> build, Vector3 localPos = default, Quaternion? localRot = null)
        {
            var mb = new MeshBuilder();
            build(mb);
            var go = mb.ToGameObject(name, parent);
            go.transform.localPosition = localPos;
            go.transform.localRotation = localRot ?? Quaternion.identity;
            go.GetComponent<MeshRenderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return go;
        }

        /// <summary>A solid box collider (Default layer = climbable) as a child of <paramref name="parent"/>, in its local space.</summary>
        public static BoxCollider Solid(Transform parent, Vector3 center, Vector3 size, SurfaceSound sound = SurfaceSound.Default, Quaternion? rotation = null)
        {
            var go = new GameObject("Collider");
            go.layer = Layers.Default;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = center;
            go.transform.localRotation = rotation ?? Quaternion.identity;
            var c = go.AddComponent<BoxCollider>();
            c.size = size;
            if (sound != SurfaceSound.Default) go.AddComponent<GorillaSurface>().sound = sound;
            return c;
        }

        /// <summary>Query-only collider (Interactable layer) - for things you grab/poke but can't stand on.</summary>
        public static Collider Touch(Transform parent, Vector3 center, Vector3 size)
        {
            var go = new GameObject("Touch");
            go.layer = Layers.Interactable;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = center;
            var c = go.AddComponent<BoxCollider>();
            c.size = size;
            return c;
        }

        /// <summary>Standard work table: top + four legs. Returns nothing; adds to <paramref name="b"/> and colliders to <paramref name="parent"/>.</summary>
        public static void Table(MeshBuilder b, Transform parent, Vector3 center, Vector2 size, float height, Color top, Color legs, SurfaceSound sound = SurfaceSound.Wood)
        {
            float t = 0.045f;
            b.AddBox(center + new Vector3(0f, height - t * 0.5f, 0f), new Vector3(size.x, t, size.y), Quaternion.identity, Color.Lerp(top, Color.black, 0.15f), top);
            float lx = size.x * 0.5f - 0.04f, lz = size.y * 0.5f - 0.04f;
            for (int i = 0; i < 4; i++)
            {
                float x = (i % 2 == 0 ? -1f : 1f) * lx, z = (i < 2 ? -1f : 1f) * lz;
                b.AddBox(center + new Vector3(x, (height - t) * 0.5f, z), new Vector3(0.045f, height - t, 0.045f), legs);
            }
            b.AddBox(center + new Vector3(0f, height * 0.25f, 0f), new Vector3(size.x - 0.1f, 0.03f, size.y - 0.1f), Quaternion.identity, legs, legs);
            if (parent != null) Solid(parent, center + new Vector3(0f, height * 0.5f, 0f), new Vector3(size.x, height, size.y), sound);
        }

        /// <summary>Builds a UI root that faces a player standing on the +Z side of <paramref name="parent"/>, tilted back by <paramref name="tilt"/> degrees.</summary>
        public static Transform UIRoot(Transform parent, Vector3 localPos, float tilt = 0f, string name = "UI")
        {
            return Util.CreateChild(parent, name, localPos, Quaternion.Euler(0f, 180f, 0f) * Quaternion.Euler(tilt, 0f, 0f));
        }
    }
}
