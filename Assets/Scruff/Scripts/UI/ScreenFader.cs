using System;
using System.Collections;
using UnityEngine;

namespace Scruff
{
    /// <summary>Fades the view to a colour and back (sleep, busted, teleports). Comfortable in VR.</summary>
    public class ScreenFader : MonoBehaviour
    {
        MeshRenderer quad;
        TextBlock caption;
        float alpha;
        Color color = Color.black;
        static MaterialPropertyBlock mpb;

        public bool IsBusy { get; private set; }

        public static ScreenFader Create(Camera cam)
        {
            var go = new GameObject("ScreenFader");
            go.transform.SetParent(cam.transform, false);
            go.transform.localPosition = new Vector3(0f, 0f, cam.nearClipPlane + 0.03f);
            var f = go.AddComponent<ScreenFader>();
            var mb = new MeshBuilder { RawAlpha = true };
            mb.AddQuad(new Vector3(-1f, -1f, 0f), new Vector3(-1f, 1f, 0f), new Vector3(1f, 1f, 0f), new Vector3(1f, -1f, 0f), Color.white);
            var q = mb.ToGameObject("Quad", go.transform);
            f.quad = q.GetComponent<MeshRenderer>();
            f.quad.sharedMaterial = ScruffMaterials.Overlay;
            var capRoot = Util.CreateChild(go.transform, "Caption", new Vector3(0f, 0f, 0.3f));
            f.caption = TextBlock.Create(capRoot, "", 0.03f, Color.white, Vector3.zero, TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 0.5f);
            f.caption.GetComponent<MeshRenderer>().sharedMaterial = ScruffMaterials.TextOverlay;
            f.Apply();
            return f;
        }

        void Apply()
        {
            if (mpb == null) mpb = new MaterialPropertyBlock();
            quad.GetPropertyBlock(mpb);
            mpb.SetColor("_Color", new Color(color.r, color.g, color.b, alpha));
            quad.SetPropertyBlock(mpb);
            quad.enabled = alpha > 0.001f;
            caption.Alpha = alpha;
            caption.gameObject.SetActive(alpha > 0.01f && !string.IsNullOrEmpty(caption.Text));
        }

        public void SetImmediate(float a)
        {
            alpha = a;
            Apply();
        }

        public IEnumerator FadeTo(float target, float seconds)
        {
            float start = alpha;
            float t = 0f;
            while (t < 1f)
            {
                t += Time.unscaledDeltaTime / Mathf.Max(0.01f, seconds);
                alpha = Mathf.Lerp(start, target, Util.SmoothStep01(t));
                Apply();
                yield return null;
            }
        }

        /// <summary>Fade out, run <paramref name="middle"/>, hold, fade back in.</summary>
        public void FadeOutIn(Action middle, string message = null, float hold = 0.4f, Color? fadeColor = null)
        {
            if (IsBusy) return;
            StartCoroutine(FadeRoutine(middle, message, hold, fadeColor ?? Color.black));
        }

        IEnumerator FadeRoutine(Action middle, string message, float hold, Color c)
        {
            IsBusy = true;
            color = c;
            caption.Text = message ?? "";
            yield return FadeTo(1f, 0.35f);
            try
            {
                middle?.Invoke();
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
            yield return new WaitForSecondsRealtime(hold);
            yield return FadeTo(0f, 0.45f);
            caption.Text = "";
            Apply();
            IsBusy = false;
        }
    }
}
