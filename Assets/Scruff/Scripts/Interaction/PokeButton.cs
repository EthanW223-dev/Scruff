using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A physical button you press by poking it with a fingertip (like the Gorilla Tag computer).
    /// The button's face is the local XY plane at z = 0 and faces -Z (towards the player); pressing pushes along +Z.
    /// The cap visibly travels with your finger, clicks, and buzzes the controller.
    /// </summary>
    public class PokeButton : MonoBehaviour
    {
        public Vector2 size = new Vector2(0.06f, 0.03f);
        public float travel = 0.009f;
        public float cooldown = 0.25f;
        public bool interactable = true;

        public Transform cap;
        public MeshRenderer capRenderer;
        public TextBlock label;

        public event Action Pressed;

        Color baseColor = Color.white;
        float depth;
        float capDepth;
        bool pressed;
        float lastPress = -10f;
        bool hovered;
        readonly System.Collections.Generic.HashSet<PokeTip> armedTips = new System.Collections.Generic.HashSet<PokeTip>();
        static MaterialPropertyBlock mpb;
        static readonly int ColorId = Shader.PropertyToID("_Color");

        public void SetOnPressed(Action action)
        {
            Pressed = null;
            if (action != null) Pressed += action;
        }

        public void SetInteractable(bool value)
        {
            interactable = value;
            UpdateTint();
        }

        public void SetTint(Color c)
        {
            baseColor = c;
            UpdateTint();
        }

        void OnDisable()
        {
            armedTips.Clear();
            depth = capDepth = 0f;
            pressed = false;
            if (cap != null) cap.localPosition = Vector3.zero;
        }

        void Update()
        {
            float newDepth = 0f;
            bool newHover = false;
            PokeTip presser = null;

            if (interactable)
            {
                var tips = PokeTip.All;
                for (int i = 0; i < tips.Count; i++)
                {
                    var tip = tips[i];
                    Vector3 lp = transform.InverseTransformPoint(tip.Position);
                    float r = tip.radius;
                    bool inBounds = Mathf.Abs(lp.x) <= size.x * 0.5f + r * 0.5f && Mathf.Abs(lp.y) <= size.y * 0.5f + r * 0.5f;
                    if (!inBounds || lp.z < -0.08f)
                    {
                        armedTips.Remove(tip);
                        continue;
                    }
                    float front = lp.z + r; // how far the fingertip has pushed past the resting face
                    if (front <= 0.001f) armedTips.Add(tip); // approached from the front: allowed to press
                    if (lp.z - r > travel + 0.03f) armedTips.Remove(tip); // went through / came from behind
                    if (lp.z > -0.05f) newHover = true;
                    if (armedTips.Contains(tip) && front > 0f)
                    {
                        float d = Mathf.Min(front, travel);
                        if (d > newDepth)
                        {
                            newDepth = d;
                            presser = tip;
                        }
                    }
                }
            }
            else
            {
                armedTips.Clear();
            }

            depth = newDepth;
            if (!pressed && depth >= travel * 0.7f && Time.time - lastPress > cooldown)
            {
                pressed = true;
                lastPress = Time.time;
                AudioManager.Play("click", transform.position, 0.5f, UnityEngine.Random.Range(0.95f, 1.05f));
                if (presser != null) presser.Haptic(0.45f, 0.035f);
                try
                {
                    Pressed?.Invoke();
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
            }
            else if (pressed && depth <= travel * 0.3f)
            {
                pressed = false;
            }

            if (newHover != hovered)
            {
                hovered = newHover;
                UpdateTint();
            }

            capDepth = Mathf.Lerp(capDepth, depth, Util.Damp(40f, Time.deltaTime));
            if (cap != null) cap.localPosition = new Vector3(0f, 0f, capDepth);
        }

        void UpdateTint()
        {
            if (capRenderer == null) return;
            if (mpb == null) mpb = new MaterialPropertyBlock();
            Color c = interactable ? baseColor : new Color(0.55f, 0.55f, 0.55f);
            if (interactable && hovered) c = Color.Lerp(c, Color.white, 0.35f);
            capRenderer.GetPropertyBlock(mpb);
            mpb.SetColor(ColorId, c);
            capRenderer.SetPropertyBlock(mpb);
            if (label != null) label.Alpha = interactable ? 1f : 0.45f;
        }
    }
}
