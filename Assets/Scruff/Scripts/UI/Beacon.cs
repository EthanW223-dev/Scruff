using UnityEngine;

namespace Scruff
{
    /// <summary>A tall glowing column marking a deal meeting spot, readable from across the map.</summary>
    public class Beacon : MonoBehaviour
    {
        Transform label;
        MeshRenderer column;
        TextBlock text;

        public static Beacon Create(Vector3 position, string message, Color color)
        {
            var go = new GameObject("Beacon");
            go.transform.position = position;
            var b = go.AddComponent<Beacon>();
            var mb = new MeshBuilder { RawAlpha = true };
            mb.AddFrustum(Vector3.zero, 0.35f, 0.12f, 40f, 8, new Color(color.r, color.g, color.b, 0.22f), null, false, false);
            mb.AddFrustum(Vector3.zero, 0.8f, 0.8f, 0.03f, 16, new Color(color.r, color.g, color.b, 0.35f), null, true, false);
            var col = mb.ToGameObject("Column", go.transform);
            b.column = col.GetComponent<MeshRenderer>();
            b.column.sharedMaterial = ScruffMaterials.Transparent;
            b.label = Util.CreateChild(go.transform, "Label", new Vector3(0f, 2.4f, 0f));
            b.text = UIFactory.Text(b.label, message, 0.18f, color, Vector3.zero);
            return b;
        }

        void LateUpdate()
        {
            if (Game.Player == null) return;
            Vector3 head = Game.Player.HeadPosition;
            Vector3 look = label.position - head;
            float dist = look.magnitude;
            if (look.sqrMagnitude > 1e-4f) label.rotation = Quaternion.LookRotation(look, Vector3.up);
            // bigger far away so it stays readable, gone when you're right on top of it
            label.localScale = Vector3.one * Mathf.Clamp(dist / 12f, 0.35f, 3f);
            label.localPosition = new Vector3(0f, Mathf.Lerp(2.2f, 6f, Mathf.InverseLerp(5f, 60f, dist)), 0f);
            text.Alpha = Mathf.InverseLerp(1.5f, 4f, dist);
            column.enabled = dist > 3f;
        }
    }
}
