using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Drives the global lighting values the Scruff shaders read: sun/moon direction and colour, ambient,
    /// sky/fog colour, and the "night glow" that lights up windows and street lamps.
    /// </summary>
    public class DayNightCycle : MonoBehaviour
    {
        static readonly Color DaySky = new Color(0.62f, 0.78f, 0.92f);
        static readonly Color DuskSky = new Color(0.93f, 0.6f, 0.45f);
        static readonly Color NightSky = new Color(0.04f, 0.05f, 0.1f);
        static readonly Color DayLight = new Color(0.78f, 0.74f, 0.66f);
        static readonly Color DuskLight = new Color(0.75f, 0.45f, 0.3f);
        static readonly Color NightLight = new Color(0.14f, 0.17f, 0.26f);
        static readonly Color DayAmbientSky = new Color(0.52f, 0.56f, 0.62f);
        static readonly Color NightAmbientSky = new Color(0.12f, 0.13f, 0.2f);
        static readonly Color DayAmbientGround = new Color(0.36f, 0.33f, 0.3f);
        static readonly Color NightAmbientGround = new Color(0.07f, 0.07f, 0.1f);

        public Camera targetCamera;
        /// <summary>Used while no game is running (main menu).</summary>
        public float menuMinuteOfDay = 17.5f * 60f;

        public Color SkyColor { get; private set; }

        void Update()
        {
            float minute = Game.State != null ? Game.State.minuteOfDay : menuMinuteOfDay;
            Apply(minute);
        }

        public void Apply(float minuteOfDay)
        {
            float t = minuteOfDay / 1440f;
            // Sun rises ~6:00, peaks at noon, sets ~18:30. Elevation in -1..1.
            float angle = (t - 0.25f) * Mathf.PI * 2f;
            float elevation = Mathf.Sin(angle);
            float day = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(-0.12f, 0.3f, elevation));
            float dusk = Mathf.Clamp01(1f - Mathf.Abs(elevation) / 0.28f) * Mathf.Clamp01(day * 2f + 0.3f);

            Color sky = Color.Lerp(NightSky, DaySky, day);
            sky = Color.Lerp(sky, DuskSky, dusk * 0.7f);
            Color light = Color.Lerp(NightLight, DayLight, day);
            light = Color.Lerp(light, DuskLight, dusk * 0.6f);

            Vector3 sunDir = new Vector3(Mathf.Cos(angle) * 0.8f, Mathf.Max(0.15f, elevation), 0.35f).normalized;
            if (elevation < -0.05f)
            {
                // moonlight from the other side
                sunDir = new Vector3(-Mathf.Cos(angle) * 0.6f, 0.7f, -0.3f).normalized;
            }

            Shader.SetGlobalVector("_ScruffLightDir", sunDir);
            Shader.SetGlobalColor("_ScruffLightColor", light);
            Shader.SetGlobalColor("_ScruffAmbientSky", Color.Lerp(NightAmbientSky, DayAmbientSky, day));
            Shader.SetGlobalColor("_ScruffAmbientGround", Color.Lerp(NightAmbientGround, DayAmbientGround, day));
            Shader.SetGlobalColor("_ScruffFogColor", sky);
            Shader.SetGlobalVector("_ScruffFogParams", new Vector4(Mathf.Lerp(18f, 45f, day), Mathf.Lerp(95f, 170f, day), 0.9f, 0f));
            Shader.SetGlobalFloat("_ScruffNightGlow", 1f - day);
            Shader.SetGlobalColor("_ScruffIndoorLight", Color.Lerp(new Color(0.62f, 0.56f, 0.46f), new Color(0.4f, 0.4f, 0.4f), day));

            SkyColor = sky;
            if (targetCamera != null) targetCamera.backgroundColor = sky;
        }

        public static void SetIndoorBoxes(Bounds a, Bounds b)
        {
            Shader.SetGlobalVector("_ScruffIndoorMin0", a.min);
            Shader.SetGlobalVector("_ScruffIndoorMax0", a.max);
            Shader.SetGlobalVector("_ScruffIndoorMin1", b.min);
            Shader.SetGlobalVector("_ScruffIndoorMax1", b.max);
        }
    }
}
