// Gorilla-style arm locomotion for Scruff.
//
// Ported from Another Axiom's open-source GorillaLocomotion "Player.cs"
// (https://github.com/Another-Axiom/GorillaLocomotion) - MIT License, Copyright (c) 2021 Another-Axiom.
// The core algorithm (iterative hand sphere casts, sticky hand contacts, averaged velocity jump boost,
// un-sticking) is unchanged so it feels like Gorilla Tag. Scruff additions:
//   * head collision: upstream sets movement = hit - lastHeadPosition, which lets real-world head motion push
//     past the hit point; here the head ends exactly at the swept (collision-free) position
//   * hand-touch events for tap sounds/haptics, surface lookup that caches per collider
//   * Teleport/ResetState so respawning never causes a velocity spike
//   * Frozen/solverEnabled switches (cutscenes, desktop test mode)
//   * body collider kept upright under the head every frame
//
// MIT License text: see docs/THIRD_PARTY_NOTICES.md

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    [DefaultExecutionOrder(-100)]
    public class GorillaLocomotion : MonoBehaviour
    {
        [Header("Rig")]
        public SphereCollider headCollider;
        public CapsuleCollider bodyCollider;
        public Transform leftHandFollower;
        public Transform rightHandFollower;
        public Transform leftHandTransform;
        public Transform rightHandTransform;
        public Vector3 leftHandOffset;
        public Vector3 rightHandOffset;
        public Quaternion leftHandRotationOffset = Quaternion.identity;
        public Quaternion rightHandRotationOffset = Quaternion.identity;

        [Header("Feel (Gorilla Tag defaults)")]
        public int velocityHistorySize = 8;
        public float maxArmLength = 1.5f;
        public float unStickDistance = 1f;
        public float velocityLimit = 0.3f;
        public float maxJumpSpeed = 6.5f;
        public float jumpMultiplier = 1.1f;
        public float minimumRaycastDistance = 0.05f;
        public float defaultSlideFactor = 0.03f;
        public float defaultPrecision = 0.995f;
        public LayerMask locomotionEnabledLayers = Layers.LocomotionMask;

        [Header("State")]
        public bool disableMovement;
        /// <summary>When false hands just follow the controllers (desktop mode).</summary>
        public bool solverEnabled = true;
        public bool wasLeftHandTouching;
        public bool wasRightHandTouching;

        /// <summary>isLeft, collider touched (may be null), hand speed (m/s).</summary>
        public event Action<bool, Collider, float> HandTouched;

        public Vector3 Velocity => body != null ? body.GetVelocity() : Vector3.zero;
        public Vector3 AverageVelocity => denormalizedVelocityAverage;
        public bool IsTouchingAnything => wasLeftHandTouching || wasRightHandTouching;

        Rigidbody body;
        Vector3 lastLeftHandPosition;
        Vector3 lastRightHandPosition;
        Vector3 lastHeadPosition;
        Vector3[] velocityHistory;
        int velocityIndex;
        Vector3 currentVelocity;
        Vector3 denormalizedVelocityAverage;
        Vector3 lastPosition;
        bool initialized;
        bool frozen;
        Collider lastCastCollider;

        static readonly Dictionary<Collider, GorillaSurface> surfaceCache = new Dictionary<Collider, GorillaSurface>();

        public bool Frozen
        {
            get => frozen;
            set
            {
                frozen = value;
                if (body != null)
                {
                    body.isKinematic = value;
                    if (!value) body.SetVelocity(Vector3.zero);
                }
                ResetState();
            }
        }

        void Awake()
        {
            body = GetComponent<Rigidbody>();
        }

        void Start()
        {
            InitializeValues();
        }

        public void InitializeValues()
        {
            if (body == null) body = GetComponent<Rigidbody>();
            velocityHistory = new Vector3[Mathf.Max(1, velocityHistorySize)];
            ResetState();
            initialized = true;
        }

        /// <summary>Forget all motion history (call after teleporting the rig).</summary>
        public void ResetState()
        {
            if (velocityHistory == null || velocityHistory.Length != Mathf.Max(1, velocityHistorySize))
                velocityHistory = new Vector3[Mathf.Max(1, velocityHistorySize)];
            for (int i = 0; i < velocityHistory.Length; i++) velocityHistory[i] = Vector3.zero;
            denormalizedVelocityAverage = Vector3.zero;
            currentVelocity = Vector3.zero;
            velocityIndex = 0;
            lastPosition = transform.position;
            if (headCollider != null) lastHeadPosition = headCollider.transform.position;
            if (leftHandTransform != null) lastLeftHandPosition = CurrentLeftHandPosition();
            if (rightHandTransform != null) lastRightHandPosition = CurrentRightHandPosition();
            wasLeftHandTouching = false;
            wasRightHandTouching = false;
            if (body != null && !body.isKinematic) body.SetVelocity(Vector3.zero);
            if (leftHandFollower != null) leftHandFollower.position = lastLeftHandPosition;
            if (rightHandFollower != null) rightHandFollower.position = lastRightHandPosition;
        }

        /// <summary>Moves the whole rig so the head ends up at <paramref name="headPosition"/>, with no leftover velocity.</summary>
        public void Teleport(Vector3 headPosition)
        {
            Vector3 delta = headPosition - headCollider.transform.position;
            transform.position += delta;
            Physics.SyncTransforms();
            ResetState();
        }

        Vector3 CurrentLeftHandPosition() => ClampToArm(PositionWithOffset(leftHandTransform, leftHandOffset));

        Vector3 CurrentRightHandPosition() => ClampToArm(PositionWithOffset(rightHandTransform, rightHandOffset));

        Vector3 ClampToArm(Vector3 hand)
        {
            Vector3 head = headCollider.transform.position;
            Vector3 d = hand - head;
            return d.magnitude < maxArmLength ? hand : head + d.normalized * maxArmLength;
        }

        Vector3 CurrentHeadPosition() => headCollider.transform.position;

        static Vector3 PositionWithOffset(Transform t, Vector3 offset) => t.position + t.rotation * offset;

        void UpdateBodyCollider()
        {
            if (bodyCollider == null) return;
            var head = headCollider.transform;
            bodyCollider.transform.SetPositionAndRotation(head.position, Quaternion.Euler(0f, head.eulerAngles.y, 0f));
        }

        void Update()
        {
            if (!initialized) return;
            float dt = Time.deltaTime;
            if (dt <= 0f) return;

            UpdateBodyCollider();

            if (frozen || !solverEnabled)
            {
                lastLeftHandPosition = CurrentLeftHandPosition();
                lastRightHandPosition = CurrentRightHandPosition();
                lastHeadPosition = CurrentHeadPosition();
                ApplyFollowers();
                wasLeftHandTouching = wasRightHandTouching = false;
                if (!frozen) StoreVelocities(dt);
                return;
            }

            bool leftHandColliding = false;
            bool rightHandColliding = false;
            Vector3 finalPosition;
            Vector3 rigidBodyMovement;
            Vector3 firstIterationLeftHand = Vector3.zero;
            Vector3 firstIterationRightHand = Vector3.zero;
            Collider leftContact = null;
            Collider rightContact = null;

            float leftSpeed = (CurrentLeftHandPosition() - lastLeftHandPosition).magnitude / dt;
            float rightSpeed = (CurrentRightHandPosition() - lastRightHandPosition).magnitude / dt;

            // ---- left hand
            Vector3 distanceTraveled = CurrentLeftHandPosition() - lastLeftHandPosition + Vector3.down * 2f * 9.8f * dt * dt;
            if (IterativeCollisionSphereCast(lastLeftHandPosition, minimumRaycastDistance, distanceTraveled, defaultPrecision, out finalPosition, true))
            {
                // Sticky contact: while you keep touching, the first contact point is the anchor for that hand.
                firstIterationLeftHand = wasLeftHandTouching
                    ? lastLeftHandPosition - CurrentLeftHandPosition()
                    : finalPosition - CurrentLeftHandPosition();
                body.SetVelocity(Vector3.zero);
                leftHandColliding = true;
                leftContact = lastCastCollider;
            }

            // ---- right hand
            distanceTraveled = CurrentRightHandPosition() - lastRightHandPosition + Vector3.down * 2f * 9.8f * dt * dt;
            if (IterativeCollisionSphereCast(lastRightHandPosition, minimumRaycastDistance, distanceTraveled, defaultPrecision, out finalPosition, true))
            {
                firstIterationRightHand = wasRightHandTouching
                    ? lastRightHandPosition - CurrentRightHandPosition()
                    : finalPosition - CurrentRightHandPosition();
                body.SetVelocity(Vector3.zero);
                rightHandColliding = true;
                rightContact = lastCastCollider;
            }

            // ---- average or add
            bool bothHands = (leftHandColliding || wasLeftHandTouching) && (rightHandColliding || wasRightHandTouching);
            rigidBodyMovement = bothHands
                ? (firstIterationLeftHand + firstIterationRightHand) / 2f
                : firstIterationLeftHand + firstIterationRightHand;

            // ---- make sure the head can move there
            if (IterativeCollisionSphereCast(lastHeadPosition, headCollider.radius, CurrentHeadPosition() + rigidBodyMovement - lastHeadPosition, defaultPrecision, out finalPosition, false))
            {
                rigidBodyMovement = finalPosition - CurrentHeadPosition();
                Vector3 headMove = CurrentHeadPosition() - lastHeadPosition + rigidBodyMovement;
                if (Physics.Raycast(lastHeadPosition, headMove, out _, headMove.magnitude + headCollider.radius * defaultPrecision * 0.999f, locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
                    rigidBodyMovement = lastHeadPosition - CurrentHeadPosition();
            }

            if (rigidBodyMovement != Vector3.zero) transform.position += rigidBodyMovement;

            lastHeadPosition = headCollider.transform.position;

            // ---- final hand positions
            distanceTraveled = CurrentLeftHandPosition() - lastLeftHandPosition;
            if (IterativeCollisionSphereCast(lastLeftHandPosition, minimumRaycastDistance, distanceTraveled, defaultPrecision, out finalPosition, !bothHands))
            {
                lastLeftHandPosition = finalPosition;
                leftHandColliding = true;
                if (leftContact == null) leftContact = lastCastCollider;
            }
            else
            {
                lastLeftHandPosition = CurrentLeftHandPosition();
            }

            distanceTraveled = CurrentRightHandPosition() - lastRightHandPosition;
            if (IterativeCollisionSphereCast(lastRightHandPosition, minimumRaycastDistance, distanceTraveled, defaultPrecision, out finalPosition, !bothHands))
            {
                lastRightHandPosition = finalPosition;
                rightHandColliding = true;
                if (rightContact == null) rightContact = lastCastCollider;
            }
            else
            {
                lastRightHandPosition = CurrentRightHandPosition();
            }

            StoreVelocities(dt);

            // ---- jump: fling yourself with the averaged recent velocity
            if ((rightHandColliding || leftHandColliding) && !disableMovement)
            {
                float speed = denormalizedVelocityAverage.magnitude;
                if (speed > velocityLimit)
                {
                    body.SetVelocity(speed * jumpMultiplier > maxJumpSpeed
                        ? denormalizedVelocityAverage.normalized * maxJumpSpeed
                        : jumpMultiplier * denormalizedVelocityAverage);
                }
            }

            // ---- unstick hands that are stuck far away behind geometry
            Vector3 headPos = headCollider.transform.position;
            if (leftHandColliding && (CurrentLeftHandPosition() - lastLeftHandPosition).magnitude > unStickDistance)
            {
                Vector3 toHand = CurrentLeftHandPosition() - headPos;
                if (!Physics.SphereCast(headPos, minimumRaycastDistance * defaultPrecision, toHand, out _, toHand.magnitude - minimumRaycastDistance, locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
                {
                    lastLeftHandPosition = CurrentLeftHandPosition();
                    leftHandColliding = false;
                }
            }
            if (rightHandColliding && (CurrentRightHandPosition() - lastRightHandPosition).magnitude > unStickDistance)
            {
                Vector3 toHand = CurrentRightHandPosition() - headPos;
                if (!Physics.SphereCast(headPos, minimumRaycastDistance * defaultPrecision, toHand, out _, toHand.magnitude - minimumRaycastDistance, locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
                {
                    lastRightHandPosition = CurrentRightHandPosition();
                    rightHandColliding = false;
                }
            }

            ApplyFollowers();

            if (leftHandColliding && !wasLeftHandTouching) HandTouched?.Invoke(true, leftContact, leftSpeed);
            if (rightHandColliding && !wasRightHandTouching) HandTouched?.Invoke(false, rightContact, rightSpeed);

            wasLeftHandTouching = leftHandColliding;
            wasRightHandTouching = rightHandColliding;
        }

        void ApplyFollowers()
        {
            if (leftHandFollower != null)
                leftHandFollower.SetPositionAndRotation(lastLeftHandPosition, leftHandTransform.rotation * leftHandRotationOffset);
            if (rightHandFollower != null)
                rightHandFollower.SetPositionAndRotation(lastRightHandPosition, rightHandTransform.rotation * rightHandRotationOffset);
        }

        bool IterativeCollisionSphereCast(Vector3 startPosition, float sphereRadius, Vector3 movementVector, float precision, out Vector3 endPosition, bool singleHand)
        {
            RaycastHit hitInfo;
            // First sphere cast from the start to the desired final position.
            if (CollisionsSphereCast(startPosition, sphereRadius * precision, movementVector, precision, out endPosition, out hitInfo))
            {
                // We hit something: slide a little along it, so two-handed holds and head-braced pushes don't stick 100%.
                Vector3 firstPosition = endPosition;
                var surface = SurfaceOf(hitInfo.collider);
                float slipPercentage = surface != null && surface.overrideSlip
                    ? surface.slipPercentage
                    : (!singleHand ? defaultSlideFactor : 0.001f);
                Vector3 movementToProjectedAboveCollisionPlane = Vector3.ProjectOnPlane(startPosition + movementVector - firstPosition, hitInfo.normal) * slipPercentage;

                if (CollisionsSphereCast(endPosition, sphereRadius, movementToProjectedAboveCollisionPlane, precision * precision, out endPosition, out hitInfo))
                {
                    // Hit while sliding: stop there.
                    return true;
                }
                if (CollisionsSphereCast(movementToProjectedAboveCollisionPlane + firstPosition, sphereRadius,
                        startPosition + movementVector - (movementToProjectedAboveCollisionPlane + firstPosition), precision * precision * precision, out endPosition, out hitInfo))
                {
                    // Moved back towards the true point and hit.
                    return true;
                }
                // Sliding got us around a corner - something odd happened, so don't slide.
                endPosition = firstPosition;
                return true;
            }

            // Sanity check with a smaller cast, for when the original cast started already touching a surface.
            if (CollisionsSphereCast(startPosition, sphereRadius * precision * 0.66f,
                    movementVector.normalized * (movementVector.magnitude + sphereRadius * precision * 0.34f), precision * 0.66f, out endPosition, out hitInfo))
            {
                endPosition = startPosition;
                return true;
            }

            endPosition = Vector3.zero;
            return false;
        }

        bool CollisionsSphereCast(Vector3 startPosition, float sphereRadius, Vector3 movementVector, float precision, out Vector3 finalPosition, out RaycastHit hitInfo)
        {
            // A souped-up sphere cast that makes sure the sphere we end on isn't touching a surface.
            RaycastHit innerHit;
            if (Physics.SphereCast(startPosition, sphereRadius * precision, movementVector, out hitInfo,
                    movementVector.magnitude + sphereRadius * (1f - precision), locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
            {
                // We want to end a sphere radius away from the surface we hit.
                finalPosition = hitInfo.point + hitInfo.normal * sphereRadius;
                lastCastCollider = hitInfo.collider;

                // Check the path from the start to that position too.
                if (Physics.SphereCast(startPosition, sphereRadius * precision * precision, finalPosition - startPosition, out innerHit,
                        (finalPosition - startPosition).magnitude + sphereRadius * (1f - precision * precision), locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
                {
                    finalPosition = startPosition + (finalPosition - startPosition).normalized * Mathf.Max(0f, hitInfo.distance - sphereRadius * (1f - precision * precision));
                    hitInfo = innerHit;
                    lastCastCollider = innerHit.collider;
                }
                // Bonus raycast to make sure nothing odd happened with the sphere cast (prevents clipping).
                else if (Physics.Raycast(startPosition, finalPosition - startPosition, out innerHit,
                             (finalPosition - startPosition).magnitude + sphereRadius * precision * precision * 0.999f, locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
                {
                    finalPosition = startPosition;
                    hitInfo = innerHit;
                    lastCastCollider = innerHit.collider;
                    return true;
                }
                return true;
            }

            // Anti-clipping check.
            if (Physics.Raycast(startPosition, movementVector, out hitInfo, movementVector.magnitude + sphereRadius * precision * 0.999f,
                    locomotionEnabledLayers.value, QueryTriggerInteraction.Ignore))
            {
                finalPosition = startPosition;
                lastCastCollider = hitInfo.collider;
                return true;
            }

            finalPosition = Vector3.zero;
            return false;
        }

        public static GorillaSurface SurfaceOf(Collider c)
        {
            if (c == null) return null;
            if (surfaceCache.TryGetValue(c, out var s)) return s;
            s = c.GetComponentInParent<GorillaSurface>();
            surfaceCache[c] = s;
            return s;
        }

        public bool IsHandTouching(bool forLeftHand) => forLeftHand ? wasLeftHandTouching : wasRightHandTouching;

        /// <summary>Rotates the rig around the head (snap/smooth turning), keeping momentum aligned.</summary>
        public void Turn(float degrees)
        {
            transform.RotateAround(headCollider.transform.position, transform.up, degrees);
            var rot = Quaternion.Euler(0f, degrees, 0f);
            denormalizedVelocityAverage = rot * denormalizedVelocityAverage;
            if (velocityHistory != null)
                for (int i = 0; i < velocityHistory.Length; i++) velocityHistory[i] = rot * velocityHistory[i];
            if (body != null && !body.isKinematic) body.SetVelocity(rot * body.GetVelocity());
        }

        void StoreVelocities(float dt)
        {
            velocityIndex = (velocityIndex + 1) % velocityHistory.Length;
            Vector3 oldestVelocity = velocityHistory[velocityIndex];
            currentVelocity = (transform.position - lastPosition) / dt;
            denormalizedVelocityAverage += (currentVelocity - oldestVelocity) / velocityHistory.Length;
            velocityHistory[velocityIndex] = currentVelocity;
            lastPosition = transform.position;
        }
    }
}
