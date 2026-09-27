using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Builds world-space UI out of unlit slabs, TextBlocks and PokeButtons. Everything is laid out in the local
    /// XY plane with the readable side facing -Z, so point a UI root's +Z away from the player.
    /// </summary>
    public static class UIFactory
    {
        static Mesh UnitBox => ModelFactory.Cached("ui_unit_box", b =>
        {
            b.Emission = 1f;
            b.AddBox(new Vector3(0f, 0f, 0.5f), Vector3.one, Color.white);
        });

        static MaterialPropertyBlock mpb;
        static readonly int ColorId = Shader.PropertyToID("_Color");

        public static void Tint(Renderer r, Color c)
        {
            if (mpb == null) mpb = new MaterialPropertyBlock();
            r.GetPropertyBlock(mpb);
            mpb.SetColor(ColorId, c);
            r.SetPropertyBlock(mpb);
        }

        /// <summary>A flat coloured slab whose front face sits at localPos.z. Returns its renderer (the object is scaled, don't parent things to it).</summary>
        public static MeshRenderer Panel(Transform parent, Vector2 size, Color color, Vector3 localPos, float depth = 0.004f, string name = "Panel")
        {
            var go = new GameObject(name);
            go.layer = parent != null ? parent.gameObject.layer : 0;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localScale = new Vector3(size.x, size.y, depth);
            var r = MeshBuilder.AddRenderer(go, UnitBox);
            Tint(r, color);
            return r;
        }

        public static TextBlock Text(Transform parent, string text, float size, Color color, Vector3 localPos,
            TextBlock.HAlign h = TextBlock.HAlign.Center, TextBlock.VAlign v = TextBlock.VAlign.Middle, float maxWidth = 0f)
        {
            return TextBlock.Create(parent, text, size, color, localPos + new Vector3(0f, 0f, -0.0015f), h, v, maxWidth);
        }

        /// <summary>A pokeable button mounted on a surface at localPos.z (its cap sticks out ~1cm towards the viewer).</summary>
        public static PokeButton Button(Transform parent, string label, Vector2 size, Color color, Vector3 localPos, Action onPress, float textSize = 0f)
        {
            const float travel = 0.008f;
            var root = new GameObject("Button " + label);
            root.layer = Layers.Interactable;
            root.transform.SetParent(parent, false);
            // Stand the button proud of whatever it sits on, so the cap never sinks behind it when fully pressed.
            root.transform.localPosition = localPos + new Vector3(0f, 0f, -(travel + 0.003f));

            // frame behind the cap
            var frame = Panel(root.transform, size + new Vector2(0.004f, 0.004f), Color.Lerp(color, Color.black, 0.55f), new Vector3(0f, 0f, travel + 0.001f), 0.004f, "Frame");
            frame.gameObject.layer = Layers.Interactable;

            var cap = new GameObject("Cap").transform;
            cap.gameObject.layer = Layers.Interactable;
            cap.SetParent(root.transform, false);
            var capVisual = Panel(cap, size, Color.white, Vector3.zero, travel, "CapVisual");
            capVisual.gameObject.layer = Layers.Interactable;

            if (textSize <= 0f) textSize = Mathf.Min(size.y * 0.45f, 0.016f);
            var text = Text(cap, label, textSize, Palette.UIText, Vector3.zero, TextBlock.HAlign.Center, TextBlock.VAlign.Middle, size.x * 0.92f);

            var col = root.AddComponent<BoxCollider>();
            col.center = new Vector3(0f, 0f, travel * 0.5f);
            col.size = new Vector3(size.x, size.y, travel + 0.01f);

            var button = root.AddComponent<PokeButton>();
            button.size = size;
            button.travel = travel;
            button.cap = cap;
            button.capRenderer = capVisual;
            button.label = text;
            button.SetTint(color);
            if (onPress != null) button.Pressed += onPress;
            return button;
        }

        /// <summary>Horizontal progress bar. Returns the fill renderer's transform so callers can resize it with <see cref="SetBar"/>.</summary>
        public static Transform Bar(Transform parent, Vector2 size, Color back, Color fill, Vector3 localPos, float value)
        {
            Panel(parent, size, back, localPos, 0.002f, "BarBack");
            var fillGo = new GameObject("BarFill").transform;
            fillGo.SetParent(parent, false);
            fillGo.localPosition = localPos + new Vector3(-size.x * 0.5f, 0f, -0.001f);
            var r = Panel(fillGo, new Vector2(1f, size.y * 0.7f), fill, new Vector3(0.5f, 0f, 0f), 0.002f, "Fill");
            r.transform.localScale = new Vector3(1f, size.y * 0.7f, 0.002f);
            fillGo.localScale = new Vector3(Mathf.Max(0.0001f, size.x * Mathf.Clamp01(value)), 1f, 1f);
            return fillGo;
        }

        public static void SetBar(Transform fill, float fullWidth, float value)
        {
            fill.localScale = new Vector3(Mathf.Max(0.0001f, fullWidth * Mathf.Clamp01(value)), 1f, 1f);
        }
    }
}
