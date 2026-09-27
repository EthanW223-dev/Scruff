using UnityEngine;
using UnityEngine.Rendering;

namespace Scruff
{
    /// <summary>
    /// Shared materials. Almost every mesh in the game uses <see cref="Flat"/> with vertex colours, which keeps
    /// draw calls low (dynamic/static batching works because the material is shared).
    /// Shaders live in Assets/Scruff/Resources/Scruff so they are always included in builds.
    /// </summary>
    public static class ScruffMaterials
    {
        static Material flat;
        static Material transparent;
        static Material overlay;
        static Material text;
        static Material textOverlay;

        public static Material Flat => flat != null ? flat : (flat = Create("Scruff/ScruffFlat", "Scruff/Flat", "Scruff Flat"));

        public static Material Transparent
        {
            get
            {
                if (transparent == null)
                {
                    transparent = Create("Scruff/ScruffTransparent", "Scruff/Transparent", "Scruff Transparent");
                    transparent.SetFloat("_ZTest", (float)CompareFunction.LessEqual);
                }
                return transparent;
            }
        }

        /// <summary>Transparent material drawn on top of everything (screen fades).</summary>
        public static Material Overlay
        {
            get
            {
                if (overlay == null)
                {
                    overlay = Create("Scruff/ScruffTransparent", "Scruff/Transparent", "Scruff Overlay");
                    overlay.SetFloat("_ZTest", (float)CompareFunction.Always);
                    overlay.renderQueue = 4000;
                }
                return overlay;
            }
        }

        public static Material Text
        {
            get
            {
                if (text == null)
                {
                    text = Create("Scruff/ScruffText", "Scruff/Text", "Scruff Text");
                    text.renderQueue = 3100;
                }
                return text;
            }
        }

        /// <summary>Text drawn on top of everything, including the screen fade (fade captions).</summary>
        public static Material TextOverlay
        {
            get
            {
                if (textOverlay == null)
                {
                    textOverlay = Create("Scruff/ScruffText", "Scruff/Text", "Scruff Text Overlay");
                    textOverlay.SetFloat("_ZTest", (float)CompareFunction.Always);
                    textOverlay.renderQueue = 4001;
                    if (text != null) textOverlay.mainTexture = text.mainTexture;
                }
                return textOverlay;
            }
        }

        static Material Create(string resourcePath, string shaderName, string materialName)
        {
            var shader = Resources.Load<Shader>(resourcePath);
            if (shader == null) shader = Shader.Find(shaderName);
            if (shader == null)
            {
                Debug.LogError($"[Scruff] Shader '{shaderName}' not found. Is Assets/Scruff/Resources/{resourcePath}.shader in the project?");
                shader = Shader.Find("Sprites/Default");
            }
            return new Material(shader) { name = materialName, enableInstancing = true };
        }

        /// <summary>Sensible lighting globals so things look right even before the day/night cycle runs.</summary>
        public static void SetDefaultGlobals()
        {
            Shader.SetGlobalVector("_ScruffLightDir", new Vector4(0.4f, 0.8f, -0.3f, 0f));
            Shader.SetGlobalColor("_ScruffLightColor", new Color(0.75f, 0.72f, 0.65f));
            Shader.SetGlobalColor("_ScruffAmbientSky", new Color(0.52f, 0.56f, 0.62f));
            Shader.SetGlobalColor("_ScruffAmbientGround", new Color(0.36f, 0.33f, 0.30f));
            Shader.SetGlobalColor("_ScruffFogColor", new Color(0.62f, 0.76f, 0.9f));
            Shader.SetGlobalVector("_ScruffFogParams", new Vector4(40f, 160f, 0.85f, 0f));
            Shader.SetGlobalFloat("_ScruffNightGlow", 0f);
            Shader.SetGlobalColor("_ScruffIndoorLight", new Color(0.4f, 0.4f, 0.4f));
            var nowhere = new Vector4(99999f, 99999f, 99999f, 0f);
            Shader.SetGlobalVector("_ScruffIndoorMin0", nowhere);
            Shader.SetGlobalVector("_ScruffIndoorMax0", -nowhere);
            Shader.SetGlobalVector("_ScruffIndoorMin1", nowhere);
            Shader.SetGlobalVector("_ScruffIndoorMax1", -nowhere);
        }
    }
}
