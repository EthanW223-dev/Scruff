using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A grabbable that rotates around an axis instead of following the hand: dials/knobs (twist your wrist)
    /// and doors/levers (drag around the hinge).
    /// </summary>
    public class HingeGrabbable : Grabbable
    {
        public enum Mode { Drag, Twist }

        public Mode mode = Mode.Drag;
        public Transform pivot;
        public Vector3 localAxis = Vector3.up;
        public float minAngle = -90f;
        public float maxAngle = 90f;
        public float breakDistance = 0.45f;
        public float clickEvery; // > 0: detent click sound every N degrees

        public float Angle { get; private set; }
        public float Normalized => Mathf.InverseLerp(minAngle, maxAngle, Angle);

        public event Action<float> AngleChanged;

        Quaternion baseRotation;
        float grabStartAngle;
        float grabHandAngle;
        Quaternion grabHandRot;
        float lastClickAngle;

        protected override void Awake()
        {
            base.Awake();
            followsHand = false;
            if (pivot == null) pivot = transform;
            baseRotation = pivot.localRotation;
        }

        public void Configure(Transform pivotTransform, Vector3 axis, float min, float max, Mode m)
        {
            pivot = pivotTransform;
            baseRotation = pivot.localRotation;
            localAxis = axis.normalized;
            minAngle = min;
            maxAngle = max;
            mode = m;
            followsHand = false;
        }

        public void SetAngle(float angle, bool notify = true)
        {
            angle = Mathf.Clamp(angle, minAngle, maxAngle);
            if (Mathf.Abs(angle - Angle) < 0.001f) return;
            Angle = angle;
            pivot.localRotation = baseRotation * Quaternion.AngleAxis(angle, localAxis);
            if (clickEvery > 0f && Mathf.Abs(angle - lastClickAngle) >= clickEvery)
            {
                lastClickAngle = angle;
                AudioManager.Play("hover", pivot.position, 0.6f, 1.4f);
                if (HeldBy != null) HeldBy.Haptic(0.1f, 0.01f);
            }
            if (notify) AngleChanged?.Invoke(angle);
        }

        Vector3 WorldAxis => (pivot.parent != null ? pivot.parent.rotation : Quaternion.identity) * (baseRotation * localAxis);

        protected override void OnGrabbed(PlayerHand hand)
        {
            grabStartAngle = Angle;
            grabHandAngle = HandAngle(hand);
            grabHandRot = hand.GripPoint.rotation;
            lastClickAngle = Angle;
        }

        public override void OnHeldUpdate(PlayerHand hand)
        {
            if (Vector3.Distance(hand.GripPosition, pivot.position) > breakDistance + (mode == Mode.Drag ? 1f : 0f))
            {
                hand.Drop(false);
                return;
            }
            if (mode == Mode.Drag)
            {
                float a = HandAngle(hand);
                SetAngle(grabStartAngle + Mathf.DeltaAngle(grabHandAngle, a));
            }
            else
            {
                Quaternion delta = hand.GripPoint.rotation * Quaternion.Inverse(grabHandRot);
                SetAngle(grabStartAngle + TwistAngle(delta, WorldAxis));
            }
        }

        float HandAngle(PlayerHand hand)
        {
            Vector3 axis = WorldAxis;
            Vector3 reference = (pivot.parent != null ? pivot.parent.rotation : Quaternion.identity) * (baseRotation * PerpendicularTo(localAxis));
            Vector3 v = Vector3.ProjectOnPlane(hand.GripPosition - pivot.position, axis);
            if (v.sqrMagnitude < 1e-6f) return grabHandAngle;
            return Vector3.SignedAngle(reference, v, axis);
        }

        static Vector3 PerpendicularTo(Vector3 v)
        {
            Vector3 p = Vector3.Cross(v, Vector3.up);
            if (p.sqrMagnitude < 1e-4f) p = Vector3.Cross(v, Vector3.right);
            return p.normalized;
        }

        /// <summary>Signed rotation (degrees) of <paramref name="q"/> around <paramref name="axis"/> (swing-twist decomposition).</summary>
        public static float TwistAngle(Quaternion q, Vector3 axis)
        {
            axis.Normalize();
            Vector3 v = new Vector3(q.x, q.y, q.z);
            float proj = Vector3.Dot(v, axis);
            float angle = 2f * Mathf.Atan2(proj, q.w) * Mathf.Rad2Deg;
            if (angle > 180f) angle -= 360f;
            if (angle < -180f) angle += 360f;
            return angle;
        }
    }
}
