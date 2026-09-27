using UnityEngine;
using UnityEngine.XR;

namespace Scruff
{
    /// <summary>
    /// The local player: a Gorilla-Tag-style rig (rigidbody root, tracked head/controllers, collision-resolved hands),
    /// snap/smooth turning, hand tap feedback and a desktop fallback for testing without a headset.
    ///
    /// Hierarchy built by <see cref="Create"/>:
    ///   Player (Rigidbody, GorillaLocomotion, PlayerRig)
    ///     TrackingSpace
    ///       Head (Camera, head SphereCollider)
    ///       LeftController / RightController (raw tracked poses)
    ///     Body (CapsuleCollider kept upright under the head)
    ///     Left Hand / Right Hand (collision-resolved followers with PlayerHand + HandModel)
    ///     BodyAnchor (follows your hips; holsters hang off it)
    /// </summary>
    [DefaultExecutionOrder(-300)]
    public class PlayerRig : MonoBehaviour
    {
        [Tooltip("Eye height above the ground when standing (the body collider holds you here). Gorilla Tag is ~1m.")]
        public float standHeight = 1.05f;
        public float headRadius = 0.15f;
        public float bodyRadius = 0.18f;
        [Tooltip("Pushes the hand collision sphere forward (controller space) so you hit things with your knuckles.")]
        public Vector3 handCollisionOffset = new Vector3(0f, 0f, 0.035f);
        public bool forceDesktop;

        public Transform TrackingSpace { get; private set; }
        public Transform Head { get; private set; }
        public Camera Camera { get; private set; }
        public Transform LeftController { get; private set; }
        public Transform RightController { get; private set; }
        public PlayerHand LeftHand { get; private set; }
        public PlayerHand RightHand { get; private set; }
        public GorillaLocomotion Locomotion { get; private set; }
        public Rigidbody Body { get; private set; }
        public CapsuleCollider BodyCollider { get; private set; }
        public Transform BodyAnchor { get; private set; }
        public ItemSocket LeftHolster { get; private set; }
        public ItemSocket RightHolster { get; private set; }
        public bool DesktopMode { get; private set; }
        public DesktopRigController Desktop { get; private set; }

        public Vector3 HeadPosition => Head.position;
        public Vector3 FeetPosition => Head.position - Vector3.up * standHeight;
        public Vector3 FlatForward
        {
            get
            {
                var f = Head.forward;
                f.y = 0f;
                return f.sqrMagnitude > 1e-4f ? f.normalized : transform.forward;
            }
        }

        public PlayerHand Hand(bool left) => left ? LeftHand : RightHand;

        bool snapReady = true;
        float modeCheckTimer;
        float leftTapCooldown;
        float rightTapCooldown;
        float anchorYaw;
#if UNITY_6000_0_OR_NEWER
        PhysicsMaterial gripMaterial;
        PhysicsMaterial slipMaterial;
#else
        PhysicMaterial gripMaterial;
        PhysicMaterial slipMaterial;
#endif

        public static PlayerRig Create(Vector3 feetPosition, float yaw, bool forceDesktop)
        {
            var root = new GameObject("Player");
            root.layer = Layers.PlayerBody;
            root.transform.SetPositionAndRotation(feetPosition, Quaternion.Euler(0f, yaw, 0f));

            var rb = root.AddComponent<Rigidbody>();
            rb.mass = 1f;
            rb.SetDamping(0f, 0f);
            rb.useGravity = true;
            rb.interpolation = RigidbodyInterpolation.None;
            rb.constraints = RigidbodyConstraints.FreezeRotation;
            rb.collisionDetectionMode = CollisionDetectionMode.Continuous;

            var rig = root.AddComponent<PlayerRig>();
            rig.forceDesktop = forceDesktop;
            rig.Body = rb;
            rig.Build();
            return rig;
        }

        void Build()
        {
#if UNITY_6000_0_OR_NEWER
            gripMaterial = new PhysicsMaterial("PlayerGrip") { dynamicFriction = 0.5f, staticFriction = 0.5f, bounciness = 0f, frictionCombine = PhysicsMaterialCombine.Average, bounceCombine = PhysicsMaterialCombine.Minimum };
            slipMaterial = new PhysicsMaterial("PlayerSlip") { dynamicFriction = 0f, staticFriction = 0f, bounciness = 0f, frictionCombine = PhysicsMaterialCombine.Minimum, bounceCombine = PhysicsMaterialCombine.Minimum };
#else
            gripMaterial = new PhysicMaterial("PlayerGrip") { dynamicFriction = 0.5f, staticFriction = 0.5f, bounciness = 0f, frictionCombine = PhysicMaterialCombine.Average, bounceCombine = PhysicMaterialCombine.Minimum };
            slipMaterial = new PhysicMaterial("PlayerSlip") { dynamicFriction = 0f, staticFriction = 0f, bounciness = 0f, frictionCombine = PhysicMaterialCombine.Minimum, bounceCombine = PhysicMaterialCombine.Minimum };
#endif

            TrackingSpace = Util.CreateChild(transform, "TrackingSpace");

            // Head + camera
            Head = Util.CreateChild(TrackingSpace, "Head", new Vector3(0f, 1.6f, 0f));
            Head.gameObject.layer = Layers.PlayerBody;
            Head.gameObject.tag = "MainCamera";
            Camera = Head.gameObject.AddComponent<Camera>();
            Camera.nearClipPlane = 0.02f;
            Camera.farClipPlane = 260f;
            Camera.clearFlags = CameraClearFlags.SolidColor;
            Camera.backgroundColor = new Color(0.62f, 0.76f, 0.9f);
            Head.gameObject.AddComponent<AudioListener>();
            var headCol = Head.gameObject.AddComponent<SphereCollider>();
            headCol.radius = headRadius;
            headCol.sharedMaterial = slipMaterial;

            // Body collider: from just under the head down to the floor, so you "stand" at standHeight.
            var bodyGo = new GameObject("Body");
            bodyGo.layer = Layers.PlayerBody;
            bodyGo.transform.SetParent(transform, false);
            BodyCollider = bodyGo.AddComponent<CapsuleCollider>();
            float topGap = headRadius * 0.6f;
            float height = standHeight - topGap;
            BodyCollider.radius = bodyRadius;
            BodyCollider.height = height;
            BodyCollider.direction = 1;
            BodyCollider.center = new Vector3(0f, -(topGap + height * 0.5f), 0f);
            BodyCollider.sharedMaterial = gripMaterial;

            LeftController = Util.CreateChild(TrackingSpace, "LeftController", new Vector3(-0.2f, 1.0f, 0.3f));
            RightController = Util.CreateChild(TrackingSpace, "RightController", new Vector3(0.2f, 1.0f, 0.3f));

            LeftHand = BuildHand(true);
            RightHand = BuildHand(false);

            BodyAnchor = Util.CreateChild(transform, "BodyAnchor");
            LeftHolster = BuildHolster("holster_left", new Vector3(-0.2f, 0f, 0.07f));
            RightHolster = BuildHolster("holster_right", new Vector3(0.2f, 0f, 0.07f));

            Locomotion = gameObject.AddComponent<GorillaLocomotion>();
            Locomotion.headCollider = headCol;
            Locomotion.bodyCollider = BodyCollider;
            Locomotion.leftHandTransform = LeftController;
            Locomotion.rightHandTransform = RightController;
            Locomotion.leftHandFollower = LeftHand.transform;
            Locomotion.rightHandFollower = RightHand.transform;
            Locomotion.locomotionEnabledLayers = Layers.LocomotionMask;
            Locomotion.leftHandOffset = handCollisionOffset;
            Locomotion.rightHandOffset = handCollisionOffset;
            Locomotion.HandTouched += OnHandTouched;

            Desktop = new DesktopRigController(this);
        }

        /// <summary>Belt pouch: let go of a small item by your hip to stash it there. Cops can't see holstered stuff.</summary>
        ItemSocket BuildHolster(string key, Vector3 localPos)
        {
            var t = Util.CreateChild(BodyAnchor, key, localPos);
            Geo.Mesh("Pouch", t, b =>
            {
                Color leather = new Color(0.32f, 0.22f, 0.15f);
                b.AddBox(new Vector3(0f, -0.045f, 0f), new Vector3(0.11f, 0.09f, 0.06f), Quaternion.identity, leather, Color.Lerp(leather, Color.black, 0.3f));
                b.AddBox(new Vector3(0f, -0.005f, 0.028f), new Vector3(0.1f, 0.03f, 0.012f), Color.Lerp(leather, Color.white, 0.1f));
            });
            var socket = t.gameObject.AddComponent<ItemSocket>();
            socket.radius = 0.14f;
            socket.saveKey = key;
            socket.keepRotation = true;
            socket.Filter = g => g is Item it && it.Body != null && it.Body.mass <= 1.3f;
            return socket;
        }

        PlayerHand BuildHand(bool left)
        {
            var go = new GameObject(left ? "Left Hand" : "Right Hand");
            go.layer = Layers.PlayerHand;
            go.transform.SetParent(transform, false);
            // The follower sits at the (offset) collision point; shift the visual back so it lines up with your real hand.
            var model = Util.CreateChild(go.transform, "HandModel", -handCollisionOffset).gameObject.AddComponent<HandModel>();
            model.Build(left, GameSettings.PlayerColor);
            var tip = model.PokePoint.gameObject.AddComponent<PokeTip>();
            var hand = go.AddComponent<PlayerHand>();
            hand.Init(this, left, left ? LeftController : RightController, model, tip);
            tip.hand = hand;
            return hand;
        }

        void Start()
        {
            SetDesktopMode(forceDesktop || !XRInput.DeviceActive);
            MatchPhysicsRateToDisplay();
            GameSettings.Changed += OnSettingsChanged;
        }

        void OnDestroy()
        {
            GameSettings.Changed -= OnSettingsChanged;
        }

        void OnEnable() => Application.onBeforeRender += OnBeforeRender;

        void OnDisable() => Application.onBeforeRender -= OnBeforeRender;

        void OnSettingsChanged()
        {
            LeftHand.Model.SetColor(GameSettings.PlayerColor);
            RightHand.Model.SetColor(GameSettings.PlayerColor);
        }

        public void SetDesktopMode(bool desktop)
        {
            DesktopMode = desktop;
            Locomotion.solverEnabled = !desktop;
            BodyCollider.sharedMaterial = desktop ? slipMaterial : gripMaterial;
            if (desktop) Desktop.Enable();
            else Desktop.Disable();
            Locomotion.ResetState();
            Debug.Log(desktop
                ? "[Scruff] No headset detected - desktop test mode. WASD move, mouse look, LMB grab/press, RMB use, R tilt, Q/E twist, F throw, Tab phone."
                : "[Scruff] Headset detected - VR mode.");
        }

        static void MatchPhysicsRateToDisplay()
        {
            // Physics running at the display rate keeps falling/jumping perfectly smooth in VR.
            float hz = XRSettings.isDeviceActive ? XRDevice.refreshRate : 0f;
            if (hz < 30f) hz = 72f;
            Time.fixedDeltaTime = 1f / Mathf.Clamp(hz, 60f, 144f);
        }

        void Update()
        {
            XRInput.Poll();

            // XR can finish starting up after the first frame; switch modes if it does.
            if (!forceDesktop && modeCheckTimer < 6f)
            {
                modeCheckTimer += Time.unscaledDeltaTime;
                if (DesktopMode && XRInput.DeviceActive)
                {
                    SetDesktopMode(false);
                    MatchPhysicsRateToDisplay();
                }
            }

            if (DesktopMode)
            {
                Desktop.Tick(Time.deltaTime);
            }
            else
            {
                ApplyHead();
                var l = XRInput.Left;
                if (l.Tracked)
                {
                    LeftController.localPosition = l.Position;
                    LeftController.localRotation = l.Rotation;
                }
                var r = XRInput.Right;
                if (r.Tracked)
                {
                    RightController.localPosition = r.Position;
                    RightController.localRotation = r.Rotation;
                }
                HandleTurning();
            }

            leftTapCooldown -= Time.deltaTime;
            rightTapCooldown -= Time.deltaTime;
        }

        void LateUpdate()
        {
            // Hip anchor for holsters: follows the head's yaw lazily, sits at belly height.
            float targetYaw = Head.eulerAngles.y;
            anchorYaw = Mathf.LerpAngle(anchorYaw, targetYaw, Util.Damp(Mathf.Abs(Mathf.DeltaAngle(anchorYaw, targetYaw)) > 60f ? 10f : 3f, Time.deltaTime));
            BodyAnchor.SetPositionAndRotation(Head.position + Vector3.down * (standHeight * 0.55f), Quaternion.Euler(0f, anchorYaw, 0f));
        }

        void ApplyHead()
        {
            if (!XRInput.HeadTracked) return;
            Head.localPosition = XRInput.HeadPosition;
            Head.localRotation = XRInput.HeadRotation;
        }

        void OnBeforeRender()
        {
            if (DesktopMode || !isActiveAndEnabled) return;
            XRInput.PollHead();
            ApplyHead();
        }

        void HandleTurning()
        {
            if (Game.Manager != null && Game.Manager.InputLocked) return;
            float x = XRInput.Right.Stick.x;
            switch (GameSettings.TurnMode)
            {
                case TurnMode.Snap:
                    if (snapReady && Mathf.Abs(x) > 0.7f)
                    {
                        Locomotion.Turn(Mathf.Sign(x) * GameSettings.SnapAngle);
                        snapReady = false;
                    }
                    else if (Mathf.Abs(x) < 0.35f)
                    {
                        snapReady = true;
                    }
                    break;
                case TurnMode.Smooth:
                    if (Mathf.Abs(x) > 0.15f)
                        Locomotion.Turn(x * GameSettings.SmoothTurnSpeed * Time.deltaTime);
                    break;
            }
        }

        void OnHandTouched(bool left, Collider col, float speed)
        {
            if (left ? leftTapCooldown > 0f : rightTapCooldown > 0f) return;
            if (left) leftTapCooldown = 0.12f;
            else rightTapCooldown = 0.12f;

            float strength = Mathf.Clamp01(speed / 3.5f);
            if (strength < 0.05f) return;
            var surface = GorillaLocomotion.SurfaceOf(col);
            string clip = "tap";
            if (surface != null)
            {
                switch (surface.sound)
                {
                    case SurfaceSound.Wood: clip = "tap_wood"; break;
                    case SurfaceSound.Metal: clip = "tap_metal"; break;
                    case SurfaceSound.Grass: clip = "tap_grass"; break;
                }
            }
            var hand = Hand(left);
            AudioManager.Play(clip, hand.transform.position, 0.15f + strength * 0.55f, Random.Range(0.9f, 1.12f));
            hand.Haptic(0.12f + strength * 0.4f, 0.04f);
            hand.Model.Squash(strength);
        }

        /// <summary>Puts the player's feet at <paramref name="feetPosition"/>, facing <paramref name="yaw"/>.</summary>
        public void Teleport(Vector3 feetPosition, float yaw)
        {
            float currentYaw = Head.eulerAngles.y;
            Locomotion.Turn(Mathf.DeltaAngle(currentYaw, yaw));
            Locomotion.Teleport(feetPosition + Vector3.up * standHeight);
            anchorYaw = yaw;
            if (!Body.isKinematic) Body.SetVelocity(Vector3.zero);
            LeftHand.OnTeleported();
            RightHand.OnTeleported();
        }

        public bool IsGrounded()
        {
            Vector3 origin = Head.position;
            return Physics.SphereCast(origin, bodyRadius * 0.9f, Vector3.down, out _, standHeight - bodyRadius + 0.08f, Layers.EnvironmentMask, QueryTriggerInteraction.Ignore);
        }

        /// <summary>Everything the player is carrying: both hands and both holsters.</summary>
        public System.Collections.Generic.IEnumerable<Item> CarriedItems()
        {
            if (LeftHand.Held is Item a) yield return a;
            if (RightHand.Held is Item b) yield return b;
            if (LeftHolster.Occupant is Item c) yield return c;
            if (RightHolster.Occupant is Item d) yield return d;
        }

        /// <summary>True if either hand is holding an item that contains product (police notice this).</summary>
        public bool IsHoldingProduct()
        {
            return HoldsProduct(LeftHand) || HoldsProduct(RightHand);
        }

        static bool HoldsProduct(PlayerHand hand)
        {
            return hand.Held is Item item && item.ContainsProduct;
        }
    }
}
