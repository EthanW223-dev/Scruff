using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public static class Util
    {
        /// <summary>Frame-rate independent exponential smoothing factor.</summary>
        public static float Damp(float sharpness, float dt) => 1f - Mathf.Exp(-sharpness * dt);

        public static float SmoothStep01(float t)
        {
            t = Mathf.Clamp01(t);
            return t * t * (3f - 2f * t);
        }

        public static string Money(int amount) => amount < 0 ? $"-${-amount:N0}" : $"${amount:N0}";

        public static Vector3 Flat(this Vector3 v) => new Vector3(v.x, 0f, v.z);

        public static float YawOf(Vector3 forward)
        {
            forward.y = 0f;
            if (forward.sqrMagnitude < 1e-6f) return 0f;
            return Quaternion.LookRotation(forward).eulerAngles.y;
        }

        public static T Pick<T>(IList<T> list, System.Random rng) => list[rng.Next(list.Count)];

        public static T Pick<T>(IList<T> list) => list[Random.Range(0, list.Count)];

        public static void SetVelocity(this Rigidbody rb, Vector3 velocity)
        {
#if UNITY_6000_0_OR_NEWER
            rb.linearVelocity = velocity;
#else
            rb.velocity = velocity;
#endif
        }

        public static Vector3 GetVelocity(this Rigidbody rb)
        {
#if UNITY_6000_0_OR_NEWER
            return rb.linearVelocity;
#else
            return rb.velocity;
#endif
        }

        public static void SetDamping(this Rigidbody rb, float linear, float angular)
        {
#if UNITY_6000_0_OR_NEWER
            rb.linearDamping = linear;
            rb.angularDamping = angular;
#else
            rb.drag = linear;
            rb.angularDrag = angular;
#endif
        }

        public static T GetOrAdd<T>(this GameObject go) where T : Component
        {
            var c = go.GetComponent<T>();
            return c != null ? c : go.AddComponent<T>();
        }

        public static Transform CreateChild(Transform parent, string name, Vector3 localPos = default, Quaternion? localRot = null)
        {
            var t = new GameObject(name).transform;
            t.SetParent(parent, false);
            t.localPosition = localPos;
            t.localRotation = localRot ?? Quaternion.identity;
            return t;
        }

        /// <summary>Converts an sRGB-authored colour to what should be written into vertex colours for the active colour space.</summary>
        public static Color ToVertexColor(Color c)
        {
            if (QualitySettings.activeColorSpace == ColorSpace.Linear)
            {
                var lin = c.linear;
                lin.a = c.a;
                return lin;
            }
            return c;
        }

        public static Color Hex(string hex)
        {
            return ColorUtility.TryParseHtmlString(hex.StartsWith("#") ? hex : "#" + hex, out var c) ? c : Color.magenta;
        }

        public static string Stars(float relationship01, int count = 5)
        {
            int filled = Mathf.Clamp(Mathf.RoundToInt(relationship01 * count), 0, count);
            return new string('*', filled) + new string('-', count - filled);
        }
    }
}
