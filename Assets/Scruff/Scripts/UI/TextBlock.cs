using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// World-space text rendered as a mesh from Unity's built-in font (no TextMeshPro import needed).
    /// Text lies in the local XY plane and reads correctly when viewed looking along the object's +Z.
    ///
    /// Supports word wrapping, alignment and simple inline colours: <c>"Cash: &lt;#66ff66&gt;$120&lt;/&gt;"</c>.
    /// </summary>
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    public class TextBlock : MonoBehaviour
    {
        public enum HAlign { Left, Center, Right }
        public enum VAlign { Top, Middle, Bottom }

        const int FontPx = 48;
        const float Ascent = 0.82f;

        static Font font;
        static int fontVersion;

        [SerializeField] string text = "";
        [SerializeField] float size = 0.02f;
        [SerializeField] Color color = Color.white;
        [SerializeField] HAlign hAlign = HAlign.Center;
        [SerializeField] VAlign vAlign = VAlign.Middle;
        [SerializeField] float maxWidth;
        [SerializeField] float lineSpacing = 1.18f;

        Mesh mesh;
        bool dirty = true;
        int builtFontVersion = -1;
        float alpha = 1f;

        static readonly List<Vector3> verts = new List<Vector3>();
        static readonly List<Vector2> uvs = new List<Vector2>();
        static readonly List<Color> cols = new List<Color>();
        static readonly List<int> tris = new List<int>();
        static readonly List<char> glyphChars = new List<char>();
        static readonly List<Color> glyphColors = new List<Color>();
        static readonly List<Vector3Int> lines = new List<Vector3Int>(); // x: start, y: end (exclusive), z: width (px, rounded)
        static readonly List<float> lineWidths = new List<float>();
        static readonly System.Text.StringBuilder sb = new System.Text.StringBuilder();

        /// <summary>Measured size of the current text, in metres.</summary>
        public Vector2 Bounds { get; private set; }

        public string Text
        {
            get => text;
            set
            {
                if (text == value) return;
                text = value ?? "";
                dirty = true;
            }
        }

        public Color Color
        {
            get => color;
            set
            {
                if (color == value) return;
                color = value;
                dirty = true;
            }
        }

        public float Alpha
        {
            get => alpha;
            set
            {
                if (Mathf.Approximately(alpha, value)) return;
                alpha = value;
                dirty = true;
            }
        }

        public float Size
        {
            get => size;
            set
            {
                if (Mathf.Approximately(size, value)) return;
                size = value;
                dirty = true;
            }
        }

        public float MaxWidth
        {
            get => maxWidth;
            set
            {
                if (Mathf.Approximately(maxWidth, value)) return;
                maxWidth = value;
                dirty = true;
            }
        }

        public HAlign HorizontalAlign
        {
            get => hAlign;
            set
            {
                hAlign = value;
                dirty = true;
            }
        }

        public VAlign VerticalAlign
        {
            get => vAlign;
            set
            {
                vAlign = value;
                dirty = true;
            }
        }

        public static Font Font
        {
            get
            {
                if (font == null) LoadFont();
                return font;
            }
        }

        static void LoadFont()
        {
#if UNITY_2022_2_OR_NEWER
            font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
#else
            font = Resources.GetBuiltinResource<Font>("Arial.ttf");
#endif
            Font.textureRebuilt -= OnFontTextureRebuilt;
            Font.textureRebuilt += OnFontTextureRebuilt;
            // Warm the atlas with printable ASCII so later requests rarely force a rebuild.
            var warm = new System.Text.StringBuilder();
            for (char c = ' '; c <= '~'; c++) warm.Append(c);
            font.RequestCharactersInTexture(warm.ToString(), FontPx, FontStyle.Normal);
            UpdateMaterialTexture();
        }

        static void OnFontTextureRebuilt(Font f)
        {
            if (f != font) return;
            fontVersion++;
            UpdateMaterialTexture();
        }

        static void UpdateMaterialTexture()
        {
            if (font != null && font.material != null)
            {
                ScruffMaterials.Text.mainTexture = font.material.mainTexture;
                ScruffMaterials.TextOverlay.mainTexture = font.material.mainTexture;
            }
        }

        public static TextBlock Create(Transform parent, string text, float size, Color color, Vector3 localPosition,
            HAlign h = HAlign.Center, VAlign v = VAlign.Middle, float maxWidth = 0f)
        {
            var go = new GameObject("Text");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPosition;
            go.layer = parent != null ? parent.gameObject.layer : 0;
            var tb = go.AddComponent<TextBlock>();
            tb.text = text ?? "";
            tb.size = size;
            tb.color = color;
            tb.hAlign = h;
            tb.vAlign = v;
            tb.maxWidth = maxWidth;
            tb.Rebuild();
            return tb;
        }

        void Awake()
        {
            var r = GetComponent<MeshRenderer>();
            if (Font != null) r.sharedMaterial = ScruffMaterials.Text;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
        }

        void OnEnable()
        {
            if (builtFontVersion != fontVersion) dirty = true;
        }

        void LateUpdate()
        {
            if (dirty || builtFontVersion != fontVersion) Rebuild();
        }

        void OnDestroy()
        {
            if (mesh != null) Destroy(mesh);
        }

        public void Rebuild()
        {
            dirty = false;
            var f = Font;
            if (mesh == null)
            {
                mesh = new Mesh { name = "TextBlock" };
                mesh.MarkDynamic();
                GetComponent<MeshFilter>().sharedMesh = mesh;
            }

            ParseGlyphs();
            sb.Clear();
            for (int i = 0; i < glyphChars.Count; i++) sb.Append(glyphChars[i]);
            f.RequestCharactersInTexture(sb.ToString(), FontPx, FontStyle.Normal);
            builtFontVersion = fontVersion;

            float scale = size / FontPx;
            float maxW = maxWidth > 0f ? maxWidth / scale : float.MaxValue;
            LayoutLines(f, maxW);

            verts.Clear();
            uvs.Clear();
            cols.Clear();
            tris.Clear();

            float lineHeight = FontPx * lineSpacing;
            float blockHeight = lines.Count > 0 ? (lines.Count - 1) * lineHeight + FontPx : 0f;
            float yShift = vAlign == VAlign.Top ? 0f : vAlign == VAlign.Middle ? blockHeight * 0.5f : blockHeight;
            float widest = 0f;

            for (int l = 0; l < lines.Count; l++)
            {
                var line = lines[l];
                float w = lineWidths[l];
                widest = Mathf.Max(widest, w);
                float x = hAlign == HAlign.Left ? 0f : hAlign == HAlign.Center ? -w * 0.5f : -w;
                float baseline = -FontPx * Ascent - l * lineHeight + yShift;

                for (int i = line.x; i < line.y; i++)
                {
                    char c = glyphChars[i];
                    if (!f.GetCharacterInfo(c, out CharacterInfo ci, FontPx, FontStyle.Normal)) continue;
                    if (c != ' ' && c != '\n')
                    {
                        float x0 = (x + ci.minX) * scale, x1 = (x + ci.maxX) * scale;
                        float y0 = (baseline + ci.minY) * scale, y1 = (baseline + ci.maxY) * scale;
                        int vi = verts.Count;
                        verts.Add(new Vector3(x0, y0, 0f));
                        verts.Add(new Vector3(x0, y1, 0f));
                        verts.Add(new Vector3(x1, y1, 0f));
                        verts.Add(new Vector3(x1, y0, 0f));
                        uvs.Add(ci.uvBottomLeft);
                        uvs.Add(ci.uvTopLeft);
                        uvs.Add(ci.uvTopRight);
                        uvs.Add(ci.uvBottomRight);
                        var col = glyphColors[i];
                        col.a *= alpha;
                        col = Util.ToVertexColor(col);
                        cols.Add(col);
                        cols.Add(col);
                        cols.Add(col);
                        cols.Add(col);
                        tris.Add(vi);
                        tris.Add(vi + 1);
                        tris.Add(vi + 2);
                        tris.Add(vi);
                        tris.Add(vi + 2);
                        tris.Add(vi + 3);
                    }
                    x += ci.advance;
                }
            }

            mesh.Clear();
            mesh.SetVertices(verts);
            mesh.SetUVs(0, uvs);
            mesh.SetColors(cols);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            Bounds = new Vector2(widest * scale, blockHeight * scale);
        }

        void ParseGlyphs()
        {
            glyphChars.Clear();
            glyphColors.Clear();
            Color current = color;
            string s = text ?? "";
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '<')
                {
                    if (i + 8 < s.Length && s[i + 1] == '#' && s[i + 8] == '>' &&
                        ColorUtility.TryParseHtmlString(s.Substring(i + 1, 7), out var parsed))
                    {
                        parsed.a = color.a;
                        current = parsed;
                        i += 8;
                        continue;
                    }
                    if (i + 2 < s.Length && s[i + 1] == '/' && s[i + 2] == '>')
                    {
                        current = color;
                        i += 2;
                        continue;
                    }
                }
                if (c == '\r' || c == '\t') c = ' ';
                glyphChars.Add(c);
                glyphColors.Add(current);
            }
        }

        static float Advance(Font f, char c)
        {
            if (c == '\n') return 0f;
            return f.GetCharacterInfo(c, out CharacterInfo ci, FontPx, FontStyle.Normal) ? ci.advance : FontPx * 0.5f;
        }

        static void LayoutLines(Font f, float maxW)
        {
            lines.Clear();
            lineWidths.Clear();
            int lineStart = 0;
            int lastSpace = -1;
            float x = 0f;
            float widthBeforeSpace = 0f;
            int count = glyphChars.Count;

            for (int i = 0; i < count; i++)
            {
                char c = glyphChars[i];
                if (c == '\n')
                {
                    AddLine(lineStart, i, x);
                    lineStart = i + 1;
                    x = 0f;
                    lastSpace = -1;
                    continue;
                }

                float adv = Advance(f, c);
                if (c == ' ')
                {
                    lastSpace = i;
                    widthBeforeSpace = x;
                }
                else if (x + adv > maxW && i > lineStart)
                {
                    if (lastSpace >= lineStart)
                    {
                        AddLine(lineStart, lastSpace, widthBeforeSpace);
                        lineStart = lastSpace + 1;
                    }
                    else
                    {
                        AddLine(lineStart, i, x);
                        lineStart = i;
                    }
                    lastSpace = -1;
                    x = 0f;
                    for (int k = lineStart; k < i; k++) x += Advance(f, glyphChars[k]);
                }
                x += adv;
            }
            AddLine(lineStart, count, x);
        }

        static void AddLine(int start, int end, float width)
        {
            lines.Add(new Vector3Int(start, end, 0));
            lineWidths.Add(width);
        }
    }
}
