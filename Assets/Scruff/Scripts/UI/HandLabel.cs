using UnityEngine;

namespace Scruff
{
    /// <summary>Small floating tag above whatever a hand is hovering or holding ("Alley Purple - Premium - $34").</summary>
    public class HandLabel
    {
        readonly Transform owner;
        Transform root;
        TextBlock text;
        MeshRenderer background;
        string lastText;
        Vector3 smoothedPos;
        bool visible;

        public HandLabel(Transform owner)
        {
            this.owner = owner;
        }

        void Create()
        {
            root = new GameObject("HandLabel").transform;
            background = UIFactory.Panel(root, new Vector2(0.1f, 0.03f), new Color(0.08f, 0.09f, 0.11f), new Vector3(0f, 0f, 0.001f), 0.002f, "LabelBg");
            text = UIFactory.Text(root, "", 0.0155f, Palette.UIText, Vector3.zero, TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 0.2f);
        }

        public void Update(Grabbable target, bool held, Transform head)
        {
            string s = target != null ? target.GetLabel() : null;
            if (string.IsNullOrEmpty(s) || head == null)
            {
                if (visible && root != null) root.gameObject.SetActive(false);
                visible = false;
                return;
            }
            if (root == null) Create();
            if (!visible)
            {
                root.gameObject.SetActive(true);
                visible = true;
                lastText = null;
            }
            if (s != lastText)
            {
                lastText = s;
                text.Text = s;
                text.Rebuild();
                var size = text.Bounds;
                background.transform.localScale = new Vector3(size.x + 0.018f, size.y + 0.012f, 0.002f);
            }

            var b = target.VisualBounds();
            Vector3 pos = b.center + Vector3.up * (b.extents.y + 0.045f);
            // nudge towards the viewer a touch so it doesn't clip into the object
            pos += (head.position - pos).normalized * 0.02f;
            smoothedPos = Vector3.Distance(smoothedPos, pos) > 0.3f ? pos : Vector3.Lerp(smoothedPos, pos, Util.Damp(held ? 30f : 18f, Time.deltaTime));
            root.position = smoothedPos;
            Vector3 fwd = smoothedPos - head.position;
            if (fwd.sqrMagnitude > 1e-5f) root.rotation = Quaternion.LookRotation(fwd, Vector3.up);
        }
    }
}
