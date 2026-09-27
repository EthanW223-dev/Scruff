using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Anything a hand can grab. Held objects are kinematic and follow the hand exactly (no lag, no jitter);
    /// on release they get the hand's throw velocity. Subclasses can redirect a grab (dispensers, cash, plant buds)
    /// or stay put and react to the hand instead (dials, doors).
    /// </summary>
    public class Grabbable : MonoBehaviour
    {
        [Header("Grabbing")]
        public bool snapToHand;
        public Vector3 holdPosition;
        public Vector3 holdEuler;
        [Tooltip("False for things that stay where they are and react to the hand (dials, doors).")]
        public bool followsHand = true;
        public float throwMultiplier = 1.15f;
        [Tooltip("Wins ties when several grabbables overlap the hand.")]
        public float grabPriority;
        public bool allowGrab = true;

        public PlayerHand HeldBy { get; private set; }
        public bool IsHeld => HeldBy != null;
        public ItemSocket Socket { get; internal set; }
        public Rigidbody Body { get; private set; }

        public event Action<PlayerHand> Grabbed;
        public event Action<PlayerHand> Released;

        Renderer[] renderers;
        int highlightCount;
        static MaterialPropertyBlock mpb;
        static readonly int HighlightId = Shader.PropertyToID("_Highlight");

        protected virtual void Awake()
        {
            Body = GetComponent<Rigidbody>();
            CacheRenderers();
        }

        public void CacheRenderers()
        {
            renderers = GetComponentsInChildren<Renderer>(true);
        }

        public virtual bool CanGrab(PlayerHand hand) => allowGrab && isActiveAndEnabled;

        /// <summary>What the hand actually ends up holding. Return another grabbable to redirect, or null if the grab was consumed.</summary>
        public virtual Grabbable ResolveGrab(PlayerHand hand) => this;

        /// <summary>Short text shown floating above the object while hovered or held. Null = no label.</summary>
        public virtual string GetLabel() => null;

        internal void BeginGrab(PlayerHand hand)
        {
            if (Socket != null) Socket.Remove(this);
            HeldBy = hand;
            if (followsHand)
            {
                if (Body != null)
                {
                    Body.isKinematic = true;
                    Body.interpolation = RigidbodyInterpolation.None;
                }
                var root = Game.World != null ? Game.World.ItemsRoot : null;
                if (transform.parent != root) transform.SetParent(root, true);
            }
            OnGrabbed(hand);
            Grabbed?.Invoke(hand);
        }

        internal void EndGrab(PlayerHand hand)
        {
            if (HeldBy != hand) return;
            HeldBy = null;
            OnReleased(hand);
            Released?.Invoke(hand);
        }

        public void ReleaseToPhysics(Vector3 velocity, Vector3 angularVelocity)
        {
            if (Body == null) return;
            Body.isKinematic = false;
            Body.interpolation = RigidbodyInterpolation.Interpolate;
            Body.SetVelocity(velocity);
            Body.angularVelocity = angularVelocity;
            Body.WakeUp();
        }

        protected virtual void OnGrabbed(PlayerHand hand) { }

        protected virtual void OnReleased(PlayerHand hand) { }

        /// <summary>Called every frame while held, after the object has been posed.</summary>
        public virtual void OnHeldUpdate(PlayerHand hand) { }

        public virtual void OnTriggerDown(PlayerHand hand) { }

        public virtual void OnTriggerUp(PlayerHand hand) { }

        public void SetHighlight(bool on)
        {
            highlightCount = Mathf.Max(0, highlightCount + (on ? 1 : -1));
            ApplyHighlight(highlightCount > 0 ? new Color(1f, 0.95f, 0.75f, 0.28f) : new Color(1f, 1f, 1f, 0f));
        }

        protected void ApplyHighlight(Color c)
        {
            if (renderers == null) return;
            if (mpb == null) mpb = new MaterialPropertyBlock();
            foreach (var r in renderers)
            {
                if (r == null) continue;
                r.GetPropertyBlock(mpb);
                mpb.SetColor(HighlightId, c);
                r.SetPropertyBlock(mpb);
            }
        }

        /// <summary>Approximate world-space bounds of the visuals (for label placement).</summary>
        public Bounds VisualBounds()
        {
            var b = new Bounds(transform.position, Vector3.zero);
            bool first = true;
            if (renderers == null) return b;
            foreach (var r in renderers)
            {
                if (r == null || !r.enabled || r is ParticleSystemRenderer || r.GetComponent<TextBlock>() != null) continue;
                if (first)
                {
                    b = r.bounds;
                    first = false;
                }
                else b.Encapsulate(r.bounds);
            }
            return b;
        }

        protected virtual void OnDestroy()
        {
            if (HeldBy != null) HeldBy.NotifyDestroyed(this);
            if (Socket != null) Socket.Forget(this);
        }
    }
}
