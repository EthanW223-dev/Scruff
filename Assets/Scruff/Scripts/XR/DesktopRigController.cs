using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Lets you play/test without a headset: mouse look, WASD walk, and a simulated right hand that reaches for
    /// whatever you click. Everything goes through the same PlayerHand/PokeButton code the VR hands use.
    ///
    /// Controls: WASD move, Shift run, Space jump, mouse look (click to capture, Esc to release),
    /// LMB grab/hold/press buttons, scroll = hold distance, RMB = trigger/use, R = tilt (pour), F = throw,
    /// Q/E = twist (dials), Tab = phone.
    /// </summary>
    public class DesktopRigController
    {
        enum Mode { Idle, Reach, Hold, Poke }

        readonly PlayerRig rig;
        float yaw;
        float pitch;
        Mode mode;
        Vector3 reachPoint;
        Vector3 reachDir;
        float modeTime;
        float holdDistance = 0.55f;
        float tilt;
        float roll;
        Vector3 rightPos;
        Quaternion rightRot = Quaternion.identity;
        Vector3 leftPos;
        Quaternion leftRot = Quaternion.identity;
        bool initialized;
        GameObject crosshair;

        public DesktopRigController(PlayerRig rig)
        {
            this.rig = rig;
        }

        public void Enable()
        {
            XRInput.Simulated = true;
            XRInput.ResetState();
            XRInput.Simulated = true;
            rig.Head.localPosition = new Vector3(0f, 1.6f, 0f);
            yaw = 0f;
            pitch = 0f;
            initialized = false;
            SetCursor(true);
            if (crosshair == null) crosshair = CreateCrosshair();
            crosshair.SetActive(true);
        }

        public void Disable()
        {
            XRInput.Simulated = false;
            SetCursor(false);
            if (crosshair != null) crosshair.SetActive(false);
        }

        GameObject CreateCrosshair()
        {
            var mb = new MeshBuilder { RawAlpha = true };
            mb.AddCylinder(Vector3.zero, 0.0022f, 0.0002f, 10, new Color(1f, 1f, 1f, 0.85f), Quaternion.Euler(-90f, 0f, 0f));
            var go = mb.ToGameObject("Crosshair", rig.Camera.transform);
            go.GetComponent<MeshRenderer>().sharedMaterial = ScruffMaterials.Overlay;
            go.transform.localPosition = new Vector3(0f, 0f, 0.5f);
            return go;
        }

        static void SetCursor(bool locked)
        {
            Cursor.lockState = locked ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !locked;
        }

        public void Tick(float dt)
        {
            bool inputLocked = Game.Manager != null && Game.Manager.InputLocked;
            if (DesktopInput.KeyPressed(DKey.Escape)) SetCursor(false);
            bool consumedClick = false;
            if (Cursor.lockState != CursorLockMode.Locked && DesktopInput.MousePressed(0))
            {
                SetCursor(true);
                consumedClick = true;
            }
            bool looking = Cursor.lockState == CursorLockMode.Locked;

            if (looking)
            {
                var d = DesktopInput.MouseDelta;
                yaw += d.x * 2f;
                pitch = Mathf.Clamp(pitch - d.y * 2f, -85f, 85f);
            }
            rig.Head.localPosition = new Vector3(0f, 1.6f, 0f);
            rig.Head.localRotation = Quaternion.Euler(pitch, yaw, 0f);

            if (!inputLocked) Move(dt);
            Hands(dt, looking && !consumedClick && !inputLocked);
        }

        void Move(float dt)
        {
            float x = (DesktopInput.KeyHeld(DKey.D) ? 1f : 0f) - (DesktopInput.KeyHeld(DKey.A) ? 1f : 0f);
            float z = (DesktopInput.KeyHeld(DKey.W) ? 1f : 0f) - (DesktopInput.KeyHeld(DKey.S) ? 1f : 0f);
            var input = Vector3.ClampMagnitude(new Vector3(x, 0f, z), 1f);
            float speed = DesktopInput.KeyHeld(DKey.Shift) ? 5.5f : 3f;

            Vector3 fwd = rig.FlatForward;
            Vector3 right = Vector3.Cross(Vector3.up, fwd);
            Vector3 desired = (fwd * input.z + right * input.x) * speed;

            if (rig.Body.isKinematic) return;
            var v = rig.Body.GetVelocity();
            bool grounded = rig.IsGrounded();
            Vector3 horizontal = Vector3.Lerp(new Vector3(v.x, 0f, v.z), desired, Util.Damp(grounded ? 14f : 3f, dt));
            v.x = horizontal.x;
            v.z = horizontal.z;
            if (grounded && DesktopInput.KeyPressed(DKey.Space)) v.y = 4.2f;
            rig.Body.SetVelocity(v);
        }

        void Hands(float dt, bool canClick)
        {
            var cam = rig.Camera.transform;
            var hand = rig.RightHand;
            var ray = new Ray(cam.position, cam.forward);

            float grip = 0f;
            float trigger = DesktopInput.MouseHeld(1) ? 1f : 0f;
            tilt = Mathf.MoveTowards(tilt, DesktopInput.KeyHeld(DKey.R) ? 115f : 0f, dt * 300f);
            // Q/E twist the wrist (dials); springs back when you let go of the mouse
            if (mode == Mode.Hold)
            {
                if (DesktopInput.KeyHeld(DKey.Q)) roll += 120f * dt;
                if (DesktopInput.KeyHeld(DKey.E)) roll -= 120f * dt;
                roll = Mathf.Clamp(roll, -150f, 150f);
            }
            else roll = Mathf.MoveTowards(roll, 0f, dt * 400f);

            Vector3 rest = cam.position + cam.rotation * new Vector3(0.2f, -0.24f, 0.42f);
            Quaternion targetRot = cam.rotation * Quaternion.Euler(tilt, 0f, roll);
            Vector3 target = rest;

            switch (mode)
            {
                case Mode.Idle:
                    if (canClick && DesktopInput.MousePressed(0) &&
                        Physics.Raycast(ray, out var hit, 2.6f, Layers.GrabMask | Layers.EnvironmentMask | Layers.NPCMask, QueryTriggerInteraction.Collide))
                    {
                        var button = hit.collider.GetComponentInParent<PokeButton>();
                        var grabbable = hit.collider.GetComponentInParent<Grabbable>();
                        if (button != null && button.isActiveAndEnabled)
                        {
                            mode = Mode.Poke;
                            reachPoint = hit.point;
                            reachDir = ray.direction;
                            modeTime = 0f;
                        }
                        else if (grabbable != null && grabbable.CanGrab(hand))
                        {
                            mode = Mode.Reach;
                            reachPoint = hit.point;
                            modeTime = 0f;
                        }
                    }
                    break;

                case Mode.Reach:
                    modeTime += dt;
                    target = reachPoint - (hand.GripPosition - hand.transform.position);
                    if (Vector3.Distance(hand.GripPosition, reachPoint) < 0.05f || modeTime > 0.25f) grip = 1f;
                    if (hand.Held != null)
                    {
                        mode = Mode.Hold;
                        holdDistance = Mathf.Clamp(Vector3.Distance(cam.position, hand.transform.position), 0.35f, 1.4f);
                    }
                    else if (modeTime > 0.6f || !DesktopInput.MouseHeld(0))
                    {
                        mode = Mode.Idle;
                    }
                    break;

                case Mode.Hold:
                    grip = 1f;
                    holdDistance = Mathf.Clamp(holdDistance + DesktopInput.Scroll * 0.06f, 0.3f, 1.8f);
                    target = cam.position + cam.forward * holdDistance - cam.up * 0.06f;
                    if (hand.Held == null)
                    {
                        mode = Mode.Idle;
                        grip = 0f;
                    }
                    else if (DesktopInput.KeyPressed(DKey.F))
                    {
                        hand.PendingThrowVelocity = cam.forward * 7f + rig.Body.GetVelocity();
                        grip = 0f;
                        mode = Mode.Idle;
                    }
                    else if (!DesktopInput.MouseHeld(0))
                    {
                        grip = 0f;
                        mode = Mode.Idle;
                    }
                    break;

                case Mode.Poke:
                    modeTime += dt;
                    float phase = modeTime / 0.3f;
                    Vector3 approach = reachPoint - reachDir * 0.06f;
                    Vector3 pushed = reachPoint + reachDir * 0.02f;
                    Vector3 tipTarget = phase < 0.45f ? approach : phase < 0.8f ? pushed : approach;
                    target = tipTarget - (hand.PokeTipPosition - hand.transform.position);
                    targetRot = Quaternion.LookRotation(reachDir, cam.up);
                    if (modeTime > 0.42f) mode = Mode.Idle;
                    break;
            }

            if (!initialized)
            {
                rightPos = target;
                rightRot = targetRot;
            }
            float k = Util.Damp(mode == Mode.Poke ? 30f : 18f, dt);
            rightPos = Vector3.Lerp(rightPos, target, k);
            rightRot = Quaternion.Slerp(rightRot, targetRot, k);
            rig.RightController.SetPositionAndRotation(rightPos, rightRot);

            // Left hand: rests low, or holds the phone up in view.
            bool phoneOut = Game.UI != null && Game.UI.Phone != null && Game.UI.Phone.IsOpen;
            Vector3 leftTarget = cam.position + cam.rotation * (phoneOut ? new Vector3(-0.07f, -0.2f, 0.36f) : new Vector3(-0.22f, -0.28f, 0.38f));
            Quaternion leftTargetRot = cam.rotation;
            if (!initialized)
            {
                leftPos = leftTarget;
                leftRot = leftTargetRot;
            }
            leftPos = Vector3.Lerp(leftPos, leftTarget, Util.Damp(14f, dt));
            leftRot = Quaternion.Slerp(leftRot, leftTargetRot, Util.Damp(14f, dt));
            rig.LeftController.SetPositionAndRotation(leftPos, leftRot);
            initialized = true;

            // Feed the simulated controller state.
            XRInput.Right.Tracked = true;
            XRInput.Right.Grip = grip;
            XRInput.Right.Trigger = trigger;
            XRInput.Left.Tracked = true;
            XRInput.Left.Grip = 0f;
            XRInput.Left.Secondary = DesktopInput.KeyHeld(DKey.Tab);
            XRInput.Left.Menu = DesktopInput.KeyHeld(DKey.M);
        }
    }
}
