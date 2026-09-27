using UnityEngine;

namespace Scruff
{
    /// <summary>Speech bubble with a typewriter effect and Animal-Crossing-style babble, plus a status icon (!, ?, $).</summary>
    public class SpeechBubble : MonoBehaviour
    {
        TextBlock text;
        MeshRenderer background;
        Transform bubble;
        TextBlock icon;
        string full = "";
        int shown;
        float charTimer;
        float hideAt;
        float voicePitch = 1f;
        float scale;
        bool visible;
        float iconPulse;

        public bool IsShowing => visible;

        public static SpeechBubble Create(Transform parent, float height)
        {
            var root = Util.CreateChild(parent, "Speech", new Vector3(0f, height, 0f));
            var sb = root.gameObject.AddComponent<SpeechBubble>();
            sb.bubble = Util.CreateChild(root, "Bubble");
            sb.background = UIFactory.Panel(sb.bubble, new Vector2(0.4f, 0.1f), new Color(0.97f, 0.96f, 0.92f), new Vector3(0f, 0f, 0.002f), 0.004f, "Bg");
            sb.text = UIFactory.Text(sb.bubble, "", 0.045f, new Color(0.12f, 0.12f, 0.14f), Vector3.zero, TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 0.8f);
            sb.bubble.localScale = Vector3.zero;
            sb.icon = UIFactory.Text(root, "", 0.16f, Palette.UIWarning, new Vector3(0f, -0.05f, 0f));
            return sb;
        }

        public void Show(string line, float duration, float pitch)
        {
            full = line ?? "";
            shown = 0;
            charTimer = 0f;
            voicePitch = pitch;
            hideAt = Time.time + duration + full.Length / 38f;
            visible = true;
            text.Text = "";
            // size the bubble for the full text up front so it doesn't jitter while typing
            text.Text = full;
            text.Rebuild();
            var size = text.Bounds;
            background.transform.localScale = new Vector3(size.x + 0.08f, size.y + 0.06f, 0.004f);
            text.Text = "";
        }

        public void Hide() => hideAt = 0f;

        public void SetIcon(string symbol, Color color)
        {
            if (icon.Text != symbol) iconPulse = 1f;
            icon.Text = symbol ?? "";
            icon.Color = color;
        }

        void LateUpdate()
        {
            var player = Game.Player;
            if (player == null) return;
            Vector3 toCam = transform.position - player.HeadPosition;
            float dist = toCam.magnitude;
            if (toCam.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(toCam, Vector3.up);

            if (visible && Time.time > hideAt) visible = false;
            float target = visible ? 1f : 0f;
            scale = Mathf.MoveTowards(scale, target, Time.deltaTime * 7f);
            float pop = scale < 1f && visible ? Mathf.Sin(scale * Mathf.PI) * 0.15f : 0f;
            // keep bubbles readable from further away
            float distanceScale = Mathf.Clamp(dist / 3f, 0.7f, 2.2f);
            bubble.localScale = Vector3.one * (Util.SmoothStep01(scale) + pop) * distanceScale * 0.5f;
            bubble.localPosition = new Vector3(0f, 0.12f * distanceScale, 0f);

            if (visible && shown < full.Length)
            {
                charTimer -= Time.deltaTime;
                while (charTimer <= 0f && shown < full.Length)
                {
                    // skip over colour tags in one go
                    if (full[shown] == '<')
                    {
                        int close = full.IndexOf('>', shown);
                        shown = close >= 0 ? close + 1 : shown + 1;
                        continue;
                    }
                    shown++;
                    charTimer += 1f / 38f;
                    if (shown % 3 == 0 && dist < 14f && full[shown - 1] != ' ')
                        AudioManager.Play("blip", transform.position, 0.28f, voicePitch * Random.Range(0.88f, 1.15f));
                }
                text.Text = full.Substring(0, Mathf.Min(shown, full.Length));
            }

            iconPulse = Mathf.MoveTowards(iconPulse, 0f, Time.deltaTime * 3f);
            icon.transform.localScale = Vector3.one * (1f + iconPulse * 0.5f + Mathf.Sin(Time.time * 4f) * 0.05f) * Mathf.Clamp(dist / 4f, 0.8f, 2.5f);
            icon.gameObject.SetActive(!string.IsNullOrEmpty(icon.Text) && !visible);
        }
    }
}
