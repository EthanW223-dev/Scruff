using UnityEngine;

namespace Scruff
{
    public enum DKey { W, A, S, D, Space, Shift, Tab, F, R, Q, E, Escape, M, C }

    /// <summary>
    /// Keyboard/mouse access that works with either the new Input System package or the legacy Input Manager,
    /// whichever the project has enabled. Only used by desktop test mode.
    /// </summary>
    public static class DesktopInput
    {
#if ENABLE_INPUT_SYSTEM
        static UnityEngine.InputSystem.Key Map(DKey k)
        {
            switch (k)
            {
                case DKey.W: return UnityEngine.InputSystem.Key.W;
                case DKey.A: return UnityEngine.InputSystem.Key.A;
                case DKey.S: return UnityEngine.InputSystem.Key.S;
                case DKey.D: return UnityEngine.InputSystem.Key.D;
                case DKey.Space: return UnityEngine.InputSystem.Key.Space;
                case DKey.Shift: return UnityEngine.InputSystem.Key.LeftShift;
                case DKey.Tab: return UnityEngine.InputSystem.Key.Tab;
                case DKey.F: return UnityEngine.InputSystem.Key.F;
                case DKey.R: return UnityEngine.InputSystem.Key.R;
                case DKey.Q: return UnityEngine.InputSystem.Key.Q;
                case DKey.E: return UnityEngine.InputSystem.Key.E;
                case DKey.Escape: return UnityEngine.InputSystem.Key.Escape;
                case DKey.M: return UnityEngine.InputSystem.Key.M;
                default: return UnityEngine.InputSystem.Key.C;
            }
        }

        static UnityEngine.InputSystem.Keyboard Kb => UnityEngine.InputSystem.Keyboard.current;
        static UnityEngine.InputSystem.Mouse Ms => UnityEngine.InputSystem.Mouse.current;

        static UnityEngine.InputSystem.Controls.ButtonControl MouseButton(int b) =>
            b == 0 ? Ms.leftButton : b == 1 ? Ms.rightButton : Ms.middleButton;

        public static bool KeyHeld(DKey k) => Kb != null && Kb[Map(k)].isPressed;
        public static bool KeyPressed(DKey k) => Kb != null && Kb[Map(k)].wasPressedThisFrame;
        public static Vector2 MouseDelta => Ms != null ? Ms.delta.ReadValue() * 0.1f : Vector2.zero;
        public static float Scroll => Ms != null ? Ms.scroll.ReadValue().y / 120f : 0f;
        public static bool MouseHeld(int button) => Ms != null && MouseButton(button).isPressed;
        public static bool MousePressed(int button) => Ms != null && MouseButton(button).wasPressedThisFrame;
        public static bool MouseReleased(int button) => Ms != null && MouseButton(button).wasReleasedThisFrame;
#elif ENABLE_LEGACY_INPUT_MANAGER
        static KeyCode Map(DKey k)
        {
            switch (k)
            {
                case DKey.W: return KeyCode.W;
                case DKey.A: return KeyCode.A;
                case DKey.S: return KeyCode.S;
                case DKey.D: return KeyCode.D;
                case DKey.Space: return KeyCode.Space;
                case DKey.Shift: return KeyCode.LeftShift;
                case DKey.Tab: return KeyCode.Tab;
                case DKey.F: return KeyCode.F;
                case DKey.R: return KeyCode.R;
                case DKey.Q: return KeyCode.Q;
                case DKey.E: return KeyCode.E;
                case DKey.Escape: return KeyCode.Escape;
                case DKey.M: return KeyCode.M;
                default: return KeyCode.C;
            }
        }

        public static bool KeyHeld(DKey k) => Input.GetKey(Map(k));
        public static bool KeyPressed(DKey k) => Input.GetKeyDown(Map(k));
        public static Vector2 MouseDelta => new Vector2(Input.GetAxisRaw("Mouse X"), Input.GetAxisRaw("Mouse Y"));
        public static float Scroll => Input.mouseScrollDelta.y;
        public static bool MouseHeld(int button) => Input.GetMouseButton(button);
        public static bool MousePressed(int button) => Input.GetMouseButtonDown(button);
        public static bool MouseReleased(int button) => Input.GetMouseButtonUp(button);
#else
        public static bool KeyHeld(DKey k) => false;
        public static bool KeyPressed(DKey k) => false;
        public static Vector2 MouseDelta => Vector2.zero;
        public static float Scroll => 0f;
        public static bool MouseHeld(int button) => false;
        public static bool MousePressed(int button) => false;
        public static bool MouseReleased(int button) => false;
#endif
    }
}
