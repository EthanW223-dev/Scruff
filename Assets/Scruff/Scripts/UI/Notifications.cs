using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>Toast pop-ups that float just below your view and lazily follow your head.</summary>
    public class Notifications : MonoBehaviour
    {
        struct Request
        {
            public string Title;
            public string Body;
            public Color Color;
            public float Duration;
        }

        readonly Queue<Request> queue = new Queue<Request>();
        Transform root;
        TextBlock title;
        TextBlock body;
        MeshRenderer background;
        MeshRenderer accent;
        float timer;
        float duration;
        float scale;
        bool showing;
        bool placed;

        public static Notifications Create()
        {
            var go = new GameObject("Notifications");
            var n = go.AddComponent<Notifications>();
            n.root = Util.CreateChild(go.transform, "Toast");
            n.background = UIFactory.Panel(n.root, new Vector2(0.36f, 0.075f), new Color(0.08f, 0.09f, 0.11f), new Vector3(0f, 0f, 0.002f), 0.004f);
            n.accent = UIFactory.Panel(n.root, new Vector2(0.008f, 0.075f), Palette.UIAccent, new Vector3(-0.176f, 0f, 0f), 0.004f);
            n.title = UIFactory.Text(n.root, "", 0.017f, Palette.UIAccent, new Vector3(-0.162f, 0.018f, 0f), TextBlock.HAlign.Left);
            n.body = UIFactory.Text(n.root, "", 0.0125f, Palette.UIText, new Vector3(-0.162f, -0.002f, 0f), TextBlock.HAlign.Left, TextBlock.VAlign.Top, 0.33f);
            n.root.localScale = Vector3.zero;
            return n;
        }

        public void Show(string titleText, string bodyText, Color color, float seconds = 3.5f)
        {
            queue.Enqueue(new Request { Title = titleText, Body = bodyText, Color = color, Duration = seconds });
        }

        void LateUpdate()
        {
            var player = Game.Player;
            if (player == null) return;

            if (!showing && queue.Count > 0)
            {
                var r = queue.Dequeue();
                title.Text = r.Title;
                title.Color = r.Color;
                body.Text = r.Body ?? "";
                body.Rebuild();
                float h = Mathf.Max(0.075f, 0.04f + body.Bounds.y + 0.012f);
                background.transform.localScale = new Vector3(0.36f, h, 0.004f);
                background.transform.localPosition = new Vector3(0f, 0.0375f - h * 0.5f, 0.002f);
                accent.transform.localScale = new Vector3(0.008f, h, 0.004f);
                accent.transform.localPosition = new Vector3(-0.176f, 0.0375f - h * 0.5f, 0f);
                UIFactory.Tint(accent, r.Color);
                duration = queue.Count > 2 ? Mathf.Min(r.Duration, 2f) : r.Duration;
                timer = 0f;
                showing = true;
                AudioManager.PlayUI("notify", 0.35f);
            }

            var head = player.Head;
            Vector3 fwd = head.forward;
            fwd.y = Mathf.Clamp(fwd.y, -0.5f, 0.3f);
            fwd.Normalize();
            Vector3 target = head.position + fwd * 0.72f + Vector3.down * 0.2f;
            if (!placed)
            {
                root.position = target;
                placed = true;
            }
            root.position = Vector3.Lerp(root.position, target, Util.Damp(Vector3.Distance(root.position, target) > 0.35f ? 8f : 3f, Time.deltaTime));
            Vector3 look = root.position - head.position;
            if (look.sqrMagnitude > 1e-4f) root.rotation = Quaternion.Slerp(root.rotation, Quaternion.LookRotation(look, Vector3.up), Util.Damp(8f, Time.deltaTime));

            if (showing)
            {
                timer += Time.deltaTime;
                if (timer > duration) showing = false;
            }
            scale = Mathf.MoveTowards(scale, showing ? 1f : 0f, Time.deltaTime * 6f);
            root.localScale = Vector3.one * Util.SmoothStep01(scale);
        }
    }
}
