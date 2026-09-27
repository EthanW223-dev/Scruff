using UnityEngine;

namespace Scruff
{
    /// <summary>"+$45" style text that pops up in the world, rises and fades.</summary>
    public class FloatingText : MonoBehaviour
    {
        TextBlock text;
        float age;
        const float Life = 1.4f;

        public static void Spawn(Vector3 position, string message, Color color, float size = 0.035f)
        {
            var go = new GameObject("FloatingText");
            go.transform.position = position;
            var ft = go.AddComponent<FloatingText>();
            ft.text = UIFactory.Text(go.transform, message, size, color, Vector3.zero);
        }

        void LateUpdate()
        {
            age += Time.deltaTime;
            float t = age / Life;
            transform.position += Vector3.up * Time.deltaTime * 0.18f * (1f - t);
            if (Game.Player != null)
            {
                Vector3 look = transform.position - Game.Player.HeadPosition;
                if (look.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(look, Vector3.up);
            }
            float pop = t < 0.12f ? Mathf.Lerp(0.6f, 1.15f, t / 0.12f) : Mathf.Lerp(1.15f, 1f, Mathf.Clamp01((t - 0.12f) * 5f));
            transform.localScale = Vector3.one * pop;
            text.Alpha = 1f - Mathf.Clamp01((t - 0.6f) / 0.4f);
            if (age >= Life) Destroy(gameObject);
        }
    }
}
