using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// One of the player's hands: finds the closest grabbable, grabs on grip, holds it exactly at the hand,
    /// and on release drops it into a socket, hands it to a receiver (NPC, bag, bin) or throws it with the
    /// hand's recent velocity. Also drives the hand model pose, haptics and the floating item label.
    /// </summary>
    [DefaultExecutionOrder(50)]
    public class PlayerHand : MonoBehaviour
    {
        public float grabRadius = 0.075f;
        public float gripPressThreshold = 0.55f;
        public float gripReleaseThreshold = 0.35f;

        public PlayerRig Rig { get; private set; }
        public bool IsLeft { get; private set; }
        public Transform Controller { get; private set; }
        public HandModel Model { get; private set; }
        public PokeTip Tip { get; private set; }
        public Grabbable Held { get; private set; }
        public Grabbable Hovered { get; private set; }
        public float GripValue { get; private set; }
        public float TriggerValue { get; private set; }

        /// <summary>Blocks grabbing (e.g. while this hand holds the phone).</summary>
        public bool GrabBlocked;
        /// <summary>Desktop mode uses this to throw without swinging a real controller.</summary>
        public Vector3? PendingThrowVelocity;

        public Transform GripPoint => Model.GripPoint;
        public Vector3 GripPosition => Model.GripPoint.position;
        public Vector3 PokeTipPosition => Tip.transform.position;

        bool gripDown;
        bool triggerDown;
        float lastGripPressTime = -10f;

        Vector3 grabLocalPos;
        Quaternion grabLocalRot;
        Vector3 holdLocalPos;
        Quaternion holdLocalRot;
        float snapT = 1f;

        const int HistorySize = 12;
        readonly Vector3[] posHistory = new Vector3[HistorySize];
        readonly Quaternion[] rotHistory = new Quaternion[HistorySize];
        readonly float[] timeHistory = new float[HistorySize];
        int historyIndex;
        int historyCount;

        IItemReceiver hoveredReceiver;
        ItemSocket previewSocket;
        HandLabel label;

        static readonly Collider[] overlap = new Collider[32];

        public void Init(PlayerRig rig, bool left, Transform controller, HandModel model, PokeTip tip)
        {
            Rig = rig;
            IsLeft = left;
            Controller = controller;
            Model = model;
            Tip = tip;
            label = new HandLabel(transform);
        }

        public void Haptic(float amplitude, float duration) => XRInput.Haptic(IsLeft, amplitude, duration);

        void Update()
        {
            ReadInput(out bool gripPressed, out bool triggerPressed, out bool triggerReleased);

            // Held object destroyed out from under us (eaten by a receiver, consumed, etc.)
            if ((object)Held != null && Held == null) Held = null;

            bool locked = Game.Manager != null && Game.Manager.InputLocked;

            if (Held == null)
            {
                UpdateHover(locked);
                bool wantGrab = gripPressed || (gripDown && Time.time - lastGripPressTime < 0.15f);
                if (wantGrab && Hovered != null && !GrabBlocked && !locked) TryGrab(Hovered);
            }
            else
            {
                if (!gripDown) Release();
                else
                {
                    if (triggerPressed) Held.OnTriggerDown(this);
                    if (triggerReleased) Held.OnTriggerUp(this);
                }
            }

            Model.SetPose(GripValue, TriggerValue, Held != null);
        }

        void LateUpdate()
        {
            RecordHistory();
            if (Held != null)
            {
                UpdateHeldPose();
                UpdateReleasePreview();
            }
            else
            {
                ClearReleasePreview();
            }
            label.Update(Held != null ? Held : Hovered, Held != null, Rig.Head);
        }

        void ReadInput(out bool gripPressed, out bool triggerPressed, out bool triggerReleased)
        {
            var input = XRInput.Get(IsLeft);
            GripValue = input.Grip;
            TriggerValue = input.Trigger;

            gripPressed = false;
            if (!gripDown && GripValue > gripPressThreshold)
            {
                gripDown = true;
                gripPressed = true;
                lastGripPressTime = Time.time;
            }
            else if (gripDown && GripValue < gripReleaseThreshold)
            {
                gripDown = false;
            }

            triggerPressed = false;
            triggerReleased = false;
            if (!triggerDown && TriggerValue > 0.6f)
            {
                triggerDown = true;
                triggerPressed = true;
            }
            else if (triggerDown && TriggerValue < 0.4f)
            {
                triggerDown = false;
                triggerReleased = true;
            }
        }

        void UpdateHover(bool locked)
        {
            if (GrabBlocked || locked)
            {
                SetHover(null);
                return;
            }
            Vector3 p = GripPosition;
            int n = Physics.OverlapSphereNonAlloc(p, grabRadius, overlap, Layers.GrabMask, QueryTriggerInteraction.Collide);
            Grabbable best = null;
            float bestScore = float.MaxValue;
            for (int i = 0; i < n; i++)
            {
                var col = overlap[i];
                var g = col.GetComponentInParent<Grabbable>();
                if (g == null || !g.isActiveAndEnabled || g.HeldBy == this || !g.CanGrab(this)) continue;
                float d = (col.ClosestPoint(p) - p).magnitude - g.grabPriority * 0.02f;
                if (d < bestScore)
                {
                    bestScore = d;
                    best = g;
                }
            }
            SetHover(best);
        }

        void SetHover(Grabbable g)
        {
            if (Hovered == g) return;
            if (Hovered != null) Hovered.SetHighlight(false);
            Hovered = g;
            if (g != null)
            {
                g.SetHighlight(true);
                Haptic(0.05f, 0.01f);
            }
        }

        void TryGrab(Grabbable target)
        {
            var actual = target.ResolveGrab(this);
            SetHover(null);
            if (actual == null)
            {
                Haptic(0.3f, 0.05f);
                return;
            }
            if (actual.HeldBy != null && actual.HeldBy != this) actual.HeldBy.Drop(false);

            Held = actual;
            var grip = GripPoint;
            grabLocalPos = grip.InverseTransformPoint(actual.transform.position);
            grabLocalRot = Quaternion.Inverse(grip.rotation) * actual.transform.rotation;
            if (actual.snapToHand)
            {
                holdLocalPos = actual.holdPosition;
                holdLocalRot = Quaternion.Euler(actual.holdEuler);
                snapT = 0f;
            }
            else
            {
                holdLocalPos = grabLocalPos;
                holdLocalRot = grabLocalRot;
                snapT = 1f;
            }

            actual.BeginGrab(this);
            Haptic(0.35f, 0.05f);
            if (actual.followsHand) AudioManager.Play("pop", actual.transform.position, 0.25f, Random.Range(0.95f, 1.15f));
        }

        void UpdateHeldPose()
        {
            if (!Held.followsHand)
            {
                Held.OnHeldUpdate(this);
                return;
            }
            if (snapT < 1f) snapT = Mathf.Min(1f, snapT + Time.deltaTime / 0.09f);
            float s = Util.SmoothStep01(snapT);
            Vector3 lp = Vector3.Lerp(grabLocalPos, holdLocalPos, s);
            Quaternion lr = Quaternion.Slerp(grabLocalRot, holdLocalRot, s);
            var grip = GripPoint;
            Held.transform.SetPositionAndRotation(grip.TransformPoint(lp), grip.rotation * lr);
            Held.OnHeldUpdate(this);
        }

        /// <summary>Lets go of whatever is held. With <paramref name="physics"/> false the object just stops being held.</summary>
        public void Drop(bool physics = true)
        {
            if (Held == null) return;
            if (!physics)
            {
                var g = Held;
                Held = null;
                g.EndGrab(this);
                ClearReleasePreview();
                return;
            }
            Release();
        }

        void Release()
        {
            var g = Held;
            Held = null;
            ClearReleasePreview();
            if (g == null) return;

            ComputeThrow(g, out var velocity, out var angular);
            if (PendingThrowVelocity.HasValue)
            {
                velocity = PendingThrowVelocity.Value;
                PendingThrowVelocity = null;
            }
            g.EndGrab(this);
            Haptic(0.12f, 0.03f);

            if (!g.followsHand) return;

            var socket = ItemSocket.FindBestFor(g);
            if (socket != null)
            {
                socket.Insert(g);
                return;
            }
            if (g is Item item && ItemReceivers.FindBest(item, out var receiver) && receiver.TryReceive(item, this))
                return;
            if (g != null) g.ReleaseToPhysics(velocity, angular);
        }

        public void NotifyDestroyed(Grabbable g)
        {
            if (Held == g) Held = null;
            if (Hovered == g) Hovered = null;
        }

        public void OnTeleported()
        {
            historyCount = 0;
        }

        void RecordHistory()
        {
            var grip = GripPoint;
            historyIndex = (historyIndex + 1) % HistorySize;
            posHistory[historyIndex] = grip.position;
            rotHistory[historyIndex] = grip.rotation;
            timeHistory[historyIndex] = Time.time;
            historyCount = Mathf.Min(historyCount + 1, HistorySize);
        }

        void ComputeThrow(Grabbable g, out Vector3 velocity, out Vector3 angular)
        {
            velocity = Vector3.zero;
            angular = Vector3.zero;
            if (historyCount < 2) return;

            int newest = historyIndex;
            int oldest = newest;
            float now = timeHistory[newest];
            for (int i = 1; i < historyCount; i++)
            {
                int idx = (newest - i + HistorySize) % HistorySize;
                oldest = idx;
                if (now - timeHistory[idx] > 0.085f) break;
            }
            float dt = now - timeHistory[oldest];
            if (dt < 1e-4f) return;

            Vector3 v = (posHistory[newest] - posHistory[oldest]) / dt;
            Quaternion dq = rotHistory[newest] * Quaternion.Inverse(rotHistory[oldest]);
            dq.ToAngleAxis(out float angle, out Vector3 axis);
            if (angle > 180f) angle -= 360f;
            Vector3 w = float.IsNaN(axis.x) || float.IsInfinity(axis.x) ? Vector3.zero : axis * (angle * Mathf.Deg2Rad / dt);

            // The object's centre moves faster than the grip point when it's held off-centre and swung.
            Vector3 r = g.transform.position - posHistory[newest];
            velocity = Vector3.ClampMagnitude((v + Vector3.Cross(w, r)) * g.throwMultiplier, 22f);
            angular = Vector3.ClampMagnitude(w, 30f);
        }

        void UpdateReleasePreview()
        {
            if (!Held.followsHand)
            {
                ClearReleasePreview();
                return;
            }
            var socket = ItemSocket.FindBestFor(Held);
            if (socket != previewSocket)
            {
                if (previewSocket != null) previewSocket.SetPreview(false);
                previewSocket = socket;
                if (socket != null)
                {
                    socket.SetPreview(true);
                    Haptic(0.08f, 0.015f);
                }
            }

            IItemReceiver receiver = null;
            if (socket == null && Held is Item item) ItemReceivers.FindBest(item, out receiver);
            if (receiver != hoveredReceiver)
            {
                hoveredReceiver?.SetHover(null);
                hoveredReceiver = receiver;
                if (receiver != null && Held is Item heldItem)
                {
                    receiver.SetHover(heldItem);
                    Haptic(0.08f, 0.015f);
                }
            }
        }

        void ClearReleasePreview()
        {
            if (previewSocket != null)
            {
                previewSocket.SetPreview(false);
                previewSocket = null;
            }
            if (hoveredReceiver != null)
            {
                hoveredReceiver.SetHover(null);
                hoveredReceiver = null;
            }
        }
    }
}
