using UnityEngine;

namespace Scruff
{
    /// <summary>Hold a watering can under the tap and it fills up.</summary>
    public class Sink : MonoBehaviour
    {
        Transform tap;
        ParticleSystem stream;
        AudioSource loop;

        public static Sink Create(Transform parent, Vector3 position, float yaw)
        {
            var root = new GameObject("Sink");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var sink = root.AddComponent<Sink>();
            sink.Build();
            return sink;
        }

        void Build()
        {
            const float h = 0.68f;
            Geo.Mesh("Body", transform, b =>
            {
                b.AddBox(new Vector3(0f, h * 0.5f, 0f), new Vector3(0.7f, h, 0.5f), Quaternion.identity, new Color(0.62f, 0.66f, 0.7f), new Color(0.85f, 0.85f, 0.83f));
                // basin (dark inset)
                b.AddBox(new Vector3(0f, h + 0.001f, 0.02f), new Vector3(0.42f, 0.002f, 0.3f), Quaternion.identity, new Color(0.35f, 0.38f, 0.42f), new Color(0.35f, 0.38f, 0.42f));
                // tap
                b.AddCylinder(new Vector3(0f, h, -0.18f), 0.018f, 0.22f, 8, Palette.Metal);
                b.AddBox(new Vector3(0f, h + 0.22f, -0.11f), new Vector3(0.03f, 0.03f, 0.16f), Palette.Metal);
                b.AddCylinder(new Vector3(0f, h + 0.19f, -0.035f), 0.016f, 0.03f, 8, Palette.Metal);
                // cabinet doors
                b.AddBox(new Vector3(-0.17f, h * 0.45f, 0.252f), new Vector3(0.3f, h * 0.7f, 0.006f), new Color(0.55f, 0.6f, 0.65f));
                b.AddBox(new Vector3(0.17f, h * 0.45f, 0.252f), new Vector3(0.3f, h * 0.7f, 0.006f), new Color(0.55f, 0.6f, 0.65f));
            });
            Geo.Solid(transform, new Vector3(0f, h * 0.5f, 0f), new Vector3(0.7f, h, 0.5f));
            tap = Util.CreateChild(transform, "Tap", new Vector3(0f, h + 0.18f, -0.035f));
            stream = FX.CreateStream(tap, new Color(0.5f, 0.75f, 1f), 0.011f);
            var main = stream.main;
            main.startLifetime = 0.25f;
            loop = AudioManager.CreateLoop(tap, "pour_water", 6f);
        }

        void Update()
        {
            bool filling = false;
            foreach (var item in Item.All)
            {
                if (item.Def == null || item.Def.Id != "watering_can" || item.Charge >= 1f) continue;
                Vector3 local = tap.InverseTransformPoint(item.VisualBounds().center);
                if (new Vector2(local.x, local.z).magnitude < 0.14f && local.y < 0f && local.y > -0.4f)
                {
                    item.Charge = Mathf.Min(1f, item.Charge + Time.deltaTime * 0.3f);
                    filling = true;
                    if (item.HeldBy != null) item.HeldBy.Haptic(0.06f, Time.deltaTime * 1.5f);
                }
            }
            FX.SetEmitting(stream, filling);
            loop.volume = Mathf.MoveTowards(loop.volume, filling ? 0.45f : 0f, Time.deltaTime * 3f);
        }
    }
}
