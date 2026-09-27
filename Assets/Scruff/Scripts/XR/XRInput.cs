using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR;

namespace Scruff
{
    public enum XRButton { Primary, Secondary, Menu, StickClick }

    public struct ControllerInput
    {
        public bool Tracked;
        /// <summary>Pose in tracking space.</summary>
        public Vector3 Position;
        public Quaternion Rotation;
        public float Grip;
        public float Trigger;
        /// <summary>A on the right controller, X on the left.</summary>
        public bool Primary;
        /// <summary>B on the right controller, Y on the left.</summary>
        public bool Secondary;
        public bool Menu;
        public bool StickClick;
        public Vector2 Stick;

        public bool Get(XRButton b)
        {
            switch (b)
            {
                case XRButton.Primary: return Primary;
                case XRButton.Secondary: return Secondary;
                case XRButton.Menu: return Menu;
                default: return StickClick;
            }
        }
    }

    /// <summary>
    /// Reads headset and controllers through Unity's device-agnostic XR InputDevices API - the same API the original
    /// Gorilla Locomotion uses - so it works with OpenXR or the Oculus plugin without the XR Interaction Toolkit.
    /// In desktop mode <see cref="Simulated"/> is set and <see cref="DesktopRigController"/> writes the states instead.
    /// </summary>
    public static class XRInput
    {
        public static ControllerInput Left;
        public static ControllerInput Right;
        static ControllerInput prevLeft;
        static ControllerInput prevRight;

        public static bool HeadTracked;
        public static Vector3 HeadPosition;
        public static Quaternion HeadRotation = Quaternion.identity;

        public static bool Simulated;

        static InputDevice headDevice;
        static InputDevice leftDevice;
        static InputDevice rightDevice;
        static readonly List<XRInputSubsystem> subsystems = new List<XRInputSubsystem>();
        static bool originSet;

        public static bool DeviceActive => XRSettings.isDeviceActive;

        /// <summary>Call once per frame before anything reads input.</summary>
        public static void Poll()
        {
            prevLeft = Left;
            prevRight = Right;
            if (Simulated) return;

            if (!originSet) TrySetFloorOrigin();

            Ensure(ref leftDevice, XRNode.LeftHand);
            Ensure(ref rightDevice, XRNode.RightHand);
            Read(leftDevice, ref Left);
            Read(rightDevice, ref Right);
            PollHead();
        }

        /// <summary>Latest head pose only; called again right before rendering to cut latency.</summary>
        public static void PollHead()
        {
            if (Simulated) return;
            Ensure(ref headDevice, XRNode.Head);
            if (!headDevice.isValid)
            {
                HeadTracked = false;
                return;
            }
            bool gotPos = headDevice.TryGetFeatureValue(CommonUsages.centerEyePosition, out HeadPosition) ||
                          headDevice.TryGetFeatureValue(CommonUsages.devicePosition, out HeadPosition);
            bool gotRot = headDevice.TryGetFeatureValue(CommonUsages.centerEyeRotation, out HeadRotation) ||
                          headDevice.TryGetFeatureValue(CommonUsages.deviceRotation, out HeadRotation);
            HeadTracked = gotPos && gotRot;
        }

        public static ControllerInput Get(bool left) => left ? Left : Right;

        public static bool Pressed(bool left, XRButton b) => (left ? Left : Right).Get(b) && !(left ? prevLeft : prevRight).Get(b);

        public static bool Released(bool left, XRButton b) => !(left ? Left : Right).Get(b) && (left ? prevLeft : prevRight).Get(b);

        public static void Haptic(bool left, float amplitude, float duration)
        {
            if (Simulated || amplitude <= 0f) return;
            var device = left ? leftDevice : rightDevice;
            if (!device.isValid) return;
            if (device.TryGetHapticCapabilities(out var caps) && caps.supportsImpulse)
                device.SendHapticImpulse(0, Mathf.Clamp01(amplitude), Mathf.Max(0.005f, duration));
        }

        static void Ensure(ref InputDevice device, XRNode node)
        {
            if (!device.isValid) device = InputDevices.GetDeviceAtXRNode(node);
        }

        static void Read(InputDevice device, ref ControllerInput state)
        {
            if (!device.isValid)
            {
                state = default;
                state.Rotation = Quaternion.identity;
                return;
            }
            bool p = device.TryGetFeatureValue(CommonUsages.devicePosition, out state.Position);
            bool r = device.TryGetFeatureValue(CommonUsages.deviceRotation, out state.Rotation);
            state.Tracked = p && r;
            if (!r) state.Rotation = Quaternion.identity;
            device.TryGetFeatureValue(CommonUsages.grip, out state.Grip);
            device.TryGetFeatureValue(CommonUsages.trigger, out state.Trigger);
            device.TryGetFeatureValue(CommonUsages.primaryButton, out state.Primary);
            device.TryGetFeatureValue(CommonUsages.secondaryButton, out state.Secondary);
            device.TryGetFeatureValue(CommonUsages.menuButton, out state.Menu);
            device.TryGetFeatureValue(CommonUsages.primary2DAxisClick, out state.StickClick);
            device.TryGetFeatureValue(CommonUsages.primary2DAxis, out state.Stick);
        }

        /// <summary>Gorilla locomotion wants real-world floor height, so ask the runtime for a floor-relative origin.</summary>
        static void TrySetFloorOrigin()
        {
            SubsystemManager.GetInstances(subsystems);
            foreach (var s in subsystems)
            {
                if (s.running && s.TrySetTrackingOriginMode(TrackingOriginModeFlags.Floor))
                    originSet = true;
            }
        }

        public static void ResetState()
        {
            Left = default;
            Right = default;
            prevLeft = default;
            prevRight = default;
            Left.Rotation = Right.Rotation = Quaternion.identity;
            originSet = false;
        }
    }
}
